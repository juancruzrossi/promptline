#!/bin/bash
# Stop hook: drains the prompt queue.
# If a pending prompt exists, outputs {"decision":"block","reason":"..."}
# so Claude continues with the next queued prompt.
# If no pending prompts remain, exits 0 silently (Claude stops normally).

set -euo pipefail

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$CWD" ] || [ -z "$SESSION_ID" ]; then
  exit 0
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

    local content_str
    content_str=$(echo "$line" | jq -r 'if .message.content | type == "string" then .message.content else empty end' 2>/dev/null) || true
    if [ -n "$content_str" ]; then
      text=$(echo "$content_str" | tr '\n' ' ' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
      # Skip system-injected messages (XML tags like <system-reminder>, <local-command-caveat>, etc.)
      [[ -z "$text" || "$text" == "<"* ]] && text="" && continue
      break
    fi

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

# --- Lock acquisition (O_EXCL pattern, 3s timeout, 10s stale) ---
LOCK_FILE="${QUEUE_FILE}.lock"
LOCK_HELD=0
cleanup_lock() {
  if [ "$LOCK_HELD" -eq 1 ]; then
    rm -f "$LOCK_FILE"
  fi
}
trap cleanup_lock EXIT

acquire_lock() {
  local deadline=$((SECONDS + 3))
  while true; do
    if (set -C; echo $$ > "$LOCK_FILE") 2>/dev/null; then
      LOCK_HELD=1
      return 0
    fi
    # Check for stale lock (mtime > 10s ago)
    if [ -f "$LOCK_FILE" ]; then
      local lock_age
      local lock_mtime
      lock_mtime=$(stat -f %m "$LOCK_FILE" 2>/dev/null || stat -c %Y "$LOCK_FILE" 2>/dev/null || echo "0")
      lock_age=$(( $(date +%s) - lock_mtime ))
      if [ "$lock_age" -gt 10 ]; then
        rm -f "$LOCK_FILE"
        continue
      fi
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      return 1
    fi
    sleep 0.01
  done
}

# If another process is already draining this queue, skip this stop event.
acquire_lock || exit 0

# --- If session file doesn't exist, create empty and exit ---
if [ ! -f "$QUEUE_FILE" ]; then
  NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  SESSION_NAME_JSON=$(extract_session_name "$TRANSCRIPT_PATH")
  TMP_FILE="${QUEUE_FILE}.tmp.$$"
  jq -n \
    --arg sessionId "$SESSION_ID" \
    --arg project "$PROJECT" \
    --arg directory "$CWD" \
    --argjson sessionName "$SESSION_NAME_JSON" \
    --arg startedAt "$NOW" \
    --arg lastActivity "$NOW" \
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
      ownerPid: null,
      ownerStartedAt: null
    }' > "$TMP_FILE"
  mv -f "$TMP_FILE" "$QUEUE_FILE"
  exit 0
fi

# --- Read and process session ---
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
SESSION_NAME_JSON=$(extract_session_name "$TRANSCRIPT_PATH")

RESULT=$(jq \
  --arg now "$NOW" \
  --argjson sessionName "$SESSION_NAME_JSON" \
  '
    # Mark running prompts as completed
    .prompts = [.prompts[] | if .status == "running" then .status = "completed" | .completedAt = $now else . end] |

    # Update sessionName if null
    if (.sessionName == null or .sessionName == "") then .sessionName = $sessionName else . end |

    # Update lastActivity
    .lastActivity = $now |

    # Check if all prompts are done
    if ((.prompts | length) > 0 and (.prompts | all(.status == "completed" or .status == "cancelled")) and .completedAt == null) then .completedAt = $now else . end |

    # Find first pending prompt
    (.prompts | to_entries | map(select(.value.status == "pending")) | first // null) as $pending |

    if $pending == null then
      # No pending: clear currentPromptId, output empty
      .currentPromptId = null |
      { session: ., output: null }
    else
      # Mark pending as running
      .prompts[$pending.key].status = "running" |
      .currentPromptId = $pending.value.id |
      # Count remaining pending (excluding the one we just took)
      (.prompts | map(select(.status == "pending")) | length) as $remaining |
      {
        session: .,
        output: {
          remaining: $remaining,
          text: $pending.value.text
        }
      }
    end
  ' "$QUEUE_FILE") || { exit 0; }

# Extract session data and write atomically
TMP_FILE="${QUEUE_FILE}.tmp.$$"
echo "$RESULT" | jq '.session' > "$TMP_FILE"
mv -f "$TMP_FILE" "$QUEUE_FILE"

# Extract output info
OUTPUT_JSON=$(echo "$RESULT" | jq -r '.output // empty')

if [ -n "$OUTPUT_JSON" ] && [ "$OUTPUT_JSON" != "null" ]; then
  REMAINING=$(echo "$OUTPUT_JSON" | jq -r '.remaining')
  PROMPT_TEXT=$(echo "$OUTPUT_JSON" | jq -r '.text')
  jq -n --arg remaining "$REMAINING" --arg text "$PROMPT_TEXT" \
    '{ decision: "block", reason: ("PromptLine (\($remaining) queued)\n\n" + $text) }'
fi

exit 0
