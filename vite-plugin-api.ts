import type { Plugin, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import type { PromptStatus } from './src/types/queue.ts';
import {
  listProjects,
  getProject,
  deleteProject,
  readSession,
  writeSession,
  withComputedStatus,
  deleteSession,
  addPrompt,
  updatePrompt,
  deletePrompt,
  reorderPrompts,
} from './src/backend/queue-store.ts';

const QUEUES_DIR = join(homedir(), '.promptline', 'queues');

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
  const data = JSON.stringify(listProjects(QUEUES_DIR));
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

const HEARTBEAT_MS = 25_000;

function handleSSE(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial state
  const data = JSON.stringify(listProjects(QUEUES_DIR));
  res.write(`event: projects\ndata: ${data}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);

  sseClients.add(res);

  res.on('close', () => {
    clearInterval(heartbeat);
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
    return json(res, 200, listProjects(QUEUES_DIR));
  }

  // /api/projects/:project
  if (segments[0] === 'projects' && segments.length === 2) {
    const project = segments[1];

    if (method === 'GET') {
      const pv = getProject(QUEUES_DIR, project);
      if (!pv) return jsonError(res, 404, `Project "${project}" not found`);
      return json(res, 200, pv);
    }

    if (method === 'DELETE') {
      try {
        deleteProject(QUEUES_DIR, project);
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
      const session = readSession(QUEUES_DIR, project, sessionId);
      if (!session) return jsonError(res, 404, 'Session not found');
      return json(res, 200, withComputedStatus(session));
    }

    if (method === 'DELETE') {
      try {
        deleteSession(QUEUES_DIR, project, sessionId);
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
    const session = readSession(QUEUES_DIR, project, sessionId);
    if (!session) return jsonError(res, 404, 'Session not found');

    const body = await parseBody(req);
    const order = body.order as string[] | undefined;
    if (!Array.isArray(order)) {
      return jsonError(res, 400, 'Field "order" (string[]) is required');
    }

    const error = reorderPrompts(session, order);
    if (error) return jsonError(res, 400, error);

    writeSession(QUEUES_DIR, project, session);
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
    const session = readSession(QUEUES_DIR, project, sessionId);
    if (!session) return jsonError(res, 404, 'Session not found');

    if (method === 'PATCH') {
      const body = await parseBody(req);
      const updates: { text?: string; status?: PromptStatus } = {};

      if (body.text !== undefined) {
        updates.text = body.text as string;
      }
      if (body.status !== undefined) {
        const validStatuses: PromptStatus[] = ['pending', 'running', 'completed'];
        if (!validStatuses.includes(body.status as PromptStatus)) {
          return jsonError(res, 400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        }
        updates.status = body.status as PromptStatus;
      }

      const updated = updatePrompt(session, promptId, updates);
      if (!updated) return jsonError(res, 404, `Prompt "${promptId}" not found`);

      writeSession(QUEUES_DIR, project, session);
      return json(res, 200, updated);
    }

    if (method === 'DELETE') {
      const removed = deletePrompt(session, promptId);
      if (!removed) return jsonError(res, 404, `Prompt "${promptId}" not found`);

      writeSession(QUEUES_DIR, project, session);
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
    const session = readSession(QUEUES_DIR, project, sessionId);
    if (!session) return jsonError(res, 404, 'Session not found');

    const body = await parseBody(req);
    if (!body.text || typeof body.text !== 'string') {
      return jsonError(res, 400, 'Field "text" (string) is required');
    }

    const prompt = addPrompt(session, uuidv4(), body.text as string);
    writeSession(QUEUES_DIR, project, session);
    return json(res, 201, prompt);
  }

  return jsonError(res, 404, 'Not found');
}
