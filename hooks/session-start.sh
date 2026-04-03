#!/bin/bash
# SessionStart hook: creates or reopens a per-session queue file.
# Stores at ~/.promptline/queues/{project}/{session_id}.json

set -euo pipefail

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

QUEUES_BASE="$HOME/.promptline/queues"
EXISTING=$(find "$QUEUES_BASE" -maxdepth 2 -name "${SESSION_ID}.json" -print -quit 2>/dev/null || true)

if [ -n "$EXISTING" ]; then
  QUEUE_FILE="$EXISTING"
  QUEUE_DIR="$(dirname "$EXISTING")"
  PROJECT=$(basename "$QUEUE_DIR")
else
  PROJECT=$(basename "$CWD")
  QUEUE_DIR="$QUEUES_BASE/$PROJECT"
  QUEUE_FILE="$QUEUE_DIR/$SESSION_ID.json"
  mkdir -p "$QUEUE_DIR"
fi

# Extract session name from transcript JSONL (first user message, max 50 chars)
extract_session_name() {
  local transcript="$1"
  [ -z "$transcript" ] || [ ! -f "$transcript" ] && echo "null" && return

  local text=""
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    local entry_type
    entry_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null) || continue
    [ "$entry_type" != "user" ] && continue

    # Try content as string first
    local content_str
    content_str=$(echo "$line" | jq -r 'if .message.content | type == "string" then .message.content else empty end' 2>/dev/null) || true
    if [ -n "$content_str" ]; then
      text=$(echo "$content_str" | tr '\n' ' ' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
      # Skip system-injected messages (XML tags like <system-reminder>, <local-command-caveat>, etc.)
      [[ -z "$text" || "$text" == "<"* ]] && text="" && continue
      break
    fi

    # Try content as array of {type, text} objects
    local content_text
    content_text=$(echo "$line" | jq -r 'if .message.content | type == "array" then (.message.content[] | select(.type == "text") | .text) else empty end' 2>/dev/null | head -1) || true
    if [ -n "$content_text" ]; then
      text=$(echo "$content_text" | tr '\n' ' ' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
      # Skip system-injected messages (XML tags like <system-reminder>, <local-command-caveat>, etc.)
      [[ -z "$text" || "$text" == "<"* ]] && text="" && continue
      break
    fi
  done < "$transcript"

  if [ -z "$text" ]; then
    echo "null"
    return
  fi

  if [ "${#text}" -gt 50 ]; then
    echo "\"${text:0:50}...\""
  else
    printf '%s' "$text" | jq -Rs '.'
  fi
}

# Extract session name from Codex SQLite DB (fallback when no transcript)
extract_codex_session_name() {
  local sid="$1"
  [ -z "$sid" ] && echo "null" && return

  # Validate UUID format to prevent injection
  [[ "$sid" =~ ^[0-9a-fA-F-]+$ ]] || { echo "null"; return; }

  command -v sqlite3 >/dev/null 2>&1 || { echo "null"; return; }

  # Find latest Codex state DB
  local db=""
  for f in "$HOME/.codex"/state_*.sqlite; do
    [ -f "$f" ] && db="$f"
  done
  [ -z "$db" ] && echo "null" && return

  local title
  title=$(sqlite3 "$db" "SELECT title FROM threads WHERE id='$sid' LIMIT 1;" 2>/dev/null) || true

  if [ -z "$title" ]; then
    echo "null"
    return
  fi

  local text
  text=$(echo "$title" | tr '\n' ' ' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')

  if [ -z "$text" ]; then
    echo "null"
  elif [ "${#text}" -gt 50 ]; then
    echo "\"${text:0:50}...\""
  else
    printf '%s' "$text" | jq -Rs '.'
  fi
}

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
