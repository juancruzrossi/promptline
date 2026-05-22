import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { SessionQueue, Prompt, PromptStatus, SessionStatus, QueueStatus, ProjectView, SessionWithStatus } from '../types/queue.ts';

export const SESSION_ACTIVE_TIMEOUT_MS = 60_000;
export const SESSION_ABANDONED_TIMEOUT_MS = 24 * 60 * 60_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 3_000;
const ACTIVE_SESSION_SYNC_INTERVAL_MS = 2_000;
const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
let lastActiveSessionSync = 0;

interface ClaudeProcess {
  pid: number;
  startedAtText: string;
  sessionId: string;
  cwd: string;
}

function acquireLockSync(lockPath: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch { continue; }
      Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, LOCK_RETRY_MS);
    }
  }
  throw new Error('Timed out acquiring session lock');
}

function releaseLockSync(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

export function withSessionLock<T>(
  queuesDir: string, project: string, sessionId: string,
  fn: () => T,
): T {
  const lockPath = sessionPath(queuesDir, project, sessionId) + '.lock';
  acquireLockSync(lockPath);
  try {
    return fn();
  } finally {
    releaseLockSync(lockPath);
  }
}

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
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup error */ }
    throw err;
  }
}

function toIsoDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function parseClaudeSessionId(command: string): string | null {
  const match = command.match(/(?:^|\s)(?:--resume|-r|--session-id)\s+([0-9a-f-]{36})(?:\s|$)/i);
  if (!match || !CLAUDE_SESSION_ID_RE.test(match[1])) return null;
  return match[1];
}

function readProcessCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // macOS does not expose /proc; fall back to lsof.
  }

  try {
    const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const cwd = output
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1)
      .trim();
    return cwd || null;
  } catch {
    return null;
  }
}

