import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionQueue, Prompt, PromptStatus, SessionStatus, QueueStatus, ProjectView, SessionWithStatus } from '../types/queue.ts';

export const SESSION_ACTIVE_TIMEOUT_MS = 60_000;
export const SESSION_VISIBLE_TIMEOUT_MS = 5 * SESSION_ACTIVE_TIMEOUT_MS;

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

function msSinceLastActivity(session: SessionQueue, now: number = Date.now()): number {
  return now - new Date(session.lastActivity).getTime();
}

function hasPendingWork(session: SessionQueue): boolean {
  return session.prompts.some(p => p.status === 'pending' || p.status === 'running');
}

export function withComputedStatus(session: SessionQueue): SessionQueue & { status: SessionStatus } {
  const hasRunningPrompt = session.prompts.some(p => p.status === 'running');
  const isStale = msSinceLastActivity(session) > SESSION_ACTIVE_TIMEOUT_MS;
  const status: SessionStatus = (hasRunningPrompt || !isStale) ? 'active' : 'idle';
  return { ...session, status };
}

export function isSessionVisible(session: SessionQueue, now: number = Date.now()): boolean {
  if (hasPendingWork(session)) return true;
  if (session.closedAt != null) return false;
  return msSinceLastActivity(session, now) <= SESSION_VISIBLE_TIMEOUT_MS;
}

export function loadProjectView(queuesDir: string, project: string): ProjectView | null {
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
    s.prompts.length > 0 && s.prompts.every(p => p.status === 'completed')
  );
  const queueStatus: QueueStatus = allCompleted ? 'completed' : hasPrompts ? 'active' : 'empty';

  return { project, directory: sessions[0].directory, sessions, queueStatus };
}

export function listProjects(queuesDir: string): ProjectView[] {
  try {
    return readdirSync(queuesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(dir => loadProjectView(queuesDir, dir.name))
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
    if (updates.status === 'completed') {
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
