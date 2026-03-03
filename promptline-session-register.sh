#!/bin/bash
# promptline-session-register.sh
# SessionStart hook: auto-creates per-session queue file when Claude Code opens.
# Stores at ~/.promptline/queues/{project}/{session_id}.json
# Extracts session name from the transcript's first user message.

set -euo pipefail

INPUT=$(cat)

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

if [ -z "$CWD" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi

OWNER_PID="${PPID:-}"
OWNER_STARTED_AT=""
if [ -n "$OWNER_PID" ]; then
  OWNER_STARTED_AT=$(ps -p "$OWNER_PID" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//' || true)
fi

# Search for existing session across all projects
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

export QUEUE_FILE SESSION_ID CWD PROJECT TRANSCRIPT_PATH OWNER_PID OWNER_STARTED_AT

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

queue_file = os.environ["QUEUE_FILE"]
session_id = os.environ["SESSION_ID"]
cwd = os.environ["CWD"]
project = os.environ["PROJECT"]
transcript_path = os.environ.get("TRANSCRIPT_PATH", "")
owner_pid_raw = os.environ.get("OWNER_PID", "").strip()
owner_started_at = os.environ.get("OWNER_STARTED_AT", "").strip() or None
now = datetime.now(timezone.utc).isoformat()

try:
    owner_pid = int(owner_pid_raw) if owner_pid_raw else None
except ValueError:
    owner_pid = None

if os.path.isfile(queue_file):
    try:
        with open(queue_file, "r") as f:
            data = json.load(f)
        data["lastActivity"] = now
        if not data.get("sessionName"):
            data["sessionName"] = extract_session_name(transcript_path)
        if owner_pid is not None and owner_pid > 0:
            data["ownerPid"] = owner_pid
        elif "ownerPid" not in data:
            data["ownerPid"] = None
        if owner_started_at is not None:
            data["ownerStartedAt"] = owner_started_at
        elif "ownerStartedAt" not in data:
            data["ownerStartedAt"] = None
        atomic_write(queue_file, data)
    except (json.JSONDecodeError, IOError):
        pass
else:
    session_name = extract_session_name(transcript_path)
    data = {
        "sessionId": session_id,
        "project": project,
        "directory": cwd,
        "sessionName": session_name,
        "prompts": [],
        "startedAt": now,
        "lastActivity": now,
        "currentPromptId": None,
        "completedAt": None,
        "closedAt": None,
        "ownerPid": owner_pid if owner_pid is not None and owner_pid > 0 else None,
        "ownerStartedAt": owner_started_at,
    }
    atomic_write(queue_file, data)

PYEOF

exit 0
