#!/bin/bash
# session-register.sh
# SessionStart hook: auto-creates queue file when Claude Code opens.
# Registers the session so it appears in the dashboard immediately.

set -euo pipefail

INPUT=$(cat)

PARSED=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('session_id', ''))
print(data.get('cwd', ''))
" 2>/dev/null) || PARSED=$'\n'

SESSION_ID=$(echo "$PARSED" | sed -n '1p')
CWD=$(echo "$PARSED" | sed -n '2p')

if [ -z "$CWD" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi

PROJECT=$(basename "$CWD")
QUEUE_DIR="$HOME/.promptline/queues"
QUEUE_FILE="$QUEUE_DIR/$PROJECT.json"

mkdir -p "$QUEUE_DIR"

export QUEUE_FILE SESSION_ID CWD PROJECT

python3 << 'PYEOF'
import json, os, tempfile
from datetime import datetime, timezone

def atomic_write(path, obj):
    dir_name = os.path.dirname(path)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        try: os.unlink(tmp_path)
        except OSError: pass
        raise

queue_file = os.environ["QUEUE_FILE"]
session_id = os.environ["SESSION_ID"]
cwd = os.environ["CWD"]
project = os.environ["PROJECT"]
now = datetime.now(timezone.utc).isoformat()

# Load existing or create new
if os.path.isfile(queue_file):
    try:
        with open(queue_file, "r") as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError):
        data = None
else:
    data = None

if data is None:
    data = {
        "project": project,
        "directory": cwd,
        "prompts": [],
        "activeSession": None,
        "sessionHistory": [],
    }

# Register session
active = data.get("activeSession")
history = data.get("sessionHistory", [])

if active is None or active.get("sessionId") != session_id:
    if active and active.get("sessionId") != session_id:
        history.append({
            "sessionId": active["sessionId"],
            "startedAt": active.get("startedAt", now),
            "endedAt": now,
            "promptsExecuted": sum(1 for p in data.get("prompts", []) if p.get("status") == "completed"),
        })
    data["activeSession"] = {
        "sessionId": session_id,
        "status": "active",
        "startedAt": now,
        "lastActivity": now,
        "currentPromptId": None,
    }
    data["sessionHistory"] = history
    atomic_write(queue_file, data)
PYEOF

exit 0
