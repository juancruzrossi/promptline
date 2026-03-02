import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTmpDir, removeTmpDir, makePrompt } from '../backend/helpers.ts';

const HOOK_PATH = resolve(__dirname, '../../promptline-prompt-queue.sh');

function runHook(
  hookPath: string,
  input: Record<string, unknown>,
  homeDir: string,
): string {
  return execSync(`bash "${hookPath}"`, {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, HOME: homeDir },
    timeout: 10_000,
  });
}

function writeSessionFile(homeDir: string, project: string, sessionId: string, data: unknown): string {
  const queueDir = join(homeDir, '.promptline/queues', project);
  mkdirSync(queueDir, { recursive: true });
  const filePath = join(queueDir, `${sessionId}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

function hookInput(sessionId: string, project: string) {
  return {
    session_id: sessionId,
    cwd: `/projects/${project}`,
    transcript_path: '',
    stop_hook_active: false,
  };
}

describe('promptline-prompt-queue.sh', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = createTmpDir();
  });

  afterEach(() => {
    removeTmpDir(homeDir);
  });

  it('no output when no pending prompts', () => {
    const session = {
      sessionId: 'ses-1',
      project: 'myapp',
      directory: '/projects/myapp',
      sessionName: null,
      prompts: [],
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      currentPromptId: null,
      completedAt: null,
    };
    writeSessionFile(homeDir, 'myapp', 'ses-1', session);

    const output = runHook(HOOK_PATH, hookInput('ses-1', 'myapp'), homeDir);

    expect(output.trim()).toBe('');
  });

  it('outputs decision JSON when pending prompts exist', () => {
    const prompt = makePrompt({ id: 'p1', text: 'Run the migrations', status: 'pending' });
    const session = {
      sessionId: 'ses-2',
      project: 'myapp',
      directory: '/projects/myapp',
      sessionName: null,
      prompts: [prompt],
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      currentPromptId: null,
      completedAt: null,
    };
    writeSessionFile(homeDir, 'myapp', 'ses-2', session);

    const output = runHook(HOOK_PATH, hookInput('ses-2', 'myapp'), homeDir);
    const decision = JSON.parse(output.trim());

    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Run the migrations');
  });

  it('marks running prompt as completed and advances to next', () => {
    const p1 = makePrompt({ id: 'p1', text: 'First task', status: 'running' });
    const p2 = makePrompt({ id: 'p2', text: 'Second task', status: 'pending' });
    const session = {
      sessionId: 'ses-3',
      project: 'myapp',
      directory: '/projects/myapp',
      sessionName: null,
      prompts: [p1, p2],
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      currentPromptId: 'p1',
      completedAt: null,
    };
    const filePath = writeSessionFile(homeDir, 'myapp', 'ses-3', session);

    const output = runHook(HOOK_PATH, hookInput('ses-3', 'myapp'), homeDir);
    const decision = JSON.parse(output.trim());

    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Second task');

    const updated = JSON.parse(readFileSync(filePath, 'utf-8'));
    const updatedP1 = updated.prompts.find((p: { id: string }) => p.id === 'p1');
    const updatedP2 = updated.prompts.find((p: { id: string }) => p.id === 'p2');

    expect(updatedP1.status).toBe('completed');
    expect(updatedP1.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(updatedP2.status).toBe('running');
    expect(updated.currentPromptId).toBe('p2');
  });

  it('stops when all prompts are completed', () => {
    const p1 = makePrompt({ id: 'p1', text: 'Only task', status: 'running' });
    const session = {
      sessionId: 'ses-4',
      project: 'myapp',
      directory: '/projects/myapp',
      sessionName: null,
      prompts: [p1],
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      currentPromptId: 'p1',
      completedAt: null,
    };
    const filePath = writeSessionFile(homeDir, 'myapp', 'ses-4', session);

    const output = runHook(HOOK_PATH, hookInput('ses-4', 'myapp'), homeDir);

    expect(output.trim()).toBe('');

    const updated = JSON.parse(readFileSync(filePath, 'utf-8'));
    const updatedP1 = updated.prompts.find((p: { id: string }) => p.id === 'p1');

    expect(updatedP1.status).toBe('completed');
    expect(updated.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(updated.currentPromptId).toBeNull();
  });

  it('creates session file when none exists', () => {
    const output = runHook(
      HOOK_PATH,
      hookInput('new-session', 'myapp'),
      homeDir,
    );

    expect(output.trim()).toBe('');

    const filePath = join(homeDir, '.promptline/queues/myapp/new-session.json');
    expect(existsSync(filePath)).toBe(true);

    const created = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(created.sessionId).toBe('new-session');
    expect(created.project).toBe('myapp');
    expect(created.directory).toBe('/projects/myapp');
    expect(created.closedAt).toBeNull();
    expect(created.prompts).toEqual([]);
  });

  it('exits 0 when cwd is empty', () => {
    const output = runHook(
      HOOK_PATH,
      { session_id: 'ses-x', cwd: '', transcript_path: '', stop_hook_active: false },
      homeDir,
    );

    expect(output.trim()).toBe('');
  });

  it('finds session even when cwd changes to different directory', () => {
    const prompt = makePrompt({ id: 'p1', text: 'Cross-dir task', status: 'pending' });
    const session = {
      sessionId: 'ses-cross',
      project: 'original-project',
      directory: '/projects/original-project',
      sessionName: null,
      prompts: [prompt],
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      currentPromptId: null,
      completedAt: null,
    };
    // Session registered under "original-project"
    writeSessionFile(homeDir, 'original-project', 'ses-cross', session);

    // Hook called with different cwd (Claude cd'd)
    const output = runHook(HOOK_PATH, {
      session_id: 'ses-cross',
      cwd: '/projects/other-dir',
      transcript_path: '',
      stop_hook_active: false,
    }, homeDir);

    const decision = JSON.parse(output.trim());
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Cross-dir task');
  });

  it('shows remaining queued count in reason', () => {
    const p1 = makePrompt({ id: 'p1', text: 'Task one', status: 'pending' });
    const p2 = makePrompt({ id: 'p2', text: 'Task two', status: 'pending' });
    const p3 = makePrompt({ id: 'p3', text: 'Task three', status: 'pending' });
    const session = {
      sessionId: 'ses-5',
      project: 'myapp',
      directory: '/projects/myapp',
      sessionName: null,
      prompts: [p1, p2, p3],
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      currentPromptId: null,
      completedAt: null,
    };
    writeSessionFile(homeDir, 'myapp', 'ses-5', session);

    const output = runHook(HOOK_PATH, hookInput('ses-5', 'myapp'), homeDir);
    const decision = JSON.parse(output.trim());

    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('2 queued');
    expect(decision.reason).toContain('Task one');
  });
});
