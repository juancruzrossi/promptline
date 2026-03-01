# PromptLine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **For Frontend:** REQUIRED SUB-SKILL: Use /frontend-design skill when implementing Tasks 6-8.

**Goal:** Build a terminal-style React dashboard that manages prompt queues for Claude Code sessions, backed by JSON files and a Stop hook.

**Architecture:** React 19 + Vite SPA with an embedded API middleware plugin that reads/writes JSON files in `~/.promptline/`. A refactored bash hook feeds prompts to Claude Code on stop. No separate backend process.

**Tech Stack:** React 19, Vite 6, TypeScript, Tailwind CSS v4, JetBrains Mono font, uuid package

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `tailwind.config.ts`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `index.html`
- Create: `src/index.css`

**Step 1: Initialize Vite project**

Run: `npm create vite@latest . -- --template react-ts` (inside `/Users/juanchirossi/Documents/Proyectos/promptline/`)

**Step 2: Install dependencies**

Run:
```bash
npm install
npm install -D tailwindcss @tailwindcss/vite
npm install uuid
npm install -D @types/uuid
```

**Step 3: Configure Tailwind CSS v4**

In `src/index.css`:
```css
@import "tailwindcss";
```

In `vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
```

**Step 4: Add JetBrains Mono font**

In `index.html`, add in `<head>`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```

**Step 5: Verify it runs**

Run: `npm run dev`
Expected: Vite dev server starts, page loads at localhost:5173

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold Vite + React + TypeScript + Tailwind project"
```

---

### Task 2: TypeScript Types

**Files:**
- Create: `src/types/queue.ts`

**Step 1: Define all types**

```ts
// src/types/queue.ts

export type PromptStatus = 'pending' | 'running' | 'completed';
export type SessionStatus = 'active' | 'idle';

export interface Prompt {
  id: string;
  text: string;
  status: PromptStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface ActiveSession {
  sessionId: string;
  status: SessionStatus;
  startedAt: string;
  lastActivity: string;
  currentPromptId: string | null;
}

export interface SessionHistoryEntry {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  promptsExecuted: number;
}

export interface ProjectQueue {
  project: string;
  directory: string;
  prompts: Prompt[];
  activeSession: ActiveSession | null;
  sessionHistory: SessionHistoryEntry[];
}

export interface PromptLineConfig {
  pollIntervalMs: number;
  queueDir: string;
}
```

**Step 2: Commit**

```bash
git add src/types/queue.ts
git commit -m "feat: add TypeScript types for queue, prompt, and session"
```

---

### Task 3: Vite API Middleware Plugin

**Files:**
- Create: `vite-plugin-api.ts` (project root, runs in Node)

**Step 1: Create the plugin**

