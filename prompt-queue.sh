#!/bin/bash
# prompt-queue.sh
# JSON-based prompt queue hook for Claude Code.
# Reads from ~/.promptline/queues/{project}/{session_id}.json,
# sends the next pending prompt via stderr, and exits 2 so Claude
# continues working. If no pending prompts remain, exits 0.

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
" 2>/dev/null) || PARSED=$'\n\n'

SESSION_ID=$(echo "$PARSED" | sed -n '1p')
CWD=$(echo "$PARSED" | sed -n '2p')
TRANSCRIPT_PATH=$(echo "$PARSED" | sed -n '3p')

# If no cwd, nothing to do
if [ -z "$CWD" ]; then
  exit 0
fi

# --- Derive project name and session file path ---
PROJECT=$(basename "$CWD")
QUEUE_DIR="$HOME/.promptline/queues/$PROJECT"
QUEUE_FILE="$QUEUE_DIR/$SESSION_ID.json"

export QUEUE_FILE SESSION_ID CWD PROJECT TRANSCRIPT_PATH

# No session file -> nothing to do (SessionStart hook handles registration)
if [ ! -f "$QUEUE_FILE" ]; then
  exit 0
fi

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

def extract_session_name(transcript_path, max_len=80):
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
                            return text[:max_len] if len(text) > max_len else text
                        elif isinstance(content, list):
                            for part in content:
                                if isinstance(part, dict) and part.get("type") == "text":
                                    text = part.get("text", "").strip().replace("\n", " ")
                                    if text:
                                        return text[:max_len] if len(text) > max_len else text
                except (json.JSONDecodeError, KeyError):
                    continue
    except (IOError, OSError):
        pass
    return None

queue_file = os.environ.get("QUEUE_FILE", "")
session_id = os.environ.get("SESSION_ID", "")
transcript_path = os.environ.get("TRANSCRIPT_PATH", "")

if not queue_file or not os.path.isfile(queue_file):
    print("0")
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
    print("0")
    sys.exit(0)

# We have a pending prompt -> mark it as running
next_prompt["status"] = "running"
data["currentPromptId"] = next_prompt["id"]
data["prompts"] = prompts

atomic_write(queue_file, data)

# Count remaining pending prompts (excluding the one we just took)
remaining = sum(1 for p in prompts if p.get("status") == "pending")

DELIM = "__PROMPTLINE_DELIM__"
print("2")
print(str(remaining))
print(DELIM)
print(next_prompt["text"])
PYEOF
)

# --- Parse python output ---
EXIT_CODE=$(echo "$RESULT" | head -n1)

if [ "$EXIT_CODE" = "2" ]; then
  REMAINING=$(echo "$RESULT" | sed -n '2p')
  PROMPT_TEXT=$(echo "$RESULT" | sed '1,/^__PROMPTLINE_DELIM__$/d')

  {
    echo "===== PromptLine: Executing next prompt (${REMAINING} remaining in queue) ====="
    echo ""
    echo "$PROMPT_TEXT"
  } >&2

  exit 2
fi

exit 0
