# Test Suite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a comprehensive test suite covering the backend queue store and shell hooks.

**Architecture:** Extract pure functions from `vite-plugin-api.ts` into a testable `src/backend/queue-store.ts` module that accepts a `queuesDir` parameter. Tests run against a real filesystem in a temporary directory. Shell hooks are tested by executing them via `child_process.execSync` with crafted JSON input.

**Tech Stack:** Vitest, Node.js fs (real filesystem in tmpdir), child_process for shell hooks.

---

### Task 1: Install Vitest and configure

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

**Step 1: Install vitest**

Run: `npm install -D vitest`

**Step 2: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

**Step 3: Add test scripts to package.json**

Add to "scripts":
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 4: Run vitest to verify setup**

Run: `npx vitest run`
Expected: "No test files found" (no error)

**Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest and test configuration"
```

---

### Task 2: Extract queue-store module from vite-plugin-api.ts

**Files:**
- Create: `src/backend/queue-store.ts`
- Modify: `vite-plugin-api.ts`
- Modify: `tsconfig.node.json` (add src/backend to include)

**Step 1: Create `src/backend/queue-store.ts`**

Extract these functions from `vite-plugin-api.ts`, parameterized by `queuesDir`:

```ts
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionQueue, Prompt, PromptStatus, SessionStatus, QueueStatus, ProjectView } from '../types/queue.ts';

export const SESSION_TIMEOUT_MS = 60 * 1000;

export function ensureProjectDir(queuesDir: string, project: string): void {
  mkdirSync(join(queuesDir, project), { recursive: true });
}

export function sessionPath(queuesDir: string, project: string, sessionId: string): string {
  return join(queuesDir, project, `${sessionId}.json`);
}

export function readSession(queuesDir: string, project: string, sessionId: string): SessionQueue | null {
  try {
    return JSON.parse(readFileSync(sessionPath(queuesDir, project, sessionId), 'utf-8')) as SessionQueue;
  } catch {
    return null;
  }
}

