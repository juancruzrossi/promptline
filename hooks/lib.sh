#!/bin/bash
# Shared functions for PromptLine hooks.
# Sourced by session-start.sh, stop-hook.sh, and session-end.sh.

# Locate an existing session file or set up paths for a new one.
# Sets: QUEUE_FILE, QUEUE_DIR, PROJECT
resolve_session_paths() {
  local session_id="$1"
  local cwd="$2"

  QUEUES_BASE="$HOME/.promptline/queues"
  local existing
  existing=$(find "$QUEUES_BASE" -maxdepth 2 -name "${session_id}.json" -print -quit 2>/dev/null || true)

  if [ -n "$existing" ]; then
    QUEUE_FILE="$existing"
    QUEUE_DIR="$(dirname "$existing")"
    PROJECT=$(basename "$QUEUE_DIR")
  else
    PROJECT=$(basename "$cwd")
    QUEUE_DIR="$QUEUES_BASE/$PROJECT"
    QUEUE_FILE="$QUEUE_DIR/$session_id.json"
    mkdir -p "$QUEUE_DIR"
  fi
}

# Truncate text to max 50 chars and return a valid JSON string (or "null").
# Always uses jq for safe JSON encoding.
json_truncate() {
  local text="$1"
  local max="${2:-50}"

  if [ -z "$text" ]; then
    echo "null"
    return
  fi

  if [ "${#text}" -gt "$max" ]; then
    printf '%s' "${text:0:$max}..." | jq -Rs '.'
  else
    printf '%s' "$text" | jq -Rs '.'
  fi
}

# Extract session name from transcript JSONL (first user message, max 50 chars).
extract_session_name() {
  local transcript="$1"
  [ -z "$transcript" ] || [ ! -f "$transcript" ] && echo "null" && return

  local text=""
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    local entry_type
    entry_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null) || continue
    [ "$entry_type" != "user" ] && continue

    local content_str
    content_str=$(echo "$line" | jq -r 'if .message.content | type == "string" then .message.content else empty end' 2>/dev/null) || true
    if [ -n "$content_str" ]; then
      text=$(echo "$content_str" | tr '\n' ' ' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
      [[ -z "$text" || "$text" == "<"* ]] && text="" && continue
      break
    fi

    local content_text
    content_text=$(echo "$line" | jq -r 'if .message.content | type == "array" then (.message.content[] | select(.type == "text") | .text) else empty end' 2>/dev/null | head -1) || true
    if [ -n "$content_text" ]; then
      text=$(echo "$content_text" | tr '\n' ' ' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
      [[ -z "$text" || "$text" == "<"* ]] && text="" && continue
      break
    fi
  done < "$transcript"

  json_truncate "$text"
}

# Extract session name from Codex SQLite DB (fallback when no transcript).
extract_codex_session_name() {
  local sid="$1"
  [ -z "$sid" ] && echo "null" && return

  [[ "$sid" =~ ^[0-9a-fA-F-]+$ ]] || { echo "null"; return; }

  command -v sqlite3 >/dev/null 2>&1 || { echo "null"; return; }

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

  json_truncate "$text"
}
