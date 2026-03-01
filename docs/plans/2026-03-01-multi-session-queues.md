# Multi-Session Queues: Per-Session Prompt Queues

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Each Claude Code session gets its own independent prompt queue. The dashboard groups sessions by project and shows them as stacked sections. Sessions are identified by the first user prompt (like `/resume` does).

**Architecture:** One JSON file per session under `~/.promptline/queues/{project}/{session_id}.json`. Hooks read `transcript_path` from input to extract session name. API aggregates sessions into project views. Dashboard shows sections per active session with history for idle/completed ones.

**Tech Stack:** Bash + Python (hooks), TypeScript (Vite API), React (dashboard)

---

### Task 1: Clean up old data and update types

**Files:**
- Modify: `src/types/queue.ts`
- Run: delete old `~/.promptline/queues/*.json` files

**Step 1: Delete old queue files**

```bash
rm -f ~/.promptline/queues/*.json
```

**Step 2: Replace types in `src/types/queue.ts`**

Replace the entire file with:

```typescript
export type PromptStatus = 'pending' | 'running' | 'completed';
export type SessionStatus = 'active' | 'idle';
export type QueueStatus = 'active' | 'completed' | 'empty';

export interface Prompt {
  id: string;
  text: string;
  status: PromptStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface SessionQueue {
  sessionId: string;
  project: string;
  directory: string;
  sessionName: string | null;
  prompts: Prompt[];
  startedAt: string;
  lastActivity: string;
  currentPromptId: string | null;
  completedAt: string | null;
}

export interface ProjectView {
  project: string;
  directory: string;
  sessions: (SessionQueue & { status: SessionStatus })[];
  queueStatus: QueueStatus;
}
```

Remove the old `ActiveSession`, `SessionHistoryEntry`, and `ProjectQueue` interfaces.

**Step 3: Commit**

```bash
git add src/types/queue.ts
git commit -m "refactor: replace ProjectQueue with SessionQueue and ProjectView types"
```

---

### Task 2: Rewrite API layer (vite-plugin-api.ts)

**Files:**
- Rewrite: `vite-plugin-api.ts`

**Step 1: Update directory structure helpers**

```typescript
const QUEUES_DIR = join(homedir(), '.promptline', 'queues');

function ensureProjectDir(project: string): void {
  mkdirSync(join(QUEUES_DIR, project), { recursive: true });
}

function sessionPath(project: string, sessionId: string): string {
  return join(QUEUES_DIR, project, `${sessionId}.json`);
}

function readSession(project: string, sessionId: string): SessionQueue | null {
  try {
    return JSON.parse(readFileSync(sessionPath(project, sessionId), 'utf-8'));
  } catch { return null; }
}

function writeSession(project: string, session: SessionQueue): void {
  ensureProjectDir(project);
  const filePath = sessionPath(project, session.sessionId);
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(session, null, 2));
  renameSync(tmpPath, filePath);
}
```

**Step 2: Update status computation**

```typescript
const SESSION_TIMEOUT_MS = 60 * 1000;
const QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function withComputedStatus(session: SessionQueue): SessionQueue & { status: SessionStatus } {
  const hasRunningPrompt = session.prompts.some(p => p.status === 'running');
  const lastActivity = new Date(session.lastActivity).getTime();
  const isStale = Date.now() - lastActivity > SESSION_TIMEOUT_MS;
  const status: SessionStatus = (hasRunningPrompt || !isStale) ? 'active' : 'idle';
  return { ...session, status };
}
```

**Step 3: Implement listProjects**

```typescript
function listProjects(): ProjectView[] {
  mkdirSync(QUEUES_DIR, { recursive: true });
  const now = Date.now();

  return readdirSync(QUEUES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(dir => {
      const project = dir.name;
      const dirPath = join(QUEUES_DIR, project);
      const sessions = readdirSync(dirPath)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            const raw = JSON.parse(readFileSync(join(dirPath, f), 'utf-8')) as SessionQueue;
            return withComputedStatus(raw);
          } catch { return null; }
        })
        .filter((s): s is NonNullable<typeof s> => {
          if (!s) return false;
          // Hide completed sessions older than 7 days
          if (s.completedAt) {
            return now - new Date(s.completedAt).getTime() < QUEUE_RETENTION_MS;
          }
          return true;
        });

      if (sessions.length === 0) return null;

      const hasPrompts = sessions.some(s => s.prompts.length > 0);
      const allCompleted = hasPrompts && sessions.every(s =>
        s.prompts.length > 0 && s.prompts.every(p => p.status === 'completed')
      );
      const queueStatus: QueueStatus = allCompleted ? 'completed' : hasPrompts ? 'active' : 'empty';

      // Hide empty projects with no active sessions
      if (queueStatus === 'empty' && !sessions.some(s => s.status === 'active')) return null;

      return { project, directory: sessions[0].directory, sessions, queueStatus };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
}
```

