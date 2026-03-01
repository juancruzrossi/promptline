# Auto Session Detection & Queue Auto-Creation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** PromptLine auto-detects active Claude Code sessions and creates queues automatically — no manual setup needed.

**Architecture:** Add a SessionStart hook that auto-creates queue files when Claude Code opens. Modify the Stop hook to also auto-create if missing. The dashboard auto-populates from these files. Completed queues stay visible for 7 days with a "completed" label, then auto-clean.

**Tech Stack:** Bash + Python (hooks), TypeScript (Vite API), React (dashboard)

---

### Task 1: Add SessionStart hook for auto-registration

**Files:**
- Create: `session-register.sh` (new lightweight hook)
- Modify: `~/.claude/settings.json` (add SessionStart hook entry)

**Why:** The Stop hook only fires after Claude responds. A SessionStart hook fires when Claude Code opens, so sessions appear in the dashboard immediately.

**Step 1: Create session-register.sh**

```bash
#!/bin/bash
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

PROJECT=$(basename "$CWD")
QUEUE_DIR="$HOME/.promptline/queues"
QUEUE_FILE="$QUEUE_DIR/$PROJECT.json"

mkdir -p "$QUEUE_DIR"

export QUEUE_FILE SESSION_ID CWD PROJECT

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

queue_file = os.environ["QUEUE_FILE"]
session_id = os.environ["SESSION_ID"]
cwd = os.environ["CWD"]
project = os.environ["PROJECT"]
now = datetime.now(timezone.utc).isoformat()

# Load existing or create new
if os.path.isfile(queue_file):
    try:
        with open(queue_file, "r") as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError):
        data = None
else:
    data = None

if data is None:
    data = {
        "project": project,
        "directory": cwd,
        "prompts": [],
        "activeSession": None,
        "sessionHistory": [],
    }

# Register session
active = data.get("activeSession")
history = data.get("sessionHistory", [])

if active is None or active.get("sessionId") != session_id:
    if active and active.get("sessionId") != session_id:
        history.append({
            "sessionId": active["sessionId"],
            "startedAt": active.get("startedAt", now),
            "endedAt": now,
            "promptsExecuted": sum(1 for p in data.get("prompts", []) if p.get("status") == "completed"),
        })
    data["activeSession"] = {
        "sessionId": session_id,
        "status": "active",
        "startedAt": now,
        "lastActivity": now,
        "currentPromptId": None,
    }
    data["sessionHistory"] = history
    atomic_write(queue_file, data)
PYEOF

exit 0
```

**Step 2: Add SessionStart hook to settings.json**

Add to `~/.claude/settings.json` hooks section:
```json
"SessionStart": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "~/.claude/hooks/session-register.sh"
      }
    ]
  }
]
```

**Step 3: Copy hook and test**

```bash
cp session-register.sh ~/.claude/hooks/session-register.sh
chmod +x ~/.claude/hooks/session-register.sh
# Test: simulate SessionStart
echo '{"session_id":"test-sess","cwd":"/tmp/test-project","hook_event_name":"SessionStart"}' | bash session-register.sh
# Verify: ~/.promptline/queues/test-project.json exists with activeSession
```

**Step 4: Commit**

```bash
git add session-register.sh
git commit -m "feat: auto-register sessions on SessionStart"
```

---

### Task 2: Modify Stop hook to auto-create queue if missing

**Files:**
- Modify: `prompt-queue.sh:37-40`

**Why:** If the SessionStart hook didn't fire (e.g., session was already open), the Stop hook should still auto-create the queue.

**Step 1: Replace "exit 0" with auto-create logic**

Replace lines 37-40 in prompt-queue.sh:
```bash
# No queue file -> nothing to do
if [ ! -f "$QUEUE_FILE" ]; then
  exit 0
fi
```

With:
```bash
# No queue file -> create one automatically
if [ ! -f "$QUEUE_FILE" ]; then
  mkdir -p "$QUEUE_DIR"
  export CWD PROJECT
  python3 -c "
import json, os, tempfile
from datetime import datetime, timezone
queue_file = os.environ['QUEUE_FILE']
data = {
    'project': os.environ['PROJECT'],
    'directory': os.environ['CWD'],
    'prompts': [],
    'activeSession': {
        'sessionId': os.environ.get('SESSION_ID', ''),
        'status': 'active',
        'startedAt': datetime.now(timezone.utc).isoformat(),
        'lastActivity': datetime.now(timezone.utc).isoformat(),
        'currentPromptId': None,
    },
    'sessionHistory': [],
}
dir_name = os.path.dirname(queue_file)
fd, tmp = tempfile.mkstemp(dir=dir_name, suffix='.tmp')
with os.fdopen(fd, 'w') as f:
    json.dump(data, f, indent=2)
os.replace(tmp, queue_file)
"
  # Queue created but no prompts to process
  exit 0
fi
```

**Step 2: Test**

