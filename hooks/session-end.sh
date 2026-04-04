#!/bin/bash
# SessionEnd hook: marks a session as closed when Claude Code exits.
# Updates closedAt, lastActivity, clears ownerPid/ownerStartedAt,
# cancels pending/running prompts, and sweeps orphaned sessions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$CWD" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi

QUEUES_BASE="$HOME/.promptline/queues"
EXISTING=$(find "$QUEUES_BASE" -maxdepth 2 -name "${SESSION_ID}.json" -print -quit 2>/dev/null || true)

if [ -z "$EXISTING" ]; then
  exit 0
fi

QUEUE_FILE="$EXISTING"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
LEGACY_TTL=86400

# Convert ISO8601 timestamp to epoch seconds (macOS + Linux compatible)
iso_to_epoch() {
  local ts="$1"
  # Strip trailing Z and attempt macOS date first
  local ts_clean="${ts%Z}"
  if date -j -f "%Y-%m-%dT%H:%M:%S" "$ts_clean" +%s 2>/dev/null; then
    return
  fi
  # Linux fallback
  date -d "$ts" +%s 2>/dev/null || echo "0"
}

is_process_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

close_session() {
  local path="$1"
  local tmp_path="${path}.tmp.$$"
  jq \
    --arg now "$NOW" \
    '
      .closedAt = $now |
      .lastActivity = $now |
      .ownerPid = null |
      .ownerStartedAt = null |
      .prompts = [
        .prompts[] |
        if .status == "pending" or .status == "running" then
          .status = "cancelled" | .completedAt = $now
        else
          .
        end
      ]
    ' "$path" > "$tmp_path"
  mv -f "$tmp_path" "$path"
}

# --- Close the current session ---
close_session "$QUEUE_FILE"

# --- Orphan sweep across all projects ---
NOW_EPOCH=$(date -u +%s)

for project_dir in "$QUEUES_BASE"/*/; do
  [ -d "$project_dir" ] || continue
  for path in "$project_dir"*.json; do
    # Skip non-files, lock files, tmp files
    [ -f "$path" ] || continue
    case "$path" in
      *.lock|*.tmp.*) continue ;;
    esac
    # Skip the session we just closed
    [ "$(basename "$path")" = "${SESSION_ID}.json" ] && continue

    # Read relevant fields
    CLOSED_AT=$(jq -r '.closedAt // empty' "$path" 2>/dev/null) || continue
    [ -n "$CLOSED_AT" ] && continue

    OWNER_PID=$(jq -r '.ownerPid // empty' "$path" 2>/dev/null) || continue

    if [ -n "$OWNER_PID" ] && [ "$OWNER_PID" != "null" ]; then
      # Has ownerPid: check if process is alive
      if ! is_process_alive "$OWNER_PID"; then
        close_session "$path"
        continue
      fi
      # Process alive: verify start time matches
      EXPECTED_STARTED_AT=$(jq -r '.ownerStartedAt // empty' "$path" 2>/dev/null) || true
      if [ -n "$EXPECTED_STARTED_AT" ] && [ "$EXPECTED_STARTED_AT" != "null" ]; then
        ACTUAL_STARTED_AT=$(ps -p "$OWNER_PID" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//' || true)
        if [ -z "$ACTUAL_STARTED_AT" ] || [ "$ACTUAL_STARTED_AT" != "$EXPECTED_STARTED_AT" ]; then
          close_session "$path"
          continue
        fi
      fi
    else
      # Legacy: no ownerPid, check lastActivity age
      LAST_ACTIVITY=$(jq -r '.lastActivity // .startedAt // empty' "$path" 2>/dev/null) || continue
      [ -z "$LAST_ACTIVITY" ] && continue
      ACTIVITY_EPOCH=$(iso_to_epoch "$LAST_ACTIVITY")
      AGE=$(( NOW_EPOCH - ACTIVITY_EPOCH ))
      if [ "$AGE" -ge "$LEGACY_TTL" ]; then
        close_session "$path"
      fi
    fi
  done
done

exit 0
