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

PROJECT=$(basename "$CWD")
QUEUE_FILE="$HOME/.promptline/queues/$PROJECT/$SESSION_ID.json"
export QUEUE_FILE

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
now = datetime.now(timezone.utc).isoformat()

try:
    with open(queue_file, "r") as f:
        data = json.load(f)
    data["closedAt"] = now
    data["lastActivity"] = now
    atomic_write(queue_file, data)
except (json.JSONDecodeError, IOError, OSError):
    pass

PYEOF

exit 0
