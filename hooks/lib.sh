#!/bin/bash
# Shared functions for PromptLine hooks.
# Sourced by session-start.sh, stop-hook.sh, and session-end.sh.

# Acquire an O_EXCL lock (args: lock_file [timeout_s=3]); steals stale locks, returns 1 on timeout.
pl_lock() {
  local lock_file="$1"
  local deadline=$((SECONDS + ${2:-3}))
  while true; do
    if (set -C; echo $$ > "$lock_file") 2>/dev/null; then
      return 0
    fi
    local mtime
    mtime=$(stat -c %Y "$lock_file" 2>/dev/null || stat -f %m "$lock_file" 2>/dev/null || echo 0)
    case "$mtime" in ''|*[!0-9]*) mtime=0 ;; esac
    if [ "$mtime" -gt 0 ] && [ "$(( $(date +%s) - mtime ))" -gt 10 ]; then
      rm -f "$lock_file"
      continue
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      return 1
    fi
    sleep 0.01
  done
}

pl_unlock() {
  rm -f "$1" 2>/dev/null || true
}

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

  local text
  text=$(jq -rn '
    first(
      inputs
      | select(.type == "user")
      | .message.content
      | if type == "string" then .
        elif type == "array" then (first(.[] | select(.type == "text") | .text) // empty)
        else empty end
      | gsub("\\s+"; " ") | gsub("^ +| +$"; "")
      | select(length > 0 and (startswith("<") | not))
    ) // empty
  ' "$transcript" 2>/dev/null) || text=""

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
