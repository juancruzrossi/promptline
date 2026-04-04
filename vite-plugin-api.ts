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
  clearPrompts,
  reorderPrompts,
  withSessionLock,
} from './src/backend/queue-store.ts';

const QUEUES_DIR = join(homedir(), '.promptline', 'queues');
const MAX_BODY_BYTES = 1_000_000;

export function isSafeSegment(s: string): boolean {
  return s.length > 0 && !s.includes('/') && !s.includes('\\') && !s.includes('..');
}

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
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

// --- Route helpers ---

interface RouteParams {
  project: string;
  sessionId: string;
  promptId: string;
}

type RouteHandler = (params: RouteParams, req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

interface Route {
  method: string;
  pattern: string[];
  handler: RouteHandler;
}

function matchRoute(
  segments: string[],
  method: string,
  routes: Route[],
): { handler: RouteHandler; params: RouteParams } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.pattern.length !== segments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;

    for (let i = 0; i < route.pattern.length; i++) {
      if (route.pattern[i].startsWith(':')) {
        params[route.pattern[i].slice(1)] = segments[i];
      } else if (route.pattern[i] !== segments[i]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return { handler: route.handler, params: params as unknown as RouteParams };
    }
  }
  return null;
}

function withSession(
  params: RouteParams,
  res: ServerResponse,
  fn: (session: ReturnType<typeof readSession> & object) => void,
): void {
  return withSessionLock(QUEUES_DIR, params.project, params.sessionId, () => {
    const session = readSession(QUEUES_DIR, params.project, params.sessionId);
    if (!session) return jsonError(res, 404, 'Session not found');
    fn(session);
  });
}

// --- Route definitions ---

const routes: Route[] = [
  // GET /api/projects
  {
    method: 'GET',
    pattern: ['projects'],
    handler: (_params, _req, res) => {
      json(res, 200, listProjects(QUEUES_DIR));
    },
  },

  // GET /api/projects/:project
  {
    method: 'GET',
    pattern: ['projects', ':project'],
    handler: (params, _req, res) => {
      const pv = getProject(QUEUES_DIR, params.project);
      if (!pv) return jsonError(res, 404, `Project "${params.project}" not found`);
      json(res, 200, pv);
    },
  },

  // DELETE /api/projects/:project
  {
    method: 'DELETE',
    pattern: ['projects', ':project'],
    handler: (params, _req, res) => {
      try {
        deleteProject(QUEUES_DIR, params.project);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return jsonError(res, 404, `Project "${params.project}" not found`);
        }
        throw err;
      }
      json(res, 200, { deleted: params.project });
    },
  },

  // GET /api/projects/:project/sessions/:sessionId
  {
    method: 'GET',
    pattern: ['projects', ':project', 'sessions', ':sessionId'],
    handler: (params, _req, res) => {
      const session = readSession(QUEUES_DIR, params.project, params.sessionId);
      if (!session) return jsonError(res, 404, 'Session not found');
      json(res, 200, withComputedStatus(session));
    },
  },

  // DELETE /api/projects/:project/sessions/:sessionId
  {
    method: 'DELETE',
    pattern: ['projects', ':project', 'sessions', ':sessionId'],
    handler: (params, _req, res) => {
      try {
        deleteSession(QUEUES_DIR, params.project, params.sessionId);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return jsonError(res, 404, 'Session not found');
        }
        throw err;
      }
      json(res, 200, { deleted: params.sessionId });
    },
  },

  // PUT /api/projects/:project/sessions/:sessionId/prompts/reorder
  {
    method: 'PUT',
    pattern: ['projects', ':project', 'sessions', ':sessionId', 'prompts', 'reorder'],
    handler: async (params, req, res) => {
      const body = await parseBody(req);
      const order = body.order as string[] | undefined;
      if (!Array.isArray(order)) {
        return jsonError(res, 400, 'Field "order" (string[]) is required');
      }

      withSession(params, res, (session) => {
        const error = reorderPrompts(session, order);
        if (error) return jsonError(res, 400, error);
        writeSession(QUEUES_DIR, params.project, session);
        json(res, 200, session);
      });
    },
  },

  // PATCH /api/projects/:project/sessions/:sessionId/prompts/:promptId
  {
    method: 'PATCH',
    pattern: ['projects', ':project', 'sessions', ':sessionId', 'prompts', ':promptId'],
    handler: async (params, req, res) => {
      const body = await parseBody(req);
      const updates: { text?: string; status?: PromptStatus } = {};

      if (body.text !== undefined) {
        updates.text = body.text as string;
      }
      if (body.status !== undefined) {
        const validStatuses: PromptStatus[] = ['pending', 'running', 'completed', 'cancelled'];
        if (!validStatuses.includes(body.status as PromptStatus)) {
          return jsonError(res, 400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        }
        updates.status = body.status as PromptStatus;
      }

      withSession(params, res, (session) => {
        const updated = updatePrompt(session, params.promptId, updates);
        if (!updated) return jsonError(res, 404, `Prompt "${params.promptId}" not found`);
        writeSession(QUEUES_DIR, params.project, session);
        json(res, 200, updated);
      });
    },
  },

  // DELETE /api/projects/:project/sessions/:sessionId/prompts/:promptId
  {
    method: 'DELETE',
    pattern: ['projects', ':project', 'sessions', ':sessionId', 'prompts', ':promptId'],
    handler: (params, _req, res) => {
      withSession(params, res, (session) => {
        const removed = deletePrompt(session, params.promptId);
        if (!removed) return jsonError(res, 404, `Prompt "${params.promptId}" not found`);
        writeSession(QUEUES_DIR, params.project, session);
        json(res, 200, removed);
      });
    },
  },

  // DELETE /api/projects/:project/sessions/:sessionId/prompts
  {
    method: 'DELETE',
    pattern: ['projects', ':project', 'sessions', ':sessionId', 'prompts'],
    handler: (params, _req, res) => {
      withSession(params, res, (session) => {
        const removed = clearPrompts(session);
        writeSession(QUEUES_DIR, params.project, session);
        json(res, 200, { cleared: removed.length });
      });
    },
  },

  // POST /api/projects/:project/sessions/:sessionId/prompts
  {
    method: 'POST',
    pattern: ['projects', ':project', 'sessions', ':sessionId', 'prompts'],
    handler: async (params, req, res) => {
      const body = await parseBody(req);
      if (!body.text || typeof body.text !== 'string') {
        return jsonError(res, 400, 'Field "text" (string) is required');
      }

      withSession(params, res, (session) => {
        const prompt = addPrompt(session, uuidv4(), body.text as string);
        writeSession(QUEUES_DIR, params.project, session);
        json(res, 201, prompt);
      });
    },
  },
];

// --- Plugin ---

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

        if (url === '/api/events' && method === 'GET') {
          handleSSE(req, res);
          return;
        }

        const segments = url.replace(/^\/api\//, '').split('/').map(decodeURIComponent);

        if (!segments.every(isSafeSegment)) {
          jsonError(res, 400, 'Invalid path segment');
          return;
        }

        const match = matchRoute(segments, method, routes);
        if (!match) {
          jsonError(res, 404, 'Not found');
          return;
        }

        Promise.resolve(match.handler(match.params, req, res)).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Internal server error';
          jsonError(res, 500, message);
        });
      }) as Connect.NextHandleFunction);
    },
  };
}
