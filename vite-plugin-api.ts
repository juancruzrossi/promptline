import type { Plugin, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import type { ProjectQueue, Prompt, PromptStatus, QueueStatus } from './src/types/queue.ts';

const QUEUES_DIR = join(homedir(), '.promptline', 'queues');

function ensureQueuesDir(): void {
  mkdirSync(QUEUES_DIR, { recursive: true });
}

function queuePath(project: string): string {
  return join(QUEUES_DIR, `${project}.json`);
}

function readQueue(project: string): ProjectQueue | null {
  try {
    return JSON.parse(readFileSync(queuePath(project), 'utf-8')) as ProjectQueue;
  } catch {
    return null;
  }
}

function writeQueue(queue: ProjectQueue): void {
  ensureQueuesDir();
  const filePath = queuePath(queue.project);
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(queue, null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

const SESSION_TIMEOUT_MS = 60 * 1000; // 1 minute
const QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function withComputedStatus(queue: ProjectQueue): ProjectQueue & { queueStatus: QueueStatus } {
  let activeSession = queue.activeSession;
  if (activeSession) {
    const lastActivity = new Date(activeSession.lastActivity).getTime();
    const isStale = Date.now() - lastActivity > SESSION_TIMEOUT_MS;
    activeSession = { ...activeSession, status: isStale ? 'idle' : 'active' };
  }

  const hasPrompts = queue.prompts.length > 0;
  const allCompleted = hasPrompts && queue.prompts.every(p => p.status === 'completed');
  const queueStatus: QueueStatus = allCompleted ? 'completed' : hasPrompts ? 'active' : 'empty';

  return { ...queue, activeSession, queueStatus };
}

function listQueues(): (ProjectQueue & { queueStatus: QueueStatus })[] {
  ensureQueuesDir();
  const now = Date.now();
  return readdirSync(QUEUES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return withComputedStatus(JSON.parse(readFileSync(join(QUEUES_DIR, f), 'utf-8')) as ProjectQueue);
      } catch { return null; }
    })
    .filter((q): q is NonNullable<typeof q> => {
      if (!q) return false;
      // Hide completed queues older than 7 days
      if (q.queueStatus === 'completed' && q.completedAt) {
        return now - new Date(q.completedAt).getTime() < QUEUE_RETENTION_MS;
      }
      // Hide empty queues with idle/no session (no prompts + no active work = noise)
      if (q.queueStatus === 'empty') {
        const hasActiveSession = q.activeSession?.status === 'active';
        if (!hasActiveSession) return false;
      }
      return true;
    });
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

export default function apiPlugin(): Plugin {
  return {
    name: 'promptline-api',
    configureServer(server) {
      server.middlewares.use(((req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
        const url = req.url ?? '';
        const method = req.method ?? 'GET';

        if (!url.startsWith('/api/')) {
          next();
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
  // GET /api/queues - list all queues
  if (url === '/api/queues' && method === 'GET') {
    return json(res, 200, listQueues());
  }

  // Match /api/queues/:project/prompts/reorder (BEFORE generic :id route)
  const reorderMatch = url.match(/^\/api\/queues\/([^/]+)\/prompts\/reorder$/);
  if (reorderMatch && method === 'PUT') {
    const project = decodeURIComponent(reorderMatch[1]);
    const queue = readQueue(project);
    if (!queue) return jsonError(res, 404, `Queue "${project}" not found`);

    const body = await parseBody(req);
    const order = body.order as string[] | undefined;
    if (!Array.isArray(order)) {
      return jsonError(res, 400, 'Field "order" (string[]) is required');
    }

    const promptMap = new Map(queue.prompts.map((p) => [p.id, p]));

    // Validate all IDs exist
    for (const id of order) {
      if (!promptMap.has(id)) {
        return jsonError(res, 400, `Prompt "${id}" not found in queue`);
      }
    }

    // Reorder: place ordered prompts first, keep any unmentioned prompts at end
    const reordered: Prompt[] = [];
    for (const id of order) {
      reordered.push(promptMap.get(id)!);
    }
    const orderSet = new Set(order);
    for (const p of queue.prompts) {
      if (!orderSet.has(p.id)) {
        reordered.push(p);
      }
    }

    queue.prompts = reordered;
    writeQueue(queue);
    return json(res, 200, queue);
  }

  // Match /api/queues/:project/prompts/:id
  const promptIdMatch = url.match(/^\/api\/queues\/([^/]+)\/prompts\/([^/]+)$/);
  if (promptIdMatch) {
    const project = decodeURIComponent(promptIdMatch[1]);
    const promptId = decodeURIComponent(promptIdMatch[2]);
    const queue = readQueue(project);
    if (!queue) return jsonError(res, 404, `Queue "${project}" not found`);

    if (method === 'PUT') {
      const idx = queue.prompts.findIndex((p) => p.id === promptId);
      if (idx === -1) return jsonError(res, 404, `Prompt "${promptId}" not found`);

      const body = await parseBody(req);
      if (body.text !== undefined) {
        queue.prompts[idx].text = body.text as string;
      }
      if (body.status !== undefined) {
        const validStatuses: PromptStatus[] = ['pending', 'running', 'completed'];
        if (!validStatuses.includes(body.status as PromptStatus)) {
          return jsonError(res, 400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        }
        queue.prompts[idx].status = body.status as PromptStatus;
        if (body.status === 'completed') {
          queue.prompts[idx].completedAt = new Date().toISOString();
        }
      }
      writeQueue(queue);
      return json(res, 200, queue.prompts[idx]);
    }

    if (method === 'DELETE') {
      const idx = queue.prompts.findIndex((p) => p.id === promptId);
      if (idx === -1) return jsonError(res, 404, `Prompt "${promptId}" not found`);

      const removed = queue.prompts.splice(idx, 1)[0];
      writeQueue(queue);
      return json(res, 200, removed);
    }

    return jsonError(res, 405, `Method ${method} not allowed`);
  }

  // Match /api/queues/:project/prompts
  const promptsMatch = url.match(/^\/api\/queues\/([^/]+)\/prompts$/);
  if (promptsMatch && method === 'POST') {
    const project = decodeURIComponent(promptsMatch[1]);
    const queue = readQueue(project);
    if (!queue) return jsonError(res, 404, `Queue "${project}" not found`);

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

    queue.prompts.push(prompt);
    writeQueue(queue);
    return json(res, 201, prompt);
  }

  // Match /api/queues/:project
  const projectMatch = url.match(/^\/api\/queues\/([^/]+)$/);
  if (projectMatch) {
    const project = decodeURIComponent(projectMatch[1]);

    if (method === 'GET') {
      const queue = readQueue(project);
      if (!queue) return jsonError(res, 404, `Queue "${project}" not found`);
      return json(res, 200, withComputedStatus(queue));
    }

    if (method === 'POST') {
      if (readQueue(project)) {
        return jsonError(res, 409, `Queue "${project}" already exists`);
      }

      const body = await parseBody(req);
      if (!body.directory || typeof body.directory !== 'string') {
        return jsonError(res, 400, 'Field "directory" (string) is required');
      }

      const queue: ProjectQueue = {
        project,
        directory: body.directory as string,
        prompts: [],
        activeSession: null,
        sessionHistory: [],
      };

      writeQueue(queue);
      return json(res, 201, queue);
    }

    if (method === 'DELETE') {
      const filePath = queuePath(project);
      try {
        unlinkSync(filePath);
      } catch {
        return jsonError(res, 404, `Queue "${project}" not found`);
      }
      return json(res, 200, { deleted: project });
    }

    return jsonError(res, 405, `Method ${method} not allowed`);
  }

  return jsonError(res, 404, 'Not found');
}
