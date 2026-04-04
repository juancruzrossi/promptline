#!/bin/bash
# SessionStart hook: creates or reopens a per-session queue file.
# Stores at ~/.promptline/queues/{project}/{session_id}.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$CWD" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi

OWNER_PID="${PPID:-}"
OWNER_STARTED_AT=""
if [ -n "$OWNER_PID" ]; then
  OWNER_STARTED_AT=$(ps -p "$OWNER_PID" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//' || true)
fi

resolve_session_paths "$SESSION_ID" "$CWD"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# Build owner_pid JSON value
if [ -n "$OWNER_PID" ] && [ "$OWNER_PID" -gt 0 ] 2>/dev/null; then
  OWNER_PID_JSON="$OWNER_PID"
else
  OWNER_PID_JSON="null"
fi

# Build owner_started_at JSON value
if [ -n "$OWNER_STARTED_AT" ]; then
  OWNER_STARTED_AT_JSON=$(printf '%s' "$OWNER_STARTED_AT" | jq -Rs '.')
else
  OWNER_STARTED_AT_JSON="null"
fi

TMP_FILE="${QUEUE_FILE}.tmp.$$"

if [ -f "$QUEUE_FILE" ]; then
  SESSION_NAME_JSON=$(extract_session_name "$TRANSCRIPT_PATH")
  [ "$SESSION_NAME_JSON" = "null" ] && SESSION_NAME_JSON=$(extract_codex_session_name "$SESSION_ID")

  UPDATED=$(jq \
    --arg now "$NOW" \
    --argjson ownerPid "$OWNER_PID_JSON" \
    --argjson ownerStartedAt "$OWNER_STARTED_AT_JSON" \
    --argjson sessionName "$SESSION_NAME_JSON" \
    '
      .lastActivity = $now |
      .closedAt = null |
      if (.sessionName == null or .sessionName == "") then .sessionName = $sessionName else . end |
      if ($ownerPid != null) then .ownerPid = $ownerPid else if .ownerPid == null then .ownerPid = null else . end end |
      if ($ownerStartedAt != null) then .ownerStartedAt = $ownerStartedAt else if .ownerStartedAt == null then .ownerStartedAt = null else . end end
    ' "$QUEUE_FILE") || { exit 0; }

  printf '%s\n' "$UPDATED" > "$TMP_FILE"
  mv -f "$TMP_FILE" "$QUEUE_FILE"
else
  SESSION_NAME_JSON=$(extract_session_name "$TRANSCRIPT_PATH")
  [ "$SESSION_NAME_JSON" = "null" ] && SESSION_NAME_JSON=$(extract_codex_session_name "$SESSION_ID")

  jq -n \
    --arg sessionId "$SESSION_ID" \
    --arg project "$PROJECT" \
    --arg directory "$CWD" \
    --argjson sessionName "$SESSION_NAME_JSON" \
    --arg startedAt "$NOW" \
    --arg lastActivity "$NOW" \
    --argjson ownerPid "$OWNER_PID_JSON" \
    --argjson ownerStartedAt "$OWNER_STARTED_AT_JSON" \
    '{
      sessionId: $sessionId,
      project: $project,
      directory: $directory,
      sessionName: $sessionName,
      prompts: [],
      startedAt: $startedAt,
      lastActivity: $lastActivity,
      currentPromptId: null,
      completedAt: null,
      closedAt: null,
      ownerPid: $ownerPid,
      ownerStartedAt: $ownerStartedAt
    }' > "$TMP_FILE"

  mv -f "$TMP_FILE" "$QUEUE_FILE"
fi

exit 0
