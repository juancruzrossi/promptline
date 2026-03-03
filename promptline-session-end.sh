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

export QUEUE_FILE SESSION_ID QUEUES_BASE

python3 << 'PYEOF'
import glob
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone

LEGACY_ORPHAN_TTL_SECONDS = 24 * 60 * 60

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

def parse_iso_datetime(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        if value.endswith("Z"):
            try:
                dt = datetime.fromisoformat(value[:-1] + "+00:00")
            except ValueError:
                return None
        else:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

def is_process_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True

def read_process_started_at(pid):
    try:
        output = subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "lstart="],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None
    return output or None

def has_live_owner_process(data):
    owner_pid = data.get("ownerPid")
    if type(owner_pid) is not int or owner_pid <= 0:
        return None
    if not is_process_alive(owner_pid):
        return False

    expected_started_at = data.get("ownerStartedAt")
    if not isinstance(expected_started_at, str) or not expected_started_at.strip():
        return True

    actual_started_at = read_process_started_at(owner_pid)
    if actual_started_at is None:
        return False
    return actual_started_at == expected_started_at.strip()

def is_legacy_session_stale(data, now_dt):
    activity_dt = parse_iso_datetime(data.get("lastActivity"))
    if activity_dt is None:
        activity_dt = parse_iso_datetime(data.get("startedAt"))
    if activity_dt is None:
        return False
    return (now_dt - activity_dt).total_seconds() >= LEGACY_ORPHAN_TTL_SECONDS

def should_close_as_orphan(data, now_dt):
    if data.get("closedAt") is not None:
        return False

    owner_status = has_live_owner_process(data)
    if owner_status is True:
        return False
    if owner_status is False:
        return True

    return is_legacy_session_stale(data, now_dt)

def close_session(path, now, data=None):
    if data is None:
        with open(path, "r") as f:
            data = json.load(f)
    for p in data.get("prompts", []):
        if p.get("status") in ("pending", "running"):
            p["status"] = "cancelled"
            p["completedAt"] = now
    data["closedAt"] = now
    data["lastActivity"] = now
    data["ownerPid"] = None
    data["ownerStartedAt"] = None
    atomic_write(path, data)

queue_file = os.environ["QUEUE_FILE"]
session_id = os.environ["SESSION_ID"]
now_dt = datetime.now(timezone.utc)
now = now_dt.isoformat()

try:
    close_session(queue_file, now)
except (json.JSONDecodeError, IOError, OSError):
    pass

queues_base = os.environ["QUEUES_BASE"]
for project_dir in glob.glob(os.path.join(queues_base, "*")):
    if not os.path.isdir(project_dir):
        continue
    for path in glob.glob(os.path.join(project_dir, "*.json")):
        if os.path.basename(path) == f"{session_id}.json":
            continue
        try:
            with open(path, "r") as f:
                data = json.load(f)
            if not should_close_as_orphan(data, now_dt):
                continue
            close_session(path, now, data)
        except (json.JSONDecodeError, IOError, OSError):
            continue

PYEOF

exit 0
