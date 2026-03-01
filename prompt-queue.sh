#!/bin/bash
# prompt-queue.sh
# JSON-based prompt queue hook for Claude Code.
# Reads from ~/.promptline/queues/{project}.json, sends the next pending
# prompt via stderr, and exits 2 so Claude continues working.
# If no pending prompts remain, exits 0 and Claude stops normally.

set -euo pipefail

# --- Read Claude Code hook input from stdin ---
INPUT=$(cat)

# --- Extract session_id and cwd from input JSON ---
# Use newline as separator to handle paths with spaces
PARSED=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('session_id', ''))
print(data.get('cwd', ''))
" 2>/dev/null) || PARSED=$'\n'

SESSION_ID=$(echo "$PARSED" | sed -n '1p')
CWD=$(echo "$PARSED" | sed -n '2p')

# If no cwd, nothing to do
if [ -z "$CWD" ]; then
  exit 0
fi

# --- Derive project name from cwd ---
PROJECT=$(basename "$CWD")

# --- Locate queue file ---
QUEUE_DIR="$HOME/.promptline/queues"
QUEUE_FILE="$QUEUE_DIR/$PROJECT.json"

export QUEUE_FILE SESSION_ID CWD PROJECT

# No queue file -> nothing to do (SessionStart hook handles registration)
if [ ! -f "$QUEUE_FILE" ]; then
  exit 0
fi

# --- Process queue with python3 ---
# Python handles all JSON manipulation atomically and outputs:
#   Line 1: EXIT_CODE (0 or 2)
#   Line 2: PROMPT_TEXT (only when EXIT_CODE=2)
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

queue_file = os.environ.get("QUEUE_FILE", "")
session_id = os.environ.get("SESSION_ID", "")

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

# Step 2: Find the first "pending" prompt
next_prompt = None
for p in prompts:
    if p.get("status") == "pending":
        next_prompt = p
        break

# Step 3: Always update session tracking (even with no pending prompts)
active = data.get("activeSession")
history = data.get("sessionHistory", [])

def update_session(active, history, session_id, now, current_prompt_id):
    """Update or create session, archive old sessions if needed."""
    if active is None:
        return {
            "sessionId": session_id,
            "status": "active",
            "startedAt": now,
            "lastActivity": now,
            "currentPromptId": current_prompt_id,
        }
    if active.get("sessionId") != session_id and session_id:
        completed_count = sum(1 for p in prompts if p.get("status") == "completed")
        history.append({
            "sessionId": active["sessionId"],
            "startedAt": active.get("startedAt", now),
            "endedAt": now,
            "promptsExecuted": completed_count,
        })
        return {
            "sessionId": session_id,
            "status": "active",
            "startedAt": now,
            "lastActivity": now,
            "currentPromptId": current_prompt_id,
        }
    active["status"] = "active"
    active["lastActivity"] = now
    active["currentPromptId"] = current_prompt_id
    return active

if next_prompt is None:
    # No pending prompts -> register session but exit 0
    active = update_session(active, history, session_id, now, None)
    data["prompts"] = prompts
    data["activeSession"] = active
    data["sessionHistory"] = history
    atomic_write(queue_file, data)
    print("0")
    sys.exit(0)

# We have a pending prompt -> mark it as running
next_prompt["status"] = "running"
active = update_session(active, history, session_id, now, next_prompt["id"])

data["prompts"] = prompts
data["activeSession"] = active
data["sessionHistory"] = history

atomic_write(queue_file, data)

# Count remaining pending prompts (excluding the one we just took)
remaining = sum(1 for p in prompts if p.get("status") == "pending")

# Output format: EXIT_CODE\nREMAINING\n__PROMPT_DELIMITER__\nprompt text (may be multi-line)
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