```bash
rm -f ~/.promptline/queues/test-auto.json
echo '{"session_id":"s1","cwd":"/tmp/test-auto"}' | bash prompt-queue.sh
# Verify: file created, exit 0, session registered
cat ~/.promptline/queues/test-auto.json
rm ~/.promptline/queues/test-auto.json
```

**Step 3: Copy hook and commit**

```bash
cp prompt-queue.sh ~/.claude/hooks/prompt-queue.sh
chmod +x ~/.claude/hooks/prompt-queue.sh
git add prompt-queue.sh
git commit -m "feat: auto-create queue when Stop hook fires on new project"
```

---

### Task 3: Add queue status field and 7-day retention in API

**Files:**
- Modify: `src/types/queue.ts` (add `queueStatus` and `completedAt` to ProjectQueue)
- Modify: `vite-plugin-api.ts` (compute queue status, filter stale completed queues)

**Why:** Queues where all prompts are completed should show "completed" label. After 7 days they auto-disappear from the listing.

**Step 1: Add queueStatus to types**

```typescript
export type QueueStatus = 'active' | 'completed' | 'empty';

export interface ProjectQueue {
  project: string;
  directory: string;
  prompts: Prompt[];
  activeSession: ActiveSession | null;
  sessionHistory: SessionHistoryEntry[];
  completedAt?: string | null;  // ISO timestamp when all prompts completed
}
```

**Step 2: Compute queue status in API**

Add to `withComputedSessionStatus` (rename to `withComputedStatus`):

```typescript
function withComputedStatus(queue: ProjectQueue): ProjectQueue & { queueStatus: QueueStatus } {
  // Session timeout
  let activeSession = queue.activeSession;
  if (activeSession) {
    const lastActivity = new Date(activeSession.lastActivity).getTime();
    const isStale = Date.now() - lastActivity > SESSION_TIMEOUT_MS;
    activeSession = { ...activeSession, status: isStale ? 'idle' : 'active' };
  }

  // Queue status
  const hasPrompts = queue.prompts.length > 0;
  const allCompleted = hasPrompts && queue.prompts.every(p => p.status === 'completed');
  const queueStatus: QueueStatus = allCompleted ? 'completed' : hasPrompts ? 'active' : 'empty';

  return { ...queue, activeSession, queueStatus };
}
```

**Step 3: Filter stale completed queues in listQueues**

```typescript
const QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function listQueues(): (ProjectQueue & { queueStatus: QueueStatus })[] {
  ensureQueuesDir();
  const now = Date.now();
  return readdirSync(QUEUES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return withComputedStatus(JSON.parse(readFileSync(join(QUEUES_DIR, f), 'utf-8')));
      } catch { return null; }
    })
    .filter((q): q is NonNullable<typeof q> => {
      if (!q) return false;
      // Hide completed queues older than 7 days
      if (q.queueStatus === 'completed' && q.completedAt) {
        return now - new Date(q.completedAt).getTime() < QUEUE_RETENTION_MS;
      }
      return true;
    });
}
```

**Step 4: Set completedAt in Stop hook**

In the Python block of prompt-queue.sh, after marking running→completed, check if all prompts are done:
```python
all_done = all(p.get("status") == "completed" for p in prompts) and len(prompts) > 0
if all_done and not data.get("completedAt"):
    data["completedAt"] = now
```

**Step 5: Commit**

```bash
git add src/types/queue.ts vite-plugin-api.ts prompt-queue.sh
git commit -m "feat: add queue completed status with 7-day retention"
```

---

### Task 4: Update Sidebar to show queue status badges

**Files:**
- Modify: `src/components/Sidebar.tsx`

**Why:** Show "completed" badge on queues where all prompts finished. Show "empty" for queues with no prompts.

**Step 1: Add queue status badge**

Replace the existing queued count badge with status-aware rendering:
- `completed` → green "completed" badge
- `empty` (no prompts) → no badge
- has pending → yellow "{n} queued" badge (existing)

**Step 2: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat: show completed/queued badges in sidebar"
```

---

### Task 5: Remove mandatory "New Queue" modal fields

**Files:**
- Modify: `src/components/CreateQueueModal.tsx` (optional, may keep for manual creation)

**Why:** The primary flow is now auto-detection. The "+ New Queue" button stays as secondary option for pre-creating queues, but is less prominent. No changes needed if user decides to keep it.

**Step 6: Copy hooks, end-to-end test, commit**

```bash
cp prompt-queue.sh ~/.claude/hooks/prompt-queue.sh
cp session-register.sh ~/.claude/hooks/session-register.sh
chmod +x ~/.claude/hooks/*.sh
```

Test:
1. `npm run dev` — dashboard should show existing queues
2. Open a new terminal, `cd` to a project dir, run `claude` — dashboard should auto-show the project
3. Add prompts from dashboard, send any prompt in Claude Code — prompts execute sequentially
4. When all prompts complete — queue shows "completed" badge
5. Delete queue from dashboard — verify cleanup
