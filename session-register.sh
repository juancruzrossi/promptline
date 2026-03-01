#!/bin/bash
# session-register.sh
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

PROJECT=$(basename "$CWD")
QUEUE_DIR="$HOME/.promptline/queues/$PROJECT"
QUEUE_FILE="$QUEUE_DIR/$SESSION_ID.json"

mkdir -p "$QUEUE_DIR"

export QUEUE_FILE SESSION_ID CWD PROJECT TRANSCRIPT_PATH

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

queue_file = os.environ["QUEUE_FILE"]
session_id = os.environ["SESSION_ID"]
cwd = os.environ["CWD"]
project = os.environ["PROJECT"]
transcript_path = os.environ.get("TRANSCRIPT_PATH", "")
now = datetime.now(timezone.utc).isoformat()

if os.path.isfile(queue_file):
    try:
        with open(queue_file, "r") as f:
            data = json.load(f)
        data["lastActivity"] = now
        if not data.get("sessionName"):
            data["sessionName"] = extract_session_name(transcript_path)
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
    }
    atomic_write(queue_file, data)

PYEOF

exit 0
