import { rmSync, mkdtempSync } from 'node:fs';
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
    closedAt: null,
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