**Step 4: Update route handling**

New routes:

```
GET    /api/projects                                          → listProjects()
GET    /api/projects/:project                                 → getProject(project)
GET    /api/projects/:project/sessions/:sessionId             → getSession(project, sessionId)
POST   /api/projects/:project/sessions/:sessionId/prompts     → addPrompt(project, sessionId, body)
PATCH  /api/projects/:project/sessions/:sessionId/prompts/:id → updatePrompt(...)
DELETE /api/projects/:project/sessions/:sessionId/prompts/:id → deletePrompt(...)
PUT    /api/projects/:project/sessions/:sessionId/prompts/reorder → reorder(...)
DELETE /api/projects/:project                                 → deleteProject(project)
DELETE /api/projects/:project/sessions/:sessionId             → deleteSession(project, sessionId)
```

Route parsing: split `url.pathname` by `/` and match segments positionally.

**Step 5: Commit**

```bash
git add vite-plugin-api.ts
git commit -m "refactor: rewrite API for per-session queues with project grouping"
```

---

### Task 3: Rewrite hooks

**Files:**
- Rewrite: `session-register.sh`
- Rewrite: `prompt-queue.sh`

**Step 1: Rewrite session-register.sh**

Key changes:
- Parse `transcript_path` from hook input (in addition to `session_id` and `cwd`)
- Create directory: `~/.promptline/queues/{project}/`
- Create file: `{project}/{session_id}.json`
- Extract `sessionName`: read transcript JSONL, find first entry with `type: "user"`, extract first 80 chars of `message.content`
- If transcript is empty or no user message yet, set `sessionName: null`

```bash
#!/bin/bash
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

# Load existing or create new
if os.path.isfile(queue_file):
    try:
        with open(queue_file, "r") as f:
            data = json.load(f)
        # Update lastActivity
        data["lastActivity"] = now
        # Try to fill sessionName if still null
        if not data.get("sessionName"):
            data["sessionName"] = extract_session_name(transcript_path)
        atomic_write(queue_file, data)
    except (json.JSONDecodeError, IOError):
        pass
    # File exists, just updated — done
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
```

**Step 2: Rewrite prompt-queue.sh**

Key changes:
- Same new path: `~/.promptline/queues/{project}/{session_id}.json`
- Parse `transcript_path` from input
- If sessionName is null, try to extract it
- Rest of prompt logic stays the same

```bash
#!/bin/bash
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

if [ -z "$CWD" ]; then
  exit 0
fi

PROJECT=$(basename "$CWD")
QUEUE_DIR="$HOME/.promptline/queues/$PROJECT"
QUEUE_FILE="$QUEUE_DIR/$SESSION_ID.json"

export QUEUE_FILE SESSION_ID CWD PROJECT TRANSCRIPT_PATH

if [ ! -f "$QUEUE_FILE" ]; then
  exit 0
fi

# (Python block: same prompt processing logic as before,
#  but operating on the new SessionQueue structure
#  and updating sessionName if null)
```

The Python block inside prompt-queue.sh follows the same logic:
1. Mark running → completed
2. Track completedAt when all done
3. Update sessionName if null (from transcript)
4. Find next pending → mark running → exit 2
5. No pending → exit 0

**Step 3: Copy hooks and test**

```bash
cp session-register.sh ~/.claude/hooks/session-register.sh
cp prompt-queue.sh ~/.claude/hooks/prompt-queue.sh
chmod +x ~/.claude/hooks/*.sh
```

**Step 4: Commit**

```bash
git add session-register.sh prompt-queue.sh
git commit -m "refactor: rewrite hooks for per-session queue files"
```

---

### Task 4: Update API client and React hooks

**Files:**
- Rewrite: `src/api/client.ts`
- Modify: `src/hooks/useQueues.ts`
- Modify: `src/hooks/useQueue.ts`

**Step 1: Update client.ts**

