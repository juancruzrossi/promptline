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

function isoMsAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
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

  it('closes orphaned sessions in the same project', () => {
    const queuesDir = join(fakeHome, '.promptline', 'queues', project);
    mkdirSync(queuesDir, { recursive: true });

    // Current session
    writeFileSync(join(queuesDir, `${sessionId}.json`), JSON.stringify({
      sessionId, project, directory: `/tmp/${project}`,
      sessionName: 'Current', prompts: [],
      startedAt: '2026-01-01T01:00:00+00:00', lastActivity: '2026-01-01T01:00:00+00:00',
      currentPromptId: null, completedAt: null, closedAt: null,
    }, null, 2));

    // Orphaned session (open, no prompts)
    writeFileSync(join(queuesDir, 'orphan-1.json'), JSON.stringify({
      sessionId: 'orphan-1', project, directory: `/tmp/${project}`,
      sessionName: 'Orphan', prompts: [],
      startedAt: '2026-01-01T00:00:00+00:00', lastActivity: '2026-01-01T00:00:00+00:00',
      currentPromptId: null, completedAt: null, closedAt: null,
    }, null, 2));

    // Already closed session (should not be touched)
    writeFileSync(join(queuesDir, 'closed-1.json'), JSON.stringify({
      sessionId: 'closed-1', project, directory: `/tmp/${project}`,
      sessionName: 'Closed', prompts: [],
      startedAt: '2026-01-01T00:00:00+00:00', lastActivity: '2026-01-01T00:00:00+00:00',
      currentPromptId: null, completedAt: null, closedAt: '2026-01-01T00:30:00+00:00',
    }, null, 2));

    const result = runHook(
      { session_id: sessionId, cwd: `/tmp/${project}` },
      { HOME: fakeHome },
    );
    expect(result.exitCode).toBe(0);

    const current = JSON.parse(readFileSync(join(queuesDir, `${sessionId}.json`), 'utf-8'));
    const orphan = JSON.parse(readFileSync(join(queuesDir, 'orphan-1.json'), 'utf-8'));
    const closed = JSON.parse(readFileSync(join(queuesDir, 'closed-1.json'), 'utf-8'));

    expect(current.closedAt).toBeTruthy();
    expect(orphan.closedAt).toBeTruthy();
    expect(closed.closedAt).toBe('2026-01-01T00:30:00+00:00'); // unchanged
  });

  it('closes orphaned sessions with pending prompts and cancels them', () => {
    const queuesDir = join(fakeHome, '.promptline', 'queues', project);
    mkdirSync(queuesDir, { recursive: true });

    writeFileSync(join(queuesDir, `${sessionId}.json`), JSON.stringify({
      sessionId, project, directory: `/tmp/${project}`,
      sessionName: 'Current', prompts: [],
      startedAt: '2026-01-01T01:00:00+00:00', lastActivity: '2026-01-01T01:00:00+00:00',
      currentPromptId: null, completedAt: null, closedAt: null,
    }, null, 2));

    writeFileSync(join(queuesDir, 'with-prompts.json'), JSON.stringify({
      sessionId: 'with-prompts', project, directory: `/tmp/${project}`,
      sessionName: 'Has work', prompts: [
        { id: 'p1', text: 'do this', status: 'pending', createdAt: '2026-01-01T00:00:00+00:00', completedAt: null },
        { id: 'p2', text: 'do that', status: 'running', createdAt: '2026-01-01T00:00:00+00:00', completedAt: null },
      ],
      startedAt: '2026-01-01T00:00:00+00:00', lastActivity: '2026-01-01T00:00:00+00:00',
      currentPromptId: 'p2', completedAt: null, closedAt: null, ownerPid: 999_999,
    }, null, 2));

    runHook(
      { session_id: sessionId, cwd: `/tmp/${project}` },
      { HOME: fakeHome },
    );

    const withPrompts = JSON.parse(readFileSync(join(queuesDir, 'with-prompts.json'), 'utf-8'));
    expect(withPrompts.closedAt).toBeTruthy();
    expect(withPrompts.prompts[0].status).toBe('cancelled');
    expect(withPrompts.prompts[0].completedAt).toBeTruthy();
    expect(withPrompts.prompts[1].status).toBe('cancelled');
    expect(withPrompts.prompts[1].completedAt).toBeTruthy();
  });

  it('does not close active sessions in other projects when ownerPid is alive', () => {
    // Current project
    const queuesDir = join(fakeHome, '.promptline', 'queues', project);
    mkdirSync(queuesDir, { recursive: true });

    writeFileSync(join(queuesDir, `${sessionId}.json`), JSON.stringify({
      sessionId, project, directory: `/tmp/${project}`,
      sessionName: 'Current', prompts: [],
      startedAt: '2026-01-01T01:00:00+00:00', lastActivity: '2026-01-01T01:00:00+00:00',
      currentPromptId: null, completedAt: null, closedAt: null,
    }, null, 2));

    // Orphan in a different project should still be swept.
    const otherProject = 'other-project';
    const otherDir = join(fakeHome, '.promptline', 'queues', otherProject);
    mkdirSync(otherDir, { recursive: true });

    writeFileSync(join(otherDir, 'orphan-other.json'), JSON.stringify({
      sessionId: 'orphan-other', project: otherProject, directory: `/tmp/${otherProject}`,
      sessionName: null, prompts: [],
      startedAt: isoMsAgo(2 * 24 * 60 * 60 * 1000), lastActivity: isoMsAgo(2 * 24 * 60 * 60 * 1000),
      currentPromptId: null, completedAt: null, closedAt: null, ownerPid: 999_999,
    }, null, 2));

    // Active session in another project must be preserved.
    writeFileSync(join(otherDir, 'active-other.json'), JSON.stringify({
      sessionId: 'active-other', project: otherProject, directory: `/tmp/${otherProject}`,
      sessionName: 'Working', prompts: [{ id: 'p1', text: 'do it', status: 'pending', createdAt: '2026-01-01T00:00:00+00:00', completedAt: null }],
      startedAt: isoMsAgo(2_000), lastActivity: isoMsAgo(2_000),
      currentPromptId: null, completedAt: null, closedAt: null, ownerPid: process.pid,
    }, null, 2));

    const result = runHook(
      { session_id: sessionId, cwd: `/tmp/${project}` },
      { HOME: fakeHome },
    );
    expect(result.exitCode).toBe(0);

    // Current session closed
    const current = JSON.parse(readFileSync(join(queuesDir, `${sessionId}.json`), 'utf-8'));
    expect(current.closedAt).toBeTruthy();

    // Orphan in other project also closed.
    const orphanOther = JSON.parse(readFileSync(join(otherDir, 'orphan-other.json'), 'utf-8'));
    expect(orphanOther.closedAt).toBeTruthy();

    // Active session in other project remains open.
    const activeOther = JSON.parse(readFileSync(join(otherDir, 'active-other.json'), 'utf-8'));
    expect(activeOther.closedAt).toBeNull();
    expect(activeOther.prompts[0].status).toBe('pending');
    expect(activeOther.prompts[0].completedAt).toBeNull();
  });

  it('keeps legacy sessions open when lastActivity is recent and ownerPid is missing', () => {
    const queuesDir = join(fakeHome, '.promptline', 'queues', project);
    mkdirSync(queuesDir, { recursive: true });

    writeFileSync(join(queuesDir, `${sessionId}.json`), JSON.stringify({
      sessionId, project, directory: `/tmp/${project}`,
      sessionName: 'Current', prompts: [],
      startedAt: isoMsAgo(2_000), lastActivity: isoMsAgo(2_000),
      currentPromptId: null, completedAt: null, closedAt: null,
    }, null, 2));

    writeFileSync(join(queuesDir, 'legacy-active.json'), JSON.stringify({
      sessionId: 'legacy-active', project, directory: `/tmp/${project}`,
      sessionName: 'Legacy active', prompts: [{ id: 'p1', text: 'wait', status: 'pending', createdAt: isoMsAgo(3_000), completedAt: null }],
      startedAt: isoMsAgo(30_000), lastActivity: isoMsAgo(30_000),
      currentPromptId: null, completedAt: null, closedAt: null,
    }, null, 2));

    const result = runHook(
      { session_id: sessionId, cwd: `/tmp/${project}` },
      { HOME: fakeHome },
    );
    expect(result.exitCode).toBe(0);

    const legacyActive = JSON.parse(readFileSync(join(queuesDir, 'legacy-active.json'), 'utf-8'));
    expect(legacyActive.closedAt).toBeNull();
    expect(legacyActive.prompts[0].status).toBe('pending');
  });

  it('closes legacy sessions when lastActivity is stale and ownerPid is missing', () => {
    const queuesDir = join(fakeHome, '.promptline', 'queues', project);
    mkdirSync(queuesDir, { recursive: true });

    writeFileSync(join(queuesDir, `${sessionId}.json`), JSON.stringify({
      sessionId, project, directory: `/tmp/${project}`,
      sessionName: 'Current', prompts: [],
      startedAt: isoMsAgo(2_000), lastActivity: isoMsAgo(2_000),
      currentPromptId: null, completedAt: null, closedAt: null,
    }, null, 2));

    writeFileSync(join(queuesDir, 'legacy-orphan.json'), JSON.stringify({
      sessionId: 'legacy-orphan', project, directory: `/tmp/${project}`,
      sessionName: 'Legacy orphan', prompts: [{ id: 'p1', text: 'stale', status: 'pending', createdAt: isoMsAgo(2 * 24 * 60 * 60 * 1000), completedAt: null }],
      startedAt: isoMsAgo(2 * 24 * 60 * 60 * 1000), lastActivity: isoMsAgo(2 * 24 * 60 * 60 * 1000),
      currentPromptId: null, completedAt: null, closedAt: null,
    }, null, 2));

    const result = runHook(
      { session_id: sessionId, cwd: `/tmp/${project}` },
      { HOME: fakeHome },
    );
    expect(result.exitCode).toBe(0);

    const legacyOrphan = JSON.parse(readFileSync(join(queuesDir, 'legacy-orphan.json'), 'utf-8'));
    expect(legacyOrphan.closedAt).toBeTruthy();
    expect(legacyOrphan.prompts[0].status).toBe('cancelled');
    expect(legacyOrphan.prompts[0].completedAt).toBeTruthy();
  });

  it('cancels pending and running prompts when closing current session', () => {
    const queuesDir = join(fakeHome, '.promptline', 'queues', project);
    mkdirSync(queuesDir, { recursive: true });

    const sessionFile = join(queuesDir, `${sessionId}.json`);
    writeFileSync(sessionFile, JSON.stringify({
      sessionId, project, directory: `/tmp/${project}`,
      sessionName: 'Test session',
      prompts: [
        { id: 'p1', text: 'done', status: 'completed', createdAt: '2026-01-01T00:00:00+00:00', completedAt: '2026-01-01T00:01:00+00:00' },
        { id: 'p2', text: 'in progress', status: 'running', createdAt: '2026-01-01T00:00:00+00:00', completedAt: null },
        { id: 'p3', text: 'waiting', status: 'pending', createdAt: '2026-01-01T00:00:00+00:00', completedAt: null },
      ],
      startedAt: '2026-01-01T00:00:00+00:00',
      lastActivity: '2026-01-01T00:00:00+00:00',
      currentPromptId: 'p2',
      completedAt: null,
      closedAt: null,
    }, null, 2));

    const result = runHook(
      { session_id: sessionId, cwd: `/tmp/${project}`, transcript_path: '' },
      { HOME: fakeHome },
    );

    expect(result.exitCode).toBe(0);

    const updated = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    expect(updated.closedAt).toBeTruthy();
    expect(updated.prompts[0].status).toBe('completed');
    expect(updated.prompts[0].completedAt).toBe('2026-01-01T00:01:00+00:00');
    expect(updated.prompts[1].status).toBe('cancelled');
    expect(updated.prompts[1].completedAt).toBeTruthy();
    expect(updated.prompts[2].status).toBe('cancelled');
    expect(updated.prompts[2].completedAt).toBeTruthy();
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