```ts
// vite-plugin-api.ts
import { Plugin } from 'vite';
import fs from 'fs';
import path from 'path';

const QUEUE_DIR = path.join(process.env.HOME || '~', '.promptline', 'queues');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readQueue(project: string) {
  const filePath = path.join(QUEUE_DIR, `${project}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeQueue(project: string, data: any) {
  ensureDir(QUEUE_DIR);
  const filePath = path.join(QUEUE_DIR, `${project}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export default function apiPlugin(): Plugin {
  return {
    name: 'promptline-api',
    configureServer(server) {
      // Parse JSON body helper
      const parseBody = (req: any): Promise<any> => {
        return new Promise((resolve, reject) => {
          let body = '';
          req.on('data', (chunk: string) => { body += chunk; });
          req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { reject(new Error('Invalid JSON')); }
          });
        });
      };

      const sendJson = (res: any, data: any, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();

        const url = new URL(req.url, 'http://localhost');
        const segments = url.pathname.split('/').filter(Boolean); // ['api', 'queues', ...]

        try {
          ensureDir(QUEUE_DIR);

          // GET /api/queues
          if (req.method === 'GET' && segments.length === 2 && segments[1] === 'queues') {
            const files = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'));
            const queues = files.map(f => JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, f), 'utf-8')));
            return sendJson(res, queues);
          }

          // GET /api/queues/:project
          if (req.method === 'GET' && segments.length === 3 && segments[1] === 'queues') {
            const queue = readQueue(segments[2]);
            if (!queue) return sendJson(res, { error: 'Not found' }, 404);
            return sendJson(res, queue);
          }

          // POST /api/queues/:project
          if (req.method === 'POST' && segments.length === 3 && segments[1] === 'queues') {
            const body = await parseBody(req);
            const project = segments[2];
            const queue = {
              project,
              directory: body.directory || '',
              prompts: [],
              activeSession: null,
              sessionHistory: [],
            };
            writeQueue(project, queue);
            return sendJson(res, queue, 201);
          }

          // DELETE /api/queues/:project
          if (req.method === 'DELETE' && segments.length === 3 && segments[1] === 'queues') {
            const filePath = path.join(QUEUE_DIR, `${segments[2]}.json`);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return sendJson(res, { ok: true });
          }

          // POST /api/queues/:project/prompts
          if (req.method === 'POST' && segments.length === 4 && segments[3] === 'prompts') {
            const body = await parseBody(req);
            const queue = readQueue(segments[2]);
            if (!queue) return sendJson(res, { error: 'Queue not found' }, 404);
            const { v4: uuidv4 } = await import('uuid');
            const prompt = {
              id: uuidv4(),
              text: body.text,
              status: 'pending',
              createdAt: new Date().toISOString(),
              completedAt: null,
            };
            queue.prompts.push(prompt);
            writeQueue(segments[2], queue);
            return sendJson(res, prompt, 201);
          }

          // PUT /api/queues/:project/prompts/:id
          if (req.method === 'PUT' && segments.length === 5 && segments[3] === 'prompts') {
            const body = await parseBody(req);
            const queue = readQueue(segments[2]);
            if (!queue) return sendJson(res, { error: 'Queue not found' }, 404);
            const idx = queue.prompts.findIndex((p: any) => p.id === segments[4]);
            if (idx === -1) return sendJson(res, { error: 'Prompt not found' }, 404);
            if (body.text !== undefined) queue.prompts[idx].text = body.text;
            if (body.status !== undefined) queue.prompts[idx].status = body.status;
            writeQueue(segments[2], queue);
            return sendJson(res, queue.prompts[idx]);
          }

          // DELETE /api/queues/:project/prompts/:id
          if (req.method === 'DELETE' && segments.length === 5 && segments[3] === 'prompts') {
            const queue = readQueue(segments[2]);
            if (!queue) return sendJson(res, { error: 'Queue not found' }, 404);
            queue.prompts = queue.prompts.filter((p: any) => p.id !== segments[4]);
            writeQueue(segments[2], queue);
            return sendJson(res, { ok: true });
          }

          // PUT /api/queues/:project/prompts/reorder
          if (req.method === 'PUT' && segments.length === 5 && segments[3] === 'prompts' && segments[4] === 'reorder') {
            const body = await parseBody(req);
            const queue = readQueue(segments[2]);
            if (!queue) return sendJson(res, { error: 'Queue not found' }, 404);
            // body.order is an array of prompt IDs in new order
            const ordered = body.order
              .map((id: string) => queue.prompts.find((p: any) => p.id === id))
              .filter(Boolean);
            // Keep any prompts not in the order list at the end
            const remaining = queue.prompts.filter((p: any) => !body.order.includes(p.id));
            queue.prompts = [...ordered, ...remaining];
            writeQueue(segments[2], queue);
            return sendJson(res, queue);
          }

          return sendJson(res, { error: 'Not found' }, 404);
        } catch (err: any) {
          return sendJson(res, { error: err.message }, 500);
        }
      });
    },
  };
}
```

**Step 2: Wire plugin into vite.config.ts**

Update `vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import apiPlugin from './vite-plugin-api'

export default defineConfig({
  plugins: [react(), tailwindcss(), apiPlugin()],
})
```

**Step 3: Test with curl**

Run: `npm run dev` then:
```bash
# Create a queue
curl -X POST http://localhost:5173/api/queues/test-project -H 'Content-Type: application/json' -d '{"directory":"/tmp/test"}'

# Add a prompt
curl -X POST http://localhost:5173/api/queues/test-project/prompts -H 'Content-Type: application/json' -d '{"text":"hello world"}'

# List queues
curl http://localhost:5173/api/queues

# Get specific queue
curl http://localhost:5173/api/queues/test-project
```

Expected: All return valid JSON, files created in `~/.promptline/queues/`

**Step 4: Clean up test data and commit**

```bash
rm -f ~/.promptline/queues/test-project.json
git add vite-plugin-api.ts vite.config.ts
git commit -m "feat: add Vite API middleware plugin for queue CRUD"
```

---

### Task 4: Refactor Hook to JSON-Based Storage

**Files:**
- Modify: `prompt-queue.sh`

**Step 1: Rewrite the hook**

Replace the entire content of `prompt-queue.sh`:

```bash
#!/bin/bash
# prompt-queue.sh - PromptLine hook for Claude Code
# Reads the next prompt from a project's JSON queue file,
# sends it to Claude Code via stderr, and exits with code 2.
# If no prompts remain, exits with code 0.

set -euo pipefail

# Read Claude Code hook input from stdin
INPUT=$(cat)

# Extract session_id and cwd from hook input
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || echo "")
CWD=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || echo "$(pwd)")

# Derive project name from cwd (last directory segment)
PROJECT=$(basename "$CWD")

# Queue directory
QUEUE_DIR="${HOME}/.promptline/queues"
QUEUE_FILE="${QUEUE_DIR}/${PROJECT}.json"

# No queue file for this project -> exit normally
if [ ! -f "$QUEUE_FILE" ]; then
    exit 0
fi

# Read queue using python3 (available on macOS)
RESULT=$(python3 << 'PYEOF'
import json, sys, os
from datetime import datetime

queue_file = os.environ.get('QUEUE_FILE', '')
session_id = os.environ.get('SESSION_ID', '')

if not queue_file or not os.path.exists(queue_file):
    print("EXIT:0")
    sys.exit(0)

with open(queue_file, 'r') as f:
    queue = json.load(f)

# Find first pending prompt
pending = [p for p in queue.get('prompts', []) if p['status'] == 'pending']

if not pending:
    # No pending prompts - mark session idle
    if queue.get('activeSession'):
        queue['activeSession']['status'] = 'idle'
        queue['activeSession']['lastActivity'] = datetime.utcnow().isoformat() + 'Z'
        queue['activeSession']['currentPromptId'] = None
    with open(queue_file, 'w') as f:
        json.dump(queue, f, indent=2)
    print("EXIT:0")
    sys.exit(0)

# Take the first pending prompt
prompt = pending[0]
prompt['status'] = 'running'

# Update active session
now = datetime.utcnow().isoformat() + 'Z'
if not queue.get('activeSession') or queue['activeSession'].get('sessionId') != session_id:
    # New session or different session
    if queue.get('activeSession') and queue['activeSession'].get('sessionId'):
        # Archive previous session
        old = queue['activeSession']
        completed_count = len([p for p in queue['prompts'] if p['status'] == 'completed'])
        queue.setdefault('sessionHistory', []).append({
            'sessionId': old['sessionId'],
            'startedAt': old.get('startedAt', now),
            'endedAt': now,
            'promptsExecuted': completed_count,
        })
    queue['activeSession'] = {
        'sessionId': session_id,
        'status': 'active',
        'startedAt': now,
        'lastActivity': now,
        'currentPromptId': prompt['id'],
    }
else:
    queue['activeSession']['status'] = 'active'
    queue['activeSession']['lastActivity'] = now
    queue['activeSession']['currentPromptId'] = prompt['id']

with open(queue_file, 'w') as f:
    json.dump(queue, f, indent=2)

# Output the prompt text
print("PROMPT:" + prompt['text'])
PYEOF
)

export QUEUE_FILE SESSION_ID

# Parse result
if echo "$RESULT" | grep -q "^EXIT:0"; then
    exit 0
fi

if echo "$RESULT" | grep -q "^PROMPT:"; then
    PROMPT_TEXT=$(echo "$RESULT" | sed 's/^PROMPT://')

    # Count remaining
    REMAINING=$(python3 -c "
import json
with open('$QUEUE_FILE') as f:
    q = json.load(f)
print(len([p for p in q['prompts'] if p['status'] == 'pending']))
" 2>/dev/null || echo "?")

    {
        echo "===== PromptLine: Executing next prompt (${REMAINING} remaining) ====="
        echo ""
        echo "$PROMPT_TEXT"
    } >&2

    exit 2
fi

exit 0
```

**Step 2: Make executable**

Run: `chmod +x prompt-queue.sh`

**Step 3: Test hook independently**

```bash
# Create a test queue
mkdir -p ~/.promptline/queues
cat > ~/.promptline/queues/test-hook.json << 'EOF'
{
  "project": "test-hook",
  "directory": "/tmp/test-hook",
  "prompts": [
    { "id": "t1", "text": "echo hello", "status": "pending", "createdAt": "2026-03-01T00:00:00Z", "completedAt": null }
  ],
  "activeSession": null,
  "sessionHistory": []
}
EOF

# Simulate Claude Code input
echo '{"session_id":"test-123","cwd":"/tmp/test-hook"}' | QUEUE_FILE="$HOME/.promptline/queues/test-hook.json" SESSION_ID="test-123" bash prompt-queue.sh 2>&1; echo "Exit code: $?"
```

Expected: stderr shows the prompt text, exit code is 2, JSON file shows prompt status changed to "running"

**Step 4: Clean up test data and commit**

```bash
rm -f ~/.promptline/queues/test-hook.json
git add prompt-queue.sh
git commit -m "feat: refactor hook to use JSON queue storage with session tracking"
```

---

### Task 5: React API Client & Hooks

**Files:**
- Create: `src/api/client.ts`
- Create: `src/hooks/useQueues.ts`
- Create: `src/hooks/useQueue.ts`

**Step 1: Create API client**

```ts
// src/api/client.ts
import type { ProjectQueue, Prompt } from '../types/queue';

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
  listQueues: () => request<ProjectQueue[]>('/queues'),
  getQueue: (project: string) => request<ProjectQueue>(`/queues/${project}`),
  createQueue: (project: string, directory: string) =>
    request<ProjectQueue>(`/queues/${project}`, {
      method: 'POST',
      body: JSON.stringify({ directory }),
    }),
  deleteQueue: (project: string) =>
    request<{ ok: boolean }>(`/queues/${project}`, { method: 'DELETE' }),
  addPrompt: (project: string, text: string) =>
    request<Prompt>(`/queues/${project}/prompts`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  updatePrompt: (project: string, id: string, data: Partial<Prompt>) =>
    request<Prompt>(`/queues/${project}/prompts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deletePrompt: (project: string, id: string) =>
    request<{ ok: boolean }>(`/queues/${project}/prompts/${id}`, { method: 'DELETE' }),
  reorderPrompts: (project: string, order: string[]) =>
    request<ProjectQueue>(`/queues/${project}/prompts/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ order }),
    }),
};
```

**Step 2: Create useQueues hook (list all queues with polling)**

```ts
// src/hooks/useQueues.ts
import { useState, useEffect, useCallback } from 'react';
import type { ProjectQueue } from '../types/queue';
import { api } from '../api/client';

export function useQueues(pollIntervalMs = 2000) {
  const [queues, setQueues] = useState<ProjectQueue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listQueues();
      setQueues(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollIntervalMs);
    return () => clearInterval(interval);
  }, [refresh, pollIntervalMs]);

  return { queues, loading, error, refresh };
}
```

**Step 3: Create useQueue hook (single queue with polling)**

```ts
// src/hooks/useQueue.ts
import { useState, useEffect, useCallback } from 'react';
import type { ProjectQueue } from '../types/queue';
import { api } from '../api/client';

export function useQueue(project: string | null, pollIntervalMs = 2000) {
  const [queue, setQueue] = useState<ProjectQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!project) { setLoading(false); return; }
    try {
      const data = await api.getQueue(project);
      setQueue(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollIntervalMs);
    return () => clearInterval(interval);
  }, [refresh, pollIntervalMs]);

  return { queue, loading, error, refresh };
}
```

**Step 4: Commit**

```bash
git add src/api/ src/hooks/
git commit -m "feat: add API client and React polling hooks"
```

---

### Task 6: Frontend - Layout Shell & Sidebar

> **REQUIRED:** Use `/frontend-design` skill for this task.

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Create: `src/components/Sidebar.tsx`
- Create: `src/components/StatusBar.tsx`

**Design Requirements:**
- Dark mode (#0a0a0f background, subtle borders)
- JetBrains Mono font everywhere
- Left sidebar 280px with project list
- Each project item shows: name + status dot (mint green=active, pink=idle, gray=no session)
- Main content area fills remaining space
- Bottom status bar with stats
- Pulsing animation on active session dots
- Glassmorphism card style with rgba borders

**Step 1: Implement Sidebar component**

The sidebar shows all projects from `useQueues()`. Each project is a clickable item with:
- Project name (monospace)
- Status dot with pulsing animation if active
- Truncated directory path below the name
- Selected state with left accent border

**Step 2: Implement StatusBar component**

Fixed bottom bar showing:
- Total active sessions count
- Total queued prompts count
- Total completed prompts count

**Step 3: Wire up App.tsx layout**

Two-column layout: sidebar | main content. Use CSS grid or flex. State for `selectedProject`.

**Step 4: Style in index.css**

Add CSS custom properties for the color palette:
- `--color-active`: mint green (#4ade80)
- `--color-running`: violet (#a78bfa)
- `--color-pending`: blue (#60a5fa)
- `--color-idle`: pink (#f472b6)
- `--color-completed`: emerald (#34d399)
- `--color-surface`: dark (#111118)
- `--color-bg`: darker (#0a0a0f)
- `--color-border`: subtle (#1e1e2e)

**Step 5: Verify visual**

Run: `npm run dev`
Expected: Dark terminal-style layout with sidebar and status bar visible

**Step 6: Commit**

```bash
git add src/
git commit -m "feat: add layout shell with sidebar and status bar"
```

---

### Task 7: Frontend - Queue Detail & Prompt Cards

> **REQUIRED:** Use `/frontend-design` skill for this task.

**Files:**
- Create: `src/components/QueueDetail.tsx`
- Create: `src/components/PromptCard.tsx`
- Create: `src/components/SessionInfo.tsx`
- Create: `src/components/AddPromptForm.tsx`

**Design Requirements:**
- QueueDetail: header with project name + session status badge + Resume button
- SessionInfo: shows session UUID (truncated), status, last activity
- PromptCard: glassmorphism card with prompt text, status badge (colored), edit/delete actions
  - Running card has a subtle animated left border (violet pulse)
  - Completed cards are slightly dimmed
  - Pending cards show drag handle
- AddPromptForm: textarea that appears inline when clicking "+ Add Prompt"
- Completed prompts go to a collapsible "History" section below pending ones

**Step 1: Implement PromptCard component**

Card with:
- Left color border based on status
- Prompt text (multiline support)
- Status badge (top right)
- Edit icon (pencil) + Delete icon (trash) on hover
- Drag handle (6 dots) on left for pending prompts

**Step 2: Implement SessionInfo component**

Shows: session UUID (first 8 chars + "..."), status badge, "Resume" button that copies `claude --resume <uuid>` to clipboard.

**Step 3: Implement AddPromptForm component**

A "+" button that expands to a textarea + "Add" / "Cancel" buttons. Calls `api.addPrompt()`.

**Step 4: Implement QueueDetail component**

Combines SessionInfo + list of PromptCards (pending/running first, then completed in collapsible section) + AddPromptForm.

**Step 5: Wire into App.tsx**

When a project is selected in the sidebar, show QueueDetail in the main area.

**Step 6: Verify visual**

Create a test queue with prompts via curl, verify cards render correctly.

**Step 7: Commit**

```bash
git add src/components/
git commit -m "feat: add queue detail view with prompt cards"
```

---

### Task 8: Frontend - Interactivity (CRUD + Drag & Drop)

> **REQUIRED:** Use `/frontend-design` skill for this task.

**Files:**
- Modify: `src/components/PromptCard.tsx`
- Modify: `src/components/QueueDetail.tsx`
- Create: `src/components/EditPromptModal.tsx`
- Create: `src/components/CreateQueueModal.tsx`
- Create: `src/components/ConfirmDialog.tsx`

**Step 1: Implement drag & drop reordering**

Use native HTML drag & drop API (no library needed for simple reorder):
- `draggable` on pending PromptCards
- `onDragStart`, `onDragOver`, `onDrop` handlers
- Visual feedback: drop target line indicator
- On drop: call `api.reorderPrompts()` with new order

**Step 2: Implement inline edit**

Click pencil icon on a PromptCard -> text becomes editable textarea. Save/Cancel buttons appear. Calls `api.updatePrompt()`.

**Step 3: Implement delete with confirmation**

Click trash icon -> ConfirmDialog appears. On confirm: `api.deletePrompt()`.

**Step 4: Implement CreateQueueModal**

Modal with:
- Project name input (auto-slugified)
- Directory path input
- Create button -> `api.createQueue()`

Triggered by "+ New Queue" button in sidebar header.

**Step 5: Implement delete queue**

Right-click or long-press on sidebar project -> context option to delete. ConfirmDialog -> `api.deleteQueue()`.

**Step 6: Verify all interactions**

Test: add queue, add prompts, reorder, edit, delete, delete queue.

**Step 7: Commit**

```bash
git add src/
git commit -m "feat: add CRUD interactions and drag-and-drop reordering"
```

---

### Task 9: Hook Installation & Settings

**Files:**
- Modify: `~/.claude/settings.json` (manual or scripted)
- Create: setup instructions in README

**Step 1: Create the ~/.promptline directory**

```bash
mkdir -p ~/.promptline/queues
```

**Step 2: Copy hook to ~/.claude/hooks/**

```bash
cp prompt-queue.sh ~/.claude/hooks/prompt-queue.sh
chmod +x ~/.claude/hooks/prompt-queue.sh
```

**Step 3: Update settings.json**

Add the hook to the Stop hooks array (alongside existing `afplay` sound):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/prompt-queue.sh"
          }
        ]
      },
      {
        "hooks": [
          {
            "type": "command",
            "command": "afplay /System/Library/Sounds/Blow.aiff"
          }
        ]
      }
    ]
  }
}
```

Note: The prompt-queue hook should run FIRST (before the sound), so when it exits with code 2 the sound won't play (Claude continues). When it exits 0 (no more prompts), the sound plays normally.

**Step 4: Test end-to-end**

1. Start PromptLine dashboard: `npm run dev`
2. Create a queue for a test project
3. Add 2 prompts
4. Open Claude Code in that project directory
5. Send a message, wait for Claude to finish
6. Verify: hook fires, first prompt is consumed, Claude continues
7. Verify: dashboard shows prompt moving to "running" then "completed"

**Step 5: Commit**

```bash
git add -A
git commit -m "docs: add hook installation instructions"
```

---

### Task 10: Final Polish & Push

**Step 1: Review all components visually**

Check: dark mode, fonts, colors, animations, responsiveness.

**Step 2: Add empty states**

- No queues: show "Create your first queue" message
- No prompts: show "Add prompts to get started"
- No active session: show "No active Claude Code session"

**Step 3: Run build check**

```bash
npm run build
```

Fix any TypeScript or build errors.

**Step 4: Final commit and push**

```bash
git add -A
git commit -m "feat: finalize PromptLine v1 with polish and empty states"
git push origin main
```
