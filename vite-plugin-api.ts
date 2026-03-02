import type { Plugin, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync, rmSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import type { SessionQueue, Prompt, PromptStatus, SessionStatus, QueueStatus, ProjectView } from './src/types/queue.ts';

const QUEUES_DIR = join(homedir(), '.promptline', 'queues');

function ensureProjectDir(project: string): void {
  mkdirSync(join(QUEUES_DIR, project), { recursive: true });
}

function sessionPath(project: string, sessionId: string): string {
  return join(QUEUES_DIR, project, `${sessionId}.json`);
}

function readSession(project: string, sessionId: string): SessionQueue | null {
  try {
    return JSON.parse(readFileSync(sessionPath(project, sessionId), 'utf-8')) as SessionQueue;
  } catch {
    return null;
  }
}

function writeSession(project: string, session: SessionQueue): void {
  ensureProjectDir(project);
  const filePath = sessionPath(project, session.sessionId);
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(session, null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

const SESSION_TIMEOUT_MS = 60 * 1000; // 1 minute

function withComputedStatus(session: SessionQueue): SessionQueue & { status: SessionStatus } {
  const hasRunningPrompt = session.prompts.some(p => p.status === 'running');
  const lastActivity = new Date(session.lastActivity).getTime();
  const isStale = Date.now() - lastActivity > SESSION_TIMEOUT_MS;
  const status: SessionStatus = (hasRunningPrompt || !isStale) ? 'active' : 'idle';
  return { ...session, status };
}

function listProjects(): ProjectView[] {
  mkdirSync(QUEUES_DIR, { recursive: true });

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
        .filter((s): s is NonNullable<typeof s> => s !== null);

      if (sessions.length === 0) return null;

      const hasPrompts = sessions.some(s => s.prompts.length > 0);
      const allCompleted = hasPrompts && sessions.every(s =>
        s.prompts.length > 0 && s.prompts.every(p => p.status === 'completed')
      );
      const queueStatus: QueueStatus = allCompleted ? 'completed' : hasPrompts ? 'active' : 'empty';

      return { project, directory: sessions[0].directory, sessions, queueStatus };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
}

function getProject(project: string): ProjectView | null {
  const dirPath = join(QUEUES_DIR, project);
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

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: message });
}

// --- SSE connection manager ---
const sseClients = new Set<ServerResponse>();
let fsWatcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 200;

function broadcastProjects(): void {
  const data = JSON.stringify(listProjects());
  const message = `event: projects\ndata: ${data}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

function startWatcher(): void {
  if (fsWatcher) return;
  mkdirSync(QUEUES_DIR, { recursive: true });
  try {
    fsWatcher = watch(QUEUES_DIR, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(broadcastProjects, DEBOUNCE_MS);
    });
  } catch {
    // fs.watch not supported — SSE will work but without auto-push
  }
}

function stopWatcher(): void {
  if (fsWatcher) {
    fsWatcher.close();
    fsWatcher = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function handleSSE(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial state
  const data = JSON.stringify(listProjects());
  res.write(`event: projects\ndata: ${data}\n\n`);

  sseClients.add(res);

  res.on('close', () => {
    sseClients.delete(res);
  });
}

export default function apiPlugin(): Plugin {
  return {
    name: 'promptline-api',
    configureServer(server) {
      startWatcher();

      server.httpServer?.on('close', () => {
        stopWatcher();
        for (const client of sseClients) {
          client.end();
        }
        sseClients.clear();
      });

      server.middlewares.use(((req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
        const url = req.url ?? '';
        const method = req.method ?? 'GET';

        if (!url.startsWith('/api/')) {
          next();
          return;
        }

        // SSE endpoint
        if (url === '/api/events' && method === 'GET') {
          handleSSE(req, res);
          return;
        }

        handleApi(url, method, req, res).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Internal server error';
          jsonError(res, 500, message);
        });
      }) as Connect.NextHandleFunction);
    },
  };
}

async function handleApi(
  url: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Parse URL segments: /api/projects/:project/sessions/:sessionId/prompts/:promptId
  const segments = url.replace(/^\/api\//, '').split('/').map(decodeURIComponent);

  // GET /api/projects
  if (segments[0] === 'projects' && segments.length === 1 && method === 'GET') {
    return json(res, 200, listProjects());
  }

  // /api/projects/:project
  if (segments[0] === 'projects' && segments.length === 2) {
    const project = segments[1];

    if (method === 'GET') {
      const pv = getProject(project);
      if (!pv) return jsonError(res, 404, `Project "${project}" not found`);
      return json(res, 200, pv);
    }

    if (method === 'DELETE') {
      const dirPath = join(QUEUES_DIR, project);
      try {
        rmSync(dirPath, { recursive: true });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return jsonError(res, 404, `Project "${project}" not found`);
        }
        throw err;
      }
      return json(res, 200, { deleted: project });
    }

    return jsonError(res, 405, `Method ${method} not allowed`);
  }

  // /api/projects/:project/sessions/:sessionId
  if (segments[0] === 'projects' && segments[2] === 'sessions' && segments.length === 4) {
    const project = segments[1];
    const sessionId = segments[3];

    if (method === 'GET') {
      const session = readSession(project, sessionId);
      if (!session) return jsonError(res, 404, 'Session not found');
      return json(res, 200, withComputedStatus(session));
    }

    if (method === 'DELETE') {
      const filePath = sessionPath(project, sessionId);
      try {
        unlinkSync(filePath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return jsonError(res, 404, 'Session not found');
        }
        throw err;
      }
      return json(res, 200, { deleted: sessionId });
    }

    return jsonError(res, 405, `Method ${method} not allowed`);
  }

  // /api/projects/:project/sessions/:sessionId/prompts/reorder
  if (
    segments[0] === 'projects' && segments[2] === 'sessions' &&
    segments[4] === 'prompts' && segments[5] === 'reorder' &&
    segments.length === 6 && method === 'PUT'
  ) {
    const project = segments[1];
    const sessionId = segments[3];
    const session = readSession(project, sessionId);
    if (!session) return jsonError(res, 404, 'Session not found');

    const body = await parseBody(req);
    const order = body.order as string[] | undefined;
    if (!Array.isArray(order)) {
      return jsonError(res, 400, 'Field "order" (string[]) is required');
    }

    const promptMap = new Map(session.prompts.map(p => [p.id, p]));
    for (const id of order) {
      if (!promptMap.has(id)) {
        return jsonError(res, 400, `Prompt "${id}" not found`);
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
    writeSession(project, session);
    return json(res, 200, session);
  }

  // /api/projects/:project/sessions/:sessionId/prompts/:promptId
  if (
    segments[0] === 'projects' && segments[2] === 'sessions' &&
    segments[4] === 'prompts' && segments.length === 6
  ) {
    const project = segments[1];
    const sessionId = segments[3];
    const promptId = segments[5];
    const session = readSession(project, sessionId);
    if (!session) return jsonError(res, 404, 'Session not found');

    if (method === 'PATCH') {
      const idx = session.prompts.findIndex(p => p.id === promptId);
      if (idx === -1) return jsonError(res, 404, `Prompt "${promptId}" not found`);

      const body = await parseBody(req);
      if (body.text !== undefined) {
        session.prompts[idx].text = body.text as string;
      }
      if (body.status !== undefined) {
        const validStatuses: PromptStatus[] = ['pending', 'running', 'completed'];
        if (!validStatuses.includes(body.status as PromptStatus)) {
          return jsonError(res, 400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        }
        session.prompts[idx].status = body.status as PromptStatus;
        if (body.status === 'completed') {
          session.prompts[idx].completedAt = new Date().toISOString();
        }
      }
      writeSession(project, session);
      return json(res, 200, session.prompts[idx]);
    }

    if (method === 'DELETE') {
      const idx = session.prompts.findIndex(p => p.id === promptId);
      if (idx === -1) return jsonError(res, 404, `Prompt "${promptId}" not found`);

      const removed = session.prompts.splice(idx, 1)[0];
      writeSession(project, session);
      return json(res, 200, removed);
    }

    return jsonError(res, 405, `Method ${method} not allowed`);
  }

  // /api/projects/:project/sessions/:sessionId/prompts
  if (
    segments[0] === 'projects' && segments[2] === 'sessions' &&
    segments[4] === 'prompts' && segments.length === 5 && method === 'POST'
  ) {
    const project = segments[1];
    const sessionId = segments[3];
    const session = readSession(project, sessionId);
    if (!session) return jsonError(res, 404, 'Session not found');

    const body = await parseBody(req);
    if (!body.text || typeof body.text !== 'string') {
      return jsonError(res, 400, 'Field "text" (string) is required');
    }

    const prompt: Prompt = {
      id: uuidv4(),
      text: body.text as string,
      status: 'pending',
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    session.prompts.push(prompt);
    writeSession(project, session);
    return json(res, 201, prompt);
  }

  return jsonError(res, 404, 'Not found');
}
