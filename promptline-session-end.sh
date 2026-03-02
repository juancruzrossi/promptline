#!/bin/bash
# promptline-session-end.sh
# SessionEnd hook: marks a session as closed when Claude Code exits.
# Updates closedAt and lastActivity in ~/.promptline/queues/{project}/{session_id}.json

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

# Search for existing session across all projects
QUEUES_BASE="$HOME/.promptline/queues"
EXISTING=$(find "$QUEUES_BASE" -maxdepth 2 -name "$SESSION_ID.json" -print -quit 2>/dev/null || true)

if [ -n "$EXISTING" ]; then
  QUEUE_FILE="$EXISTING"
else
  # No session to close
  exit 0
fi

QUEUE_DIR="$(dirname "$QUEUE_FILE")"
export QUEUE_FILE QUEUE_DIR SESSION_ID

python3 << 'PYEOF'
import json, os, glob, tempfile
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

def close_session(path, now):
    with open(path, "r") as f:
        data = json.load(f)
    data["closedAt"] = now
    data["lastActivity"] = now
    atomic_write(path, data)

queue_file = os.environ["QUEUE_FILE"]
queue_dir = os.environ["QUEUE_DIR"]
session_id = os.environ["SESSION_ID"]
now = datetime.now(timezone.utc).isoformat()

try:
    close_session(queue_file, now)
except (json.JSONDecodeError, IOError, OSError):
    pass

# Close orphaned sessions in the same project
for path in glob.glob(os.path.join(queue_dir, "*.json")):
    if os.path.basename(path) == f"{session_id}.json":
        continue
    try:
        with open(path, "r") as f:
            data = json.load(f)
        if data.get("closedAt") is not None:
            continue
        has_pending = any(p.get("status") in ("pending", "running") for p in data.get("prompts", []))
        if has_pending:
            continue
        close_session(path, now)
    except (json.JSONDecodeError, IOError, OSError):
        continue

PYEOF

exit 0
