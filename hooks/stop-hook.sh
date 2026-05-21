#!/bin/bash
# Stop hook: drains the prompt queue.
# If a pending prompt exists, outputs {"decision":"block","reason":"..."}
# so Claude continues with the next queued prompt.
# If no pending prompts remain, exits 0 silently (Claude stops normally).

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

resolve_session_paths "$SESSION_ID" "$CWD"

# If another process is already draining this queue, skip this stop event.
LOCK_FILE="${QUEUE_FILE}.lock"
pl_lock "$LOCK_FILE" || exit 0
trap 'pl_unlock "$LOCK_FILE"' EXIT

# --- If session file doesn't exist, create empty and exit ---
if [ ! -f "$QUEUE_FILE" ]; then
  NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  SESSION_NAME_JSON=$(extract_session_name "$TRANSCRIPT_PATH")
  [ "$SESSION_NAME_JSON" = "null" ] && SESSION_NAME_JSON=$(extract_codex_session_name "$SESSION_ID")
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
[ "$SESSION_NAME_JSON" = "null" ] && SESSION_NAME_JSON=$(extract_codex_session_name "$SESSION_ID")

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

    # Find first pending prompt
    (.prompts | to_entries | map(select(.value.status == "pending")) | first // null) as $pending |

    if $pending == null then
      # No pending: nothing to drain
      { session: ., output: null }
    else
      # Mark pending as running
      .prompts[$pending.key].status = "running" |
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