function listClaudeProcesses(): ClaudeProcess[] {
  let output = '';
  try {
    output = execFileSync('ps', ['-axo', 'pid=,lstart=,command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }

  const processes: ClaudeProcess[] = [];
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7) continue;

    const command = parts.slice(6).join(' ');
    if (!/(^|\s|\/)claude(?:\s|$)/.test(command)) continue;

    const sessionId = parseClaudeSessionId(command);
    if (!sessionId) continue;

    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;

    const cwd = readProcessCwd(pid);
    if (!cwd) continue;

    processes.push({
      pid,
      startedAtText: parts.slice(1, 6).join(' '),
      sessionId,
      cwd,
    });
  }

  return processes;
}

function isSessionOwnerAlive(session: SessionQueue): boolean {
  if (!session.ownerPid) return false;
  try {
    const pid = String(session.ownerPid);
    const startedAtText = execFileSync('ps', ['-p', pid, '-o', 'lstart='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!startedAtText) return false;
    if (!session.ownerStartedAt || startedAtText === session.ownerStartedAt) return true;

    const command = execFileSync('ps', ['-p', pid, '-o', 'command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/(^|\s|\/)claude(?:\s|$)/.test(command)) return false;

    const cwd = readProcessCwd(session.ownerPid);
    return cwd === session.directory;
  } catch {
    return false;
  }
}

function findSessionFile(queuesDir: string, sessionId: string): string | null {
  try {
    for (const dir of readdirSync(queuesDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const filePath = join(queuesDir, dir.name, `${sessionId}.json`);
      if (existsSync(filePath)) return filePath;
    }
  } catch {
    return null;
  }
  return null;
}

function findClaudeTranscript(sessionId: string): string | null {
  try {
    for (const projectDir of readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;
      const transcript = join(CLAUDE_PROJECTS_DIR, projectDir.name, `${sessionId}.jsonl`);
      if (existsSync(transcript)) return transcript;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizePromptText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;

  const textPart = value.find((item) =>
    item &&
    typeof item === 'object' &&
    'type' in item &&
    item.type === 'text' &&
    'text' in item &&
    typeof item.text === 'string'
  ) as { text?: string } | undefined;

  return textPart?.text ?? null;
}

function truncateSessionName(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.startsWith('<')) return null;
  return normalized.length > 50 ? `${normalized.slice(0, 50)}...` : normalized;
}

function extractClaudeSessionName(sessionId: string): string | null {
  const transcript = findClaudeTranscript(sessionId);
  if (!transcript) return null;

  let firstUserPrompt: string | null = null;
  try {
    for (const line of readFileSync(transcript, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
        return truncateSessionName(entry.aiTitle);
      }

      if (firstUserPrompt === null && entry.type === 'user') {
        const message = entry.message as { content?: unknown } | undefined;
        const text = truncateSessionName(normalizePromptText(message?.content) ?? '');
        if (text) firstUserPrompt = text;
      }
    }
  } catch {
    return null;
  }

  return firstUserPrompt;
}

export function syncActiveClaudeSessions(queuesDir: string, force = false): void {
  const nowMs = Date.now();
  if (!force && nowMs - lastActiveSessionSync < ACTIVE_SESSION_SYNC_INTERVAL_MS) return;
  lastActiveSessionSync = nowMs;

  const now = new Date(nowMs).toISOString();
  for (const proc of listClaudeProcesses()) {
    const existingPath = findSessionFile(queuesDir, proc.sessionId);
    const project = existingPath ? basename(dirname(existingPath)) : basename(proc.cwd);
    const startedAt = toIsoDate(proc.startedAtText);

    ensureProjectDir(queuesDir, project);
    withSessionLock(queuesDir, project, proc.sessionId, () => {
      const current = readSession(queuesDir, project, proc.sessionId);
      const sessionName = current?.sessionName ?? extractClaudeSessionName(proc.sessionId);
      const next: SessionQueue = current
        ? {
            ...current,
            project,
            directory: proc.cwd,
            sessionName,
            lastActivity: now,
            closedAt: null,
            ownerPid: proc.pid,
            ownerStartedAt: proc.startedAtText,
          }
        : {
            sessionId: proc.sessionId,
            project,
            directory: proc.cwd,
            sessionName,
            prompts: [],
            startedAt,
            lastActivity: now,
            closedAt: null,
            ownerPid: proc.pid,
            ownerStartedAt: proc.startedAtText,
          };

      writeSession(queuesDir, project, next);
    });
  }
}

function msSinceLastActivity(session: SessionQueue, now: number = Date.now()): number {
  return now - new Date(session.lastActivity).getTime();
}

function hasPendingWork(session: SessionQueue): boolean {
  return session.prompts.some(p => p.status === 'pending' || p.status === 'running');
}

export function withComputedStatus(session: SessionQueue): SessionQueue & { status: SessionStatus } {
  if (session.closedAt != null) {
    return { ...session, status: 'idle' };
  }
  const hasRunningPrompt = session.prompts.some(p => p.status === 'running');
  const hasLiveOwner = isSessionOwnerAlive(session);
  const isStale = msSinceLastActivity(session) > SESSION_ACTIVE_TIMEOUT_MS;
  const status: SessionStatus = (hasRunningPrompt || hasLiveOwner || !isStale) ? 'active' : 'idle';
  return { ...session, status };
}

export function isSessionVisible(session: SessionQueue, now: number = Date.now()): boolean {
  if (session.closedAt != null) return false;
  if (hasPendingWork(session)) return true;
  const msSinceStart = now - new Date(session.startedAt).getTime();
  return msSinceStart <= SESSION_ABANDONED_TIMEOUT_MS;
}

function readProjectView(queuesDir: string, project: string): ProjectView | null {
  const dirPath = join(queuesDir, project);
  let files: string[];
  try {
    files = readdirSync(dirPath).filter(f => f.endsWith('.json'));
  } catch {
    return null;
  }

  const now = Date.now();

  const sessions = files
    .map(f => {
      const sessionId = f.replace(/\.json$/, '');
      const raw = readSession(queuesDir, project, sessionId);
      return raw ? withComputedStatus(raw) : null;
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .filter((s: SessionWithStatus) => isSessionVisible(s, now));

  if (sessions.length === 0) return null;

  const hasPrompts = sessions.some(s => s.prompts.length > 0);
  const allCompleted = hasPrompts && sessions.every(s =>
    s.prompts.length > 0 && s.prompts.every(p => p.status === 'completed' || p.status === 'cancelled')
  );
  const queueStatus: QueueStatus = allCompleted ? 'completed' : hasPrompts ? 'active' : 'empty';

  return { project, directory: sessions[0].directory, sessions, queueStatus };
}

export function loadProjectView(queuesDir: string, project: string): ProjectView | null {
  syncActiveClaudeSessions(queuesDir);
  return readProjectView(queuesDir, project);
}

export function listProjects(queuesDir: string): ProjectView[] {
  syncActiveClaudeSessions(queuesDir);

  try {
    return readdirSync(queuesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(dir => readProjectView(queuesDir, dir.name))
      .filter((p): p is NonNullable<typeof p> => p !== null);
  } catch {
    return [];
  }
}

export function getProject(queuesDir: string, project: string): ProjectView | null {
  return loadProjectView(queuesDir, project);
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
  const idx = session.prompts.findIndex(p => p.id === promptId);
  if (idx === -1) return null;

  if (updates.text !== undefined) {
    session.prompts[idx].text = updates.text;
  }
  if (updates.status !== undefined) {
    session.prompts[idx].status = updates.status;
    if (updates.status === 'completed' || updates.status === 'cancelled') {
      session.prompts[idx].completedAt = new Date().toISOString();
    }
  }

  return session.prompts[idx];
}

export function deletePrompt(session: SessionQueue, promptId: string): Prompt | null {
  const idx = session.prompts.findIndex(p => p.id === promptId);
  if (idx === -1) return null;
  return session.prompts.splice(idx, 1)[0];
}

export function clearPrompts(session: SessionQueue): Prompt[] {
  return session.prompts.splice(0);
}

export function reorderPrompts(session: SessionQueue, order: string[]): string | null {
  const promptMap = new Map(session.prompts.map(p => [p.id, p]));
  for (const id of order) {
    if (!promptMap.has(id)) {
      return `Prompt "${id}" not found`;
    }
  }

  const reordered: Prompt[] = [];
  for (const id of order) {
    reordered.push(promptMap.get(id)!);
  }
  const orderSet = new Set(order);
  for (const p of session.prompts) {
    if (!orderSet.has(p.id)) {
      reordered.push(p);
    }
  }

  session.prompts = reordered;
  return null;
}
