# PromptLine Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden PromptLine with atomic file writes, session timeout detection, and stale session cleanup — without breaking existing functionality.

**Architecture:** Three independent improvements: (1) Atomic writes via write-to-temp + rename in both the hook and the API, (2) Session timeout detection in the dashboard that auto-marks idle sessions after 5 minutes of inactivity, (3) The API serves computed session status (active vs idle) based on `lastActivity` timestamp so the dashboard always shows accurate state.

**Tech Stack:** Python 3 (hook), Node.js/TypeScript (Vite API), React (frontend)

---

### Task 1: Atomic file writes in the Python hook

**Files:**
- Modify: `prompt-queue.sh` (the Python block inside, lines 48-149)
- Modify: `~/.claude/hooks/prompt-queue.sh` (copy after changes)

**Why:** Currently `open(queue_file, "w")` truncates the file before writing. If the process crashes mid-write, the file is corrupted (empty or partial). Writing to a temp file then renaming is atomic on POSIX systems.

**Step 1: Add atomic write to the Python block in prompt-queue.sh**

Replace both `with open(queue_file, "w") as f: json.dump(data, f, indent=2)` occurrences (lines ~124 and ~137) with:

```python
import tempfile

def atomic_write(path, data):
    dir_name = os.path.dirname(path)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, path)
    except:
        os.unlink(tmp_path)
        raise
```

Then use `atomic_write(queue_file, data)` in both places.

**Step 2: Test the hook still works**

```bash
# Create a test queue
mkdir -p ~/.promptline/queues
echo '{"project":"test-atomic","directory":"/tmp","prompts":[{"id":"p1","text":"hello","status":"pending","createdAt":"2024-01-01T00:00:00Z","completedAt":null}],"activeSession":null,"sessionHistory":[]}' > ~/.promptline/queues/test-atomic.json

# Simulate hook call
echo '{"session_id":"test-123","cwd":"/tmp/test-atomic"}' | bash prompt-queue.sh
echo $?
# Expected: exit 2

# Verify JSON is valid
python3 -c "import json; json.load(open('$HOME/.promptline/queues/test-atomic.json'))" && echo "JSON valid"

# Cleanup
rm ~/.promptline/queues/test-atomic.json
```

**Step 3: Copy hook to ~/.claude/hooks/**

```bash
cp prompt-queue.sh ~/.claude/hooks/prompt-queue.sh
chmod +x ~/.claude/hooks/prompt-queue.sh
```

**Step 4: Commit**

```bash
git add prompt-queue.sh
git commit -m "fix: use atomic writes in hook to prevent file corruption"
```

---

### Task 2: Atomic file writes in the Vite API

**Files:**
- Modify: `vite-plugin-api.ts` (the `writeQueue` function, line 25-28)

**Why:** Same risk as the hook. The API calls `writeFileSync` which truncates before writing. Use write-to-temp + rename.

**Step 1: Replace writeQueue with atomic version**

```typescript
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

function writeQueue(queue: ProjectQueue): void {
  ensureQueuesDir();
  const filePath = queuePath(queue.project);
  const tmpPath = filePath + '.tmp.' + process.pid;
  try {
    writeFileSync(tmpPath, JSON.stringify(queue, null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}
```

**Step 2: Verify the API still works**

```bash
cd /Users/juanchirossi/Documents/Proyectos/promptline
npm run dev &
sleep 3
# Test create queue
curl -s -X POST http://localhost:$(lsof -ti :3000-10000 -sTCP:LISTEN | head -1 | xargs -I{} lsof -p {} -i -P | grep LISTEN | grep -oP ':\K[0-9]+')/api/queues/test-atomic -H 'Content-Type: application/json' -d '{"directory":"/tmp"}' | python3 -m json.tool
# Cleanup: delete test queue via API
```

**Step 3: Commit**

```bash
git add vite-plugin-api.ts
git commit -m "fix: use atomic writes in API to prevent file corruption"
```

---

### Task 3: Session timeout — computed status in API responses

**Files:**
- Modify: `vite-plugin-api.ts` (add session status computation in `readQueue`)
- Modify: `src/types/queue.ts` (no changes needed — SessionStatus already has 'idle')

**Why:** If Claude Code crashes or exits without triggering the Stop hook, the session stays as "active" forever. We should compute the status server-side: if `lastActivity` is older than 5 minutes, the session is "idle".

**Step 1: Add session status computation in the API**

Add a function after `readQueue`:

```typescript
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function withComputedSessionStatus(queue: ProjectQueue): ProjectQueue {
  if (!queue.activeSession) return queue;
  const lastActivity = new Date(queue.activeSession.lastActivity).getTime();
  const isStale = Date.now() - lastActivity > SESSION_TIMEOUT_MS;
  return {
    ...queue,
    activeSession: {
      ...queue.activeSession,
      status: isStale ? 'idle' : 'active',
    },
  };
}
```

Then apply it in:
- `GET /api/queues` (listQueues): map each queue through `withComputedSessionStatus`
- `GET /api/queues/:project`: apply before returning

**Step 2: Verify session status computation**

```bash
# Manually set lastActivity to 10 minutes ago in a queue JSON
# Then GET the queue via API and verify status is "idle"
# Then simulate a hook call (updates lastActivity) and verify status becomes "active"
```

**Step 3: Commit**

```bash
git add vite-plugin-api.ts
git commit -m "feat: auto-detect idle sessions after 5min inactivity"
```

---

### Task 4: Update SessionInfo UI to reflect idle state

**Files:**
- Modify: `src/components/SessionInfo.tsx` (already handles 'idle' status — just verify)

**Why:** The UI already renders "idle" vs "active" based on `session.status`. Since we now compute this server-side, it should just work. But we should verify and add a subtle tooltip showing when the session was last active.

**Step 1: Verify the existing UI handles idle correctly**

The `SessionInfo` component already checks `isActive = session.status === 'active'` and renders differently for idle. No code changes needed — the computed status from the API flows through automatically.

**Step 2: Visual verification**

Start the dev server, manually edit a queue JSON to set `lastActivity` to 10 minutes ago, and confirm the dashboard shows the session as "idle" with the yellow dot instead of green.

**Step 3: Commit (only if changes needed)**

---

### Task 5: Copy updated hook and final verification

**Files:**
- Copy: `prompt-queue.sh` → `~/.claude/hooks/prompt-queue.sh`

**Step 1: Copy the hook**

```bash
cp prompt-queue.sh ~/.claude/hooks/prompt-queue.sh
chmod +x ~/.claude/hooks/prompt-queue.sh
```

**Step 2: End-to-end verification**

1. Start dev server: `npm run dev`
2. Create a test queue via dashboard
3. Simulate hook calls:
   - First call with pending prompt → exit 2, prompt marked running
   - Second call → running→completed, next pending→running
   - Verify dashboard updates in real-time
4. Wait 5+ minutes (or manually set lastActivity) → verify session shows as "idle"
5. Delete test queue via dashboard

**Step 3: Final commit if any remaining changes**

```bash
git add -A
git commit -m "chore: copy updated hook to claude hooks directory"
```
