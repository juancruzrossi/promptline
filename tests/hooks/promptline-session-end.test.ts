import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const SCRIPT_PATH = join(import.meta.dirname, '..', '..', 'promptline-session-end.sh');

function runHook(input: object, env: Record<string, string> = {}): { exitCode: number } {
  try {
    execSync(`bash "${SCRIPT_PATH}"`, {
      input: JSON.stringify(input),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0 };
  } catch (err: unknown) {
    const error = err as { status?: number };
    return { exitCode: error.status ?? 1 };
  }
}

describe('promptline-session-end.sh', () => {
  let fakeHome: string;
  const sessionId = 'test-session-abc';
  const project = 'my-project';

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'promptline-hook-test-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('sets closedAt and updates lastActivity on existing session file', () => {
    const queuesDir = join(fakeHome, '.promptline', 'queues', project);
    mkdirSync(queuesDir, { recursive: true });

    const sessionFile = join(queuesDir, `${sessionId}.json`);
    const originalData = {
      sessionId,
      project,
      directory: `/tmp/${project}`,
      sessionName: 'Test session',
      prompts: [],
      startedAt: '2026-01-01T00:00:00+00:00',
      lastActivity: '2026-01-01T00:00:00+00:00',
      currentPromptId: null,
      completedAt: null,
      closedAt: null,
    };
    writeFileSync(sessionFile, JSON.stringify(originalData, null, 2));

    const result = runHook(
      { session_id: sessionId, cwd: `/tmp/${project}`, transcript_path: '' },
      { HOME: fakeHome },
    );

    expect(result.exitCode).toBe(0);

    const updated = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    expect(updated.closedAt).toBeTruthy();
    expect(typeof updated.closedAt).toBe('string');
    expect(updated.lastActivity).not.toBe(originalData.lastActivity);
  });

  it('exits 0 silently when queue file does not exist', () => {
    const result = runHook(
      { session_id: 'nonexistent-session', cwd: `/tmp/${project}`, transcript_path: '' },
      { HOME: fakeHome },
    );

    expect(result.exitCode).toBe(0);

    const queuesDir = join(fakeHome, '.promptline', 'queues', project);
    const sessionFile = join(queuesDir, 'nonexistent-session.json');
    expect(existsSync(sessionFile)).toBe(false);
  });

  it('exits 0 when session_id is empty', () => {
    const result = runHook(
      { session_id: '', cwd: `/tmp/${project}` },
      { HOME: fakeHome },
    );

    expect(result.exitCode).toBe(0);
  });

  it('exits 0 when cwd is empty', () => {
    const result = runHook(
      { session_id: sessionId, cwd: '' },
      { HOME: fakeHome },
    );

    expect(result.exitCode).toBe(0);
  });

  it('closes session even when cwd differs from original project', () => {
    const originalProject = 'original-proj';
    const queuesDir = join(fakeHome, '.promptline', 'queues', originalProject);
    mkdirSync(queuesDir, { recursive: true });

    const sessionFile = join(queuesDir, `${sessionId}.json`);
    writeFileSync(sessionFile, JSON.stringify({
      sessionId,
      project: originalProject,
      directory: `/tmp/${originalProject}`,
      sessionName: 'Test',
      prompts: [],
      startedAt: '2026-01-01T00:00:00+00:00',
      lastActivity: '2026-01-01T00:00:00+00:00',
      currentPromptId: null,
      completedAt: null,
      closedAt: null,
    }, null, 2));

    // Close with different cwd
    const result = runHook(
      { session_id: sessionId, cwd: '/tmp/different-dir' },
      { HOME: fakeHome },
    );

    expect(result.exitCode).toBe(0);

    const updated = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    expect(updated.closedAt).toBeTruthy();
  });
});
