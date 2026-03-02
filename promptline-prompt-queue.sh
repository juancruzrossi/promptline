#!/bin/bash
# promptline-prompt-queue.sh — Stop hook for Claude Code.
# Reads from ~/.promptline/queues/{project}/{session_id}.json.
# If a pending prompt exists, outputs {"decision":"block","reason":"..."}
# so Claude continues with the next queued prompt.
# If no pending prompts remain, exits 0 (Claude stops normally).

set -euo pipefail

# --- Read Claude Code hook input from stdin ---
INPUT=$(cat)

# --- Extract session_id, cwd, and transcript_path from input JSON ---
PARSED=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('session_id', ''))
print(data.get('cwd', ''))
print(data.get('transcript_path', ''))
print(data.get('stop_hook_active', False))
" 2>/dev/null) || PARSED=$'\n\n\n'

SESSION_ID=$(echo "$PARSED" | sed -n '1p')
CWD=$(echo "$PARSED" | sed -n '2p')
TRANSCRIPT_PATH=$(echo "$PARSED" | sed -n '3p')
STOP_HOOK_ACTIVE=$(echo "$PARSED" | sed -n '4p')

# If no cwd, nothing to do
if [ -z "$CWD" ]; then
  exit 0
fi

# --- Search for existing session across all projects ---
QUEUES_BASE="$HOME/.promptline/queues"
EXISTING=$(find "$QUEUES_BASE" -maxdepth 2 -name "$SESSION_ID.json" -print -quit 2>/dev/null || true)

if [ -n "$EXISTING" ]; then
  QUEUE_FILE="$EXISTING"
  PROJECT=$(basename "$(dirname "$EXISTING")")
  QUEUE_DIR="$(dirname "$EXISTING")"
else
  PROJECT=$(basename "$CWD")
  QUEUE_DIR="$QUEUES_BASE/$PROJECT"
  QUEUE_FILE="$QUEUE_DIR/$SESSION_ID.json"
  mkdir -p "$QUEUE_DIR"
fi

export QUEUE_FILE SESSION_ID CWD PROJECT TRANSCRIPT_PATH STOP_HOOK_ACTIVE

# --- Process queue with python3 ---
RESULT=$(python3 << 'PYEOF'
import json
import sys
import os
import tempfile
from datetime import datetime, timezone

def atomic_write(path, obj):
    """Write JSON atomically: temp file + rename to prevent corruption."""
    dir_name = os.path.dirname(path)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

def extract_session_name(transcript_path, max_len=50):
    """Extract first user message from transcript JSONL as session name."""
    if not transcript_path or not os.path.isfile(transcript_path):
        return None
    try:
        with open(transcript_path, "r") as f:
            for line in f:
                try:
                    entry = json.loads(line.strip())
                    if entry.get("type") == "user":
                        msg = entry.get("message", {})
                        content = msg.get("content", "")
                        if isinstance(content, str) and content.strip():
                            text = content.strip().replace("\n", " ")
                            return text[:max_len] + "..." if len(text) > max_len else text
                        elif isinstance(content, list):
                            for part in content:
                                if isinstance(part, dict) and part.get("type") == "text":
                                    text = part.get("text", "").strip().replace("\n", " ")
                                    if text:
                                        return text[:max_len] + "..." if len(text) > max_len else text
                except (json.JSONDecodeError, KeyError):
                    continue
    except (IOError, OSError):
        pass
    return None

queue_file = os.environ.get("QUEUE_FILE", "")
session_id = os.environ.get("SESSION_ID", "")
transcript_path = os.environ.get("TRANSCRIPT_PATH", "")

if not queue_file:
    print("STOP")
    sys.exit(0)

if not os.path.isfile(queue_file):
    cwd = os.environ.get("CWD", "")
    project = os.environ.get("PROJECT", "")
    now = datetime.now(timezone.utc).isoformat()
    data = {
        "sessionId": session_id,
        "project": project,
        "directory": cwd,
        "sessionName": extract_session_name(transcript_path),
        "prompts": [],
        "startedAt": now,
        "lastActivity": now,
        "currentPromptId": None,
        "completedAt": None,
        "closedAt": None,
    }
    atomic_write(queue_file, data)
    print("STOP")
    sys.exit(0)

try:
    with open(queue_file, "r") as f:
        data = json.load(f)
except (json.JSONDecodeError, IOError):
    print("0")
    sys.exit(0)

prompts = data.get("prompts", [])
now = datetime.now(timezone.utc).isoformat()

# Step 1: Mark any currently "running" prompts as "completed"
for p in prompts:
    if p.get("status") == "running":
        p["status"] = "completed"
        p["completedAt"] = now

# Step 1b: Track completedAt when all prompts are done
all_done = all(p.get("status") == "completed" for p in prompts) and len(prompts) > 0
if all_done and not data.get("completedAt"):
    data["completedAt"] = now

# Step 1c: Update sessionName if still null
if not data.get("sessionName"):
    data["sessionName"] = extract_session_name(transcript_path)

# Step 2: Find the first "pending" prompt
next_prompt = None
for p in prompts:
    if p.get("status") == "pending":
        next_prompt = p
        break

# Step 3: Update session tracking
data["lastActivity"] = now

if next_prompt is None:
    data["prompts"] = prompts
    data["currentPromptId"] = None
    atomic_write(queue_file, data)
    print("STOP")
    sys.exit(0)

# We have a pending prompt -> mark it as running
next_prompt["status"] = "running"
data["currentPromptId"] = next_prompt["id"]
data["prompts"] = prompts

atomic_write(queue_file, data)

# Count remaining pending prompts (excluding the one we just took)
remaining = sum(1 for p in prompts if p.get("status") == "pending")

reason = f"PromptLine ({remaining} queued)\n\n{next_prompt['text']}"
decision = {"decision": "block", "reason": reason}
print("CONTINUE")
print(json.dumps(decision))
PYEOF
)

# --- Handle python output ---
ACTION=$(echo "$RESULT" | head -n1)

if [ "$ACTION" = "CONTINUE" ]; then
  # Output JSON decision on stdout so Claude Code continues with next prompt.
  # Safe from infinite loops: the queue drains (pending -> running -> completed)
  # and the hook exits 0 without blocking when no prompts remain.
  echo "$RESULT" | sed '1d'
  exit 0
fi

exit 0