```typescript
import type { ProjectView, SessionQueue, Prompt } from '../types/queue';

const BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  listProjects: () => request<ProjectView[]>('/projects'),

  getProject: (project: string) =>
    request<ProjectView>(`/projects/${encodeURIComponent(project)}`),

  addPrompt: (project: string, sessionId: string, text: string) =>
    request<Prompt>(`/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  updatePrompt: (project: string, sessionId: string, promptId: string, data: { text?: string }) =>
    request<Prompt>(`/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}/prompts/${promptId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deletePrompt: (project: string, sessionId: string, promptId: string) =>
    request<void>(`/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}/prompts/${promptId}`, {
      method: 'DELETE',
    }),

  reorderPrompts: (project: string, sessionId: string, promptIds: string[]) =>
    request<void>(`/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}/prompts/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ order: promptIds }),
    }),

  deleteProject: (project: string) =>
    request<void>(`/projects/${encodeURIComponent(project)}`, { method: 'DELETE' }),

  deleteSession: (project: string, sessionId: string) =>
    request<void>(`/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }),
};
```

**Step 2: Update useQueues.ts**

Change from `ProjectQueue[]` → `ProjectView[]`. Same polling logic.

**Step 3: Update useQueue.ts**

Change from `ProjectQueue` → `ProjectView`. Endpoint changes from `/queues/:project` → `/projects/:project`.

**Step 4: Commit**

```bash
git add src/api/client.ts src/hooks/useQueues.ts src/hooks/useQueue.ts
git commit -m "refactor: update API client and hooks for per-session queues"
```

---

### Task 5: Build SessionSection component

**Files:**
- Create: `src/components/SessionSection.tsx`

**Description:**

A self-contained section for one session within a project view. Contains:
- Header: status dot + session name (or truncated session ID) + collapse toggle
- Prompt list (PromptCard instances) with drag & drop within the session
- AddPromptForm at the bottom
- All the drag & drop state/logic that currently lives in QueueDetail moves here (per-session scope)

```typescript
interface SessionSectionProps {
  session: SessionQueue & { status: SessionStatus };
  project: string;
  onMutate: () => void;
  defaultExpanded?: boolean;
}
```

The session name display logic:
- `sessionName` exists → show it (truncated to fit)
- `sessionName` is null → show `(session)` in muted text (matching Claude Code behavior)

**Step: Commit**

```bash
git add src/components/SessionSection.tsx
git commit -m "feat: add SessionSection component for per-session prompt queues"
```

---

### Task 6: Rewrite ProjectDetail and update Sidebar/App

**Files:**
- Rename+Rewrite: `src/components/QueueDetail.tsx` → `src/components/ProjectDetail.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`
- Delete: `src/components/SessionInfo.tsx`
- Modify: `src/components/PromptCard.tsx` (add sessionId prop)
- Modify: `src/components/AddPromptForm.tsx` (add sessionId prop)
- Delete: `src/components/CreateQueueModal.tsx` (no longer needed — sessions auto-register)

**Step 1: ProjectDetail.tsx**

Replaces QueueDetail. Receives a `ProjectView` (or fetches via `useQueue`). Renders:
- Project header (name, directory, delete button)
- Active sessions: `SessionSection` for each visible session
- History: collapsible section with completed/idle-empty sessions

Visible sessions = active, or idle with pending prompts.
History sessions = idle without pending prompts, or all completed.

**Step 2: Update PromptCard.tsx**

Add `sessionId: string` to props. Pass it through to `api.updatePrompt(project, sessionId, ...)` and `api.deletePrompt(project, sessionId, ...)`.

**Step 3: Update AddPromptForm.tsx**

Add `sessionId: string` to props. Use `api.addPrompt(project, sessionId, text)`.

**Step 4: Update Sidebar.tsx**

Props change from `QueueWithStatus[]` → `ProjectView[]`. Badge logic:
- Count total pending prompts across all sessions
- Status dot: green if any session is active, idle-gray otherwise

**Step 5: Update App.tsx**

Replace `QueueDetail` with `ProjectDetail`. Remove `CreateQueueModal` (sessions are auto-created by hooks). Remove the `+ New Queue` button from sidebar, or repurpose it.

**Step 6: Delete unused components**

```bash
rm src/components/SessionInfo.tsx
rm src/components/CreateQueueModal.tsx
```

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: implement multi-session project view with stacked session sections"
```

---

### Task 7: End-to-end testing and cleanup

**Steps:**
1. Clean old queue files: `rm -f ~/.promptline/queues/*.json`
2. `npm run dev` — dashboard should be empty
3. Open a new terminal, `cd` to a project, run `claude` — session should auto-appear in dashboard
4. Add prompts from dashboard to that session
5. Open a second terminal to the same project, run `claude` — second session section should appear
6. Verify prompts in each session are independent
7. Verify drag & drop works within each session
8. Close one session — verify it moves to History after timeout
9. Copy hooks to `~/.claude/hooks/` and verify
10. TypeScript check: `npx tsc --noEmit`

```bash
cp session-register.sh ~/.claude/hooks/session-register.sh
cp prompt-queue.sh ~/.claude/hooks/prompt-queue.sh
chmod +x ~/.claude/hooks/*.sh
```

**Commit:**

```bash
git add -A
git commit -m "test: verify multi-session queues end-to-end"
```