export function writeSession(queuesDir: string, project: string, session: SessionQueue): void {
  ensureProjectDir(queuesDir, project);
  const filePath = sessionPath(queuesDir, project, session.sessionId);
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(session, null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

export function withComputedStatus(session: SessionQueue): SessionQueue & { status: SessionStatus } {
  const hasRunningPrompt = session.prompts.some(p => p.status === 'running');
  const lastActivity = new Date(session.lastActivity).getTime();
  const isStale = Date.now() - lastActivity > SESSION_TIMEOUT_MS;
  const status: SessionStatus = (hasRunningPrompt || !isStale) ? 'active' : 'idle';
  return { ...session, status };
}

export function loadProjectView(project: string, dirPath: string): ProjectView | null {
  let files: string[];
  try {
    files = readdirSync(dirPath).filter(f => f.endsWith('.json'));
  } catch {
    return null;
  }

  const sessions = files
    .map(f => {
      try {
        const raw = JSON.parse(readFileSync(join(dirPath, f), 'utf-8')) as SessionQueue;
        return withComputedStatus(raw);
      } catch { return null; }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  if (sessions.length === 0) return null;

  const hasPrompts = sessions.some(s => s.prompts.length > 0);
  const allCompleted = hasPrompts && sessions.every(s =>
    s.prompts.length > 0 && s.prompts.every(p => p.status === 'completed')
  );
  const queueStatus: QueueStatus = allCompleted ? 'completed' : hasPrompts ? 'active' : 'empty';

  return { project, directory: sessions[0].directory, sessions, queueStatus };
}

export function listProjects(queuesDir: string): ProjectView[] {
  mkdirSync(queuesDir, { recursive: true });

  return readdirSync(queuesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(dir => loadProjectView(dir.name, join(queuesDir, dir.name)))
    .filter((p): p is NonNullable<typeof p> => p !== null);
}

export function getProject(queuesDir: string, project: string): ProjectView | null {
  return loadProjectView(project, join(queuesDir, project));
}

export function deleteProject(queuesDir: string, project: string): void {
  rmSync(join(queuesDir, project), { recursive: true });
}

export function deleteSession(queuesDir: string, project: string, sessionId: string): void {
  unlinkSync(sessionPath(queuesDir, project, sessionId));
}

export function addPrompt(session: SessionQueue, id: string, text: string): Prompt {
  const prompt: Prompt = {
    id,
    text,
    status: 'pending',
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  session.prompts.push(prompt);
  return prompt;
}

export function updatePrompt(
  session: SessionQueue,
  promptId: string,
  updates: { text?: string; status?: PromptStatus },
): Prompt | null {
  const prompt = session.prompts.find(p => p.id === promptId);
  if (!prompt) return null;
  if (updates.text !== undefined) prompt.text = updates.text;
  if (updates.status !== undefined) {
    const valid: PromptStatus[] = ['pending', 'running', 'completed'];
    if (!valid.includes(updates.status)) return null;
    prompt.status = updates.status;
    if (updates.status === 'completed') {
      prompt.completedAt = new Date().toISOString();
    }
  }
  return prompt;
}

export function deletePrompt(session: SessionQueue, promptId: string): Prompt | null {
  const idx = session.prompts.findIndex(p => p.id === promptId);
  if (idx === -1) return null;
  return session.prompts.splice(idx, 1)[0];
}

export function reorderPrompts(session: SessionQueue, order: string[]): string | null {
  const promptMap = new Map(session.prompts.map(p => [p.id, p]));
  for (const id of order) {
    if (!promptMap.has(id)) return `Prompt "${id}" not found`;
  }

  const reordered: Prompt[] = [];
  for (const id of order) {
    reordered.push(promptMap.get(id)!);
  }
  const orderSet = new Set(order);
  for (const p of session.prompts) {
    if (!orderSet.has(p.id)) reordered.push(p);
  }

  session.prompts = reordered;
  return null;
}
```

**Step 2: Update `vite-plugin-api.ts` to import from queue-store**

Replace all extracted function definitions with imports:
```ts
import {
  readSession, writeSession, sessionPath,
  withComputedStatus, listProjects, getProject,
  addPrompt, updatePrompt, deletePrompt, reorderPrompts,
  deleteProject as removeProject, deleteSession as removeSession,
} from './src/backend/queue-store.ts';
```

Keep the hardcoded `QUEUES_DIR` constant and pass it to each function call:
```ts
const QUEUES_DIR = join(homedir(), '.promptline', 'queues');
```

Update every call site to pass `QUEUES_DIR` as first argument. The SSE, HTTP parsing, and Vite plugin code stays in `vite-plugin-api.ts`.

**Step 3: Update `tsconfig.node.json`**

Add `src/backend/queue-store.ts` and `src/types/queue.ts` to the include array:
```json
"include": ["vite.config.ts", "vite-plugin-api.ts", "src/backend/**/*.ts", "src/types/**/*.ts"]
```

**Step 4: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/backend/queue-store.ts vite-plugin-api.ts tsconfig.node.json
git commit -m "refactor: extract queue-store module for testability"
```

---

### Task 3: Create test helpers and session factory

**Files:**
- Create: `tests/backend/helpers.ts`

**Step 1: Create helpers with tmpdir management and factory**

```ts
import { mkdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionQueue, Prompt } from '../../src/types/queue.ts';

export function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'promptline-test-'));
}

export function removeTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

let counter = 0;

export function makeSession(overrides: Partial<SessionQueue> = {}): SessionQueue {
  counter++;
  return {
    sessionId: `session-${counter}`,
    project: 'test-project',
    directory: '/tmp/test-project',
    sessionName: `Test Session ${counter}`,
    prompts: [],
    startedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    currentPromptId: null,
    completedAt: null,
    ...overrides,
  };
}

export function makePrompt(overrides: Partial<Prompt> = {}): Prompt {
  counter++;
  return {
    id: `prompt-${counter}`,
    text: `Test prompt ${counter}`,
    status: 'pending',
    createdAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}
```

**Step 2: Commit**

```bash
git add tests/backend/helpers.ts
git commit -m "test: add test helpers with tmpdir and session factory"
```

---

### Task 4: Write CRUD tests

**Files:**
- Create: `tests/backend/api-crud.test.ts`

**Step 1: Write tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readSession, writeSession, listProjects, getProject,
  deleteProject, deleteSession, addPrompt, updatePrompt, deletePrompt,
} from '../../src/backend/queue-store.ts';
import { createTmpDir, removeTmpDir, makeSession, makePrompt } from './helpers.ts';

let queuesDir: string;

beforeEach(() => { queuesDir = createTmpDir(); });
afterEach(() => { removeTmpDir(queuesDir); });

describe('writeSession / readSession', () => {
  it('writes and reads back a session', () => {
    const session = makeSession({ project: 'myproj' });
    writeSession(queuesDir, 'myproj', session);
    const read = readSession(queuesDir, 'myproj', session.sessionId);
    expect(read).toEqual(session);
  });

  it('creates project directory if missing', () => {
    const session = makeSession({ project: 'newproj' });
    writeSession(queuesDir, 'newproj', session);
    expect(existsSync(join(queuesDir, 'newproj'))).toBe(true);
  });

  it('returns null for non-existent session', () => {
    expect(readSession(queuesDir, 'nope', 'nope')).toBeNull();
  });
});

describe('listProjects', () => {
  it('returns empty array when no projects', () => {
    expect(listProjects(queuesDir)).toEqual([]);
  });

  it('returns projects with sessions', () => {
    const s = makeSession({ project: 'proj1' });
    writeSession(queuesDir, 'proj1', s);
    const projects = listProjects(queuesDir);
    expect(projects).toHaveLength(1);
    expect(projects[0].project).toBe('proj1');
  });

  it('returns multiple projects', () => {
    writeSession(queuesDir, 'a', makeSession({ project: 'a' }));
    writeSession(queuesDir, 'b', makeSession({ project: 'b' }));
    expect(listProjects(queuesDir)).toHaveLength(2);
  });
});

describe('getProject', () => {
  it('returns project view', () => {
    const s = makeSession({ project: 'proj1' });
    writeSession(queuesDir, 'proj1', s);
    const pv = getProject(queuesDir, 'proj1');
    expect(pv).not.toBeNull();
    expect(pv!.project).toBe('proj1');
    expect(pv!.sessions).toHaveLength(1);
  });

  it('returns null for non-existent project', () => {
    expect(getProject(queuesDir, 'nope')).toBeNull();
  });
});

describe('deleteProject', () => {
  it('removes project directory', () => {
    writeSession(queuesDir, 'proj1', makeSession({ project: 'proj1' }));
    deleteProject(queuesDir, 'proj1');
    expect(existsSync(join(queuesDir, 'proj1'))).toBe(false);
  });
});

describe('deleteSession', () => {
  it('removes session file', () => {
    const s = makeSession({ project: 'proj1' });
    writeSession(queuesDir, 'proj1', s);
    deleteSession(queuesDir, 'proj1', s.sessionId);
    expect(readSession(queuesDir, 'proj1', s.sessionId)).toBeNull();
  });
});

describe('addPrompt', () => {
  it('appends prompt to session', () => {
    const s = makeSession();
    const p = addPrompt(s, 'p1', 'do something');
    expect(s.prompts).toHaveLength(1);
    expect(p.id).toBe('p1');
    expect(p.status).toBe('pending');
    expect(p.text).toBe('do something');
  });
});

describe('updatePrompt', () => {
  it('updates text', () => {
    const s = makeSession({ prompts: [makePrompt({ id: 'p1', text: 'old' })] });
    const updated = updatePrompt(s, 'p1', { text: 'new' });
    expect(updated!.text).toBe('new');
  });

  it('updates status to completed and sets completedAt', () => {
    const s = makeSession({ prompts: [makePrompt({ id: 'p1' })] });
    const updated = updatePrompt(s, 'p1', { status: 'completed' });
    expect(updated!.status).toBe('completed');
    expect(updated!.completedAt).not.toBeNull();
  });

  it('returns null for non-existent prompt', () => {
    const s = makeSession();
    expect(updatePrompt(s, 'nope', { text: 'x' })).toBeNull();
  });
});

describe('deletePrompt', () => {
  it('removes prompt from session', () => {
    const s = makeSession({ prompts: [makePrompt({ id: 'p1' }), makePrompt({ id: 'p2' })] });
    const removed = deletePrompt(s, 'p1');
    expect(removed!.id).toBe('p1');
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0].id).toBe('p2');
  });

  it('returns null for non-existent prompt', () => {
    const s = makeSession();
    expect(deletePrompt(s, 'nope')).toBeNull();
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/backend/api-crud.test.ts`
Expected: All PASS

**Step 3: Commit**

```bash
git add tests/backend/api-crud.test.ts
git commit -m "test: add CRUD tests for queue-store"
```

---

### Task 5: Write status computation tests

**Files:**
- Create: `tests/backend/api-status.test.ts`

**Step 1: Write tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withComputedStatus, listProjects, writeSession } from '../../src/backend/queue-store.ts';
import { createTmpDir, removeTmpDir, makeSession, makePrompt } from './helpers.ts';

let queuesDir: string;

beforeEach(() => { queuesDir = createTmpDir(); });
afterEach(() => { removeTmpDir(queuesDir); });

describe('withComputedStatus', () => {
  it('session with running prompt is active', () => {
    const s = makeSession({
      prompts: [makePrompt({ status: 'running' })],
    });
    expect(withComputedStatus(s).status).toBe('active');
  });

  it('session with recent activity is active', () => {
    const s = makeSession({
      lastActivity: new Date().toISOString(),
    });
    expect(withComputedStatus(s).status).toBe('active');
  });

  it('session with stale activity and no running prompt is idle', () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const s = makeSession({
      lastActivity: twoMinutesAgo,
      prompts: [makePrompt({ status: 'completed' })],
    });
    expect(withComputedStatus(s).status).toBe('idle');
  });

  it('stale session with running prompt is still active', () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const s = makeSession({
      lastActivity: twoMinutesAgo,
      prompts: [makePrompt({ status: 'running' })],
    });
    expect(withComputedStatus(s).status).toBe('active');
  });
});

describe('queueStatus computation', () => {
  it('project with no prompts has empty status', () => {
    writeSession(queuesDir, 'proj', makeSession({ project: 'proj', prompts: [] }));
    const projects = listProjects(queuesDir);
    expect(projects[0].queueStatus).toBe('empty');
  });

  it('project with pending prompts has active status', () => {
    writeSession(queuesDir, 'proj', makeSession({
      project: 'proj',
      prompts: [makePrompt({ status: 'pending' })],
    }));
    const projects = listProjects(queuesDir);
    expect(projects[0].queueStatus).toBe('active');
  });

  it('project with all completed prompts has completed status', () => {
    writeSession(queuesDir, 'proj', makeSession({
      project: 'proj',
      prompts: [makePrompt({ status: 'completed', completedAt: new Date().toISOString() })],
    }));
    const projects = listProjects(queuesDir);
    expect(projects[0].queueStatus).toBe('completed');
  });

  it('project with mixed statuses has active status', () => {
    writeSession(queuesDir, 'proj', makeSession({
      project: 'proj',
      prompts: [
        makePrompt({ status: 'completed', completedAt: new Date().toISOString() }),
        makePrompt({ status: 'pending' }),
      ],
    }));
    const projects = listProjects(queuesDir);
    expect(projects[0].queueStatus).toBe('active');
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/backend/api-status.test.ts`
Expected: All PASS

**Step 3: Commit**

```bash
git add tests/backend/api-status.test.ts
git commit -m "test: add status computation tests"
```

---

### Task 6: Write reorder tests

**Files:**
- Create: `tests/backend/api-reorder.test.ts`

**Step 1: Write tests**

```ts
import { describe, it, expect } from 'vitest';
import { reorderPrompts } from '../../src/backend/queue-store.ts';
import { makeSession, makePrompt } from './helpers.ts';

describe('reorderPrompts', () => {
  it('reorders prompts by given order', () => {
    const s = makeSession({
      prompts: [
        makePrompt({ id: 'a', text: 'first' }),
        makePrompt({ id: 'b', text: 'second' }),
        makePrompt({ id: 'c', text: 'third' }),
      ],
    });
    const err = reorderPrompts(s, ['c', 'a', 'b']);
    expect(err).toBeNull();
    expect(s.prompts.map(p => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('appends prompts not in order array at the end', () => {
    const s = makeSession({
      prompts: [
        makePrompt({ id: 'a' }),
        makePrompt({ id: 'b' }),
        makePrompt({ id: 'c' }),
      ],
    });
    const err = reorderPrompts(s, ['b']);
    expect(err).toBeNull();
    expect(s.prompts.map(p => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('returns error for unknown prompt ID', () => {
    const s = makeSession({
      prompts: [makePrompt({ id: 'a' })],
    });
    const err = reorderPrompts(s, ['a', 'z']);
    expect(err).toContain('"z"');
  });

  it('handles empty order array', () => {
    const s = makeSession({
      prompts: [makePrompt({ id: 'a' }), makePrompt({ id: 'b' })],
    });
    const err = reorderPrompts(s, []);
    expect(err).toBeNull();
    expect(s.prompts.map(p => p.id)).toEqual(['a', 'b']);
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/backend/api-reorder.test.ts`
Expected: All PASS

**Step 3: Commit**

```bash
git add tests/backend/api-reorder.test.ts
git commit -m "test: add prompt reorder tests"
```

---

### Task 7: Write error/edge-case tests

**Files:**
- Create: `tests/backend/api-errors.test.ts`

**Step 1: Write tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  readSession, writeSession, loadProjectView, deleteProject, deleteSession, updatePrompt,
} from '../../src/backend/queue-store.ts';
import { createTmpDir, removeTmpDir, makeSession, makePrompt } from './helpers.ts';

let queuesDir: string;

beforeEach(() => { queuesDir = createTmpDir(); });
afterEach(() => { removeTmpDir(queuesDir); });

describe('error handling', () => {
  it('readSession returns null for corrupted JSON', () => {
    const project = 'proj';
    mkdirSync(join(queuesDir, project), { recursive: true });
    writeFileSync(join(queuesDir, project, 'bad.json'), 'not json');
    expect(readSession(queuesDir, project, 'bad')).toBeNull();
  });

  it('loadProjectView returns null for non-existent directory', () => {
    expect(loadProjectView('nope', join(queuesDir, 'nope'))).toBeNull();
  });

  it('loadProjectView skips corrupted session files', () => {
    const project = 'proj';
    const dirPath = join(queuesDir, project);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, 'bad.json'), '{invalid');
    const good = makeSession({ project });
    writeSession(queuesDir, project, good);
    const view = loadProjectView(project, dirPath);
    expect(view).not.toBeNull();
    expect(view!.sessions).toHaveLength(1);
  });

  it('deleteProject throws for non-existent project', () => {
    expect(() => deleteProject(queuesDir, 'nope')).toThrow();
  });

  it('deleteSession throws for non-existent session', () => {
    expect(() => deleteSession(queuesDir, 'proj', 'nope')).toThrow();
  });

  it('updatePrompt returns null for invalid status', () => {
    const s = makeSession({ prompts: [makePrompt({ id: 'p1' })] });
    const result = updatePrompt(s, 'p1', { status: 'invalid' as any });
    expect(result).toBeNull();
  });

  it('atomic write does not leave tmp files on success', () => {
    const session = makeSession({ project: 'proj' });
    writeSession(queuesDir, 'proj', session);
    const { readdirSync } = require('node:fs');
    const files = readdirSync(join(queuesDir, 'proj'));
    const tmpFiles = files.filter((f: string) => f.includes('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/backend/api-errors.test.ts`
Expected: All PASS

**Step 3: Commit**

```bash
git add tests/backend/api-errors.test.ts
git commit -m "test: add error handling and edge case tests"
```

---

### Task 8: Write session-register hook tests

**Files:**
- Create: `tests/hooks/session-register.test.ts`

**Step 1: Write tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpDir, removeTmpDir } from '../backend/helpers.ts';

const HOOK_PATH = join(process.cwd(), 'session-register.sh');

let homeDir: string;

beforeEach(() => { homeDir = createTmpDir(); });
afterEach(() => { removeTmpDir(homeDir); });

function runHook(input: Record<string, unknown>): string {
  return execSync(`bash "${HOOK_PATH}"`, {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, HOME: homeDir },
    timeout: 10_000,
  });
}

describe('session-register.sh', () => {
  it('creates queue file with correct structure', () => {
    runHook({
      session_id: 'ses-1',
      cwd: '/home/user/myproject',
      transcript_path: '',
    });

    const queueFile = join(homeDir, '.promptline', 'queues', 'myproject', 'ses-1.json');
    expect(existsSync(queueFile)).toBe(true);

    const data = JSON.parse(readFileSync(queueFile, 'utf-8'));
    expect(data.sessionId).toBe('ses-1');
    expect(data.project).toBe('myproject');
    expect(data.directory).toBe('/home/user/myproject');
    expect(data.prompts).toEqual([]);
    expect(data.currentPromptId).toBeNull();
    expect(data.completedAt).toBeNull();
  });

  it('derives project name from cwd basename', () => {
    runHook({
      session_id: 'ses-2',
      cwd: '/deep/nested/path/cool-project',
      transcript_path: '',
    });

    const queueFile = join(homeDir, '.promptline', 'queues', 'cool-project', 'ses-2.json');
    expect(existsSync(queueFile)).toBe(true);
  });

  it('updates lastActivity on existing session', () => {
    const project = 'proj';
    const queueDir = join(homeDir, '.promptline', 'queues', project);
    mkdirSync(queueDir, { recursive: true });
    const oldDate = '2025-01-01T00:00:00.000Z';
    writeFileSync(join(queueDir, 'ses-3.json'), JSON.stringify({
      sessionId: 'ses-3',
      project,
      directory: '/tmp/proj',
      sessionName: null,
      prompts: [],
      startedAt: oldDate,
      lastActivity: oldDate,
      currentPromptId: null,
      completedAt: null,
    }));

    runHook({ session_id: 'ses-3', cwd: '/tmp/proj', transcript_path: '' });

    const data = JSON.parse(readFileSync(join(queueDir, 'ses-3.json'), 'utf-8'));
    expect(data.lastActivity).not.toBe(oldDate);
    expect(data.startedAt).toBe(oldDate);
  });

  it('extracts session name from transcript', () => {
    const transcriptPath = join(homeDir, 'transcript.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({
      type: 'user',
      message: { content: 'Fix the login bug' },
    }) + '\n');

    runHook({
      session_id: 'ses-4',
      cwd: '/tmp/proj',
      transcript_path: transcriptPath,
    });

    const queueFile = join(homeDir, '.promptline', 'queues', 'proj', 'ses-4.json');
    const data = JSON.parse(readFileSync(queueFile, 'utf-8'));
    expect(data.sessionName).toBe('Fix the login bug');
  });

  it('exits 0 when cwd is empty', () => {
    const output = runHook({ session_id: 'ses-5', cwd: '', transcript_path: '' });
    expect(output).toBe('');
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/hooks/session-register.test.ts`
Expected: All PASS

**Step 3: Commit**

```bash
git add tests/hooks/session-register.test.ts
git commit -m "test: add session-register hook tests"
```

---

### Task 9: Write prompt-queue hook tests

**Files:**
- Create: `tests/hooks/prompt-queue.test.ts`

**Step 1: Write tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpDir, removeTmpDir } from '../backend/helpers.ts';

const HOOK_PATH = join(process.cwd(), 'prompt-queue.sh');

let homeDir: string;

beforeEach(() => { homeDir = createTmpDir(); });
afterEach(() => { removeTmpDir(homeDir); });

function writeQueueFile(project: string, sessionId: string, data: Record<string, unknown>): string {
  const dir = join(homeDir, '.promptline', 'queues', project);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.json`);
  writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

function readQueueFile(project: string, sessionId: string): Record<string, unknown> {
  const filePath = join(homeDir, '.promptline', 'queues', project, `${sessionId}.json`);
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function runHook(input: Record<string, unknown>): string {
  return execSync(`bash "${HOOK_PATH}"`, {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, HOME: homeDir },
    timeout: 10_000,
  });
}

describe('prompt-queue.sh', () => {
  it('exits 0 with no output when no pending prompts', () => {
    writeQueueFile('proj', 'ses-1', {
      sessionId: 'ses-1', project: 'proj', directory: '/tmp/proj',
      sessionName: null, prompts: [], startedAt: '2025-01-01T00:00:00Z',
      lastActivity: '2025-01-01T00:00:00Z', currentPromptId: null, completedAt: null,
    });

    const output = runHook({
      session_id: 'ses-1', cwd: '/tmp/proj', transcript_path: '', stop_hook_active: false,
    });
    expect(output.trim()).toBe('');
  });

  it('outputs decision JSON when pending prompts exist', () => {
    writeQueueFile('proj', 'ses-1', {
      sessionId: 'ses-1', project: 'proj', directory: '/tmp/proj',
      sessionName: null, startedAt: '2025-01-01T00:00:00Z',
      lastActivity: '2025-01-01T00:00:00Z', currentPromptId: null, completedAt: null,
      prompts: [
        { id: 'p1', text: 'Do task one', status: 'pending', createdAt: '2025-01-01T00:00:00Z', completedAt: null },
      ],
    });

    const output = runHook({
      session_id: 'ses-1', cwd: '/tmp/proj', transcript_path: '', stop_hook_active: false,
    });
    const decision = JSON.parse(output.trim());
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Do task one');
  });

  it('marks running prompt as completed and advances to next', () => {
    writeQueueFile('proj', 'ses-1', {
      sessionId: 'ses-1', project: 'proj', directory: '/tmp/proj',
      sessionName: null, startedAt: '2025-01-01T00:00:00Z',
      lastActivity: '2025-01-01T00:00:00Z', currentPromptId: 'p1', completedAt: null,
      prompts: [
        { id: 'p1', text: 'First', status: 'running', createdAt: '2025-01-01T00:00:00Z', completedAt: null },
        { id: 'p2', text: 'Second', status: 'pending', createdAt: '2025-01-01T00:00:00Z', completedAt: null },
      ],
    });

    const output = runHook({
      session_id: 'ses-1', cwd: '/tmp/proj', transcript_path: '', stop_hook_active: true,
    });

    const decision = JSON.parse(output.trim());
    expect(decision.reason).toContain('Second');

    const data = readQueueFile('proj', 'ses-1');
    const prompts = data.prompts as any[];
    expect(prompts[0].status).toBe('completed');
    expect(prompts[0].completedAt).not.toBeNull();
    expect(prompts[1].status).toBe('running');
  });

  it('stops when all prompts are completed', () => {
    writeQueueFile('proj', 'ses-1', {
      sessionId: 'ses-1', project: 'proj', directory: '/tmp/proj',
      sessionName: null, startedAt: '2025-01-01T00:00:00Z',
      lastActivity: '2025-01-01T00:00:00Z', currentPromptId: 'p1', completedAt: null,
      prompts: [
        { id: 'p1', text: 'Only one', status: 'running', createdAt: '2025-01-01T00:00:00Z', completedAt: null },
      ],
    });

    const output = runHook({
      session_id: 'ses-1', cwd: '/tmp/proj', transcript_path: '', stop_hook_active: true,
    });
    expect(output.trim()).toBe('');

    const data = readQueueFile('proj', 'ses-1');
    const prompts = data.prompts as any[];
    expect(prompts[0].status).toBe('completed');
    expect(data.completedAt).not.toBeNull();
  });

  it('exits 0 when no session file exists', () => {
    const output = runHook({
      session_id: 'nonexistent', cwd: '/tmp/proj', transcript_path: '', stop_hook_active: false,
    });
    expect(output.trim()).toBe('');
  });

  it('exits 0 when cwd is empty', () => {
    const output = runHook({
      session_id: 'ses-1', cwd: '', transcript_path: '', stop_hook_active: false,
    });
    expect(output.trim()).toBe('');
  });

  it('shows remaining queued count in reason', () => {
    writeQueueFile('proj', 'ses-1', {
      sessionId: 'ses-1', project: 'proj', directory: '/tmp/proj',
      sessionName: null, startedAt: '2025-01-01T00:00:00Z',
      lastActivity: '2025-01-01T00:00:00Z', currentPromptId: null, completedAt: null,
      prompts: [
        { id: 'p1', text: 'First', status: 'pending', createdAt: '2025-01-01T00:00:00Z', completedAt: null },
        { id: 'p2', text: 'Second', status: 'pending', createdAt: '2025-01-01T00:00:00Z', completedAt: null },
        { id: 'p3', text: 'Third', status: 'pending', createdAt: '2025-01-01T00:00:00Z', completedAt: null },
      ],
    });

    const output = runHook({
      session_id: 'ses-1', cwd: '/tmp/proj', transcript_path: '', stop_hook_active: false,
    });
    const decision = JSON.parse(output.trim());
    expect(decision.reason).toContain('2 queued');
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/hooks/prompt-queue.test.ts`
Expected: All PASS

**Step 3: Commit**

```bash
git add tests/hooks/prompt-queue.test.ts
git commit -m "test: add prompt-queue hook tests"
```

---

### Task 10: Final verification

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Final commit (if any remaining changes)**

```bash
git add -A
git commit -m "test: complete test suite for backend and hooks"
```
