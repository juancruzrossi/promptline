import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTmpDir, removeTmpDir } from '../backend/helpers.ts';

const HOOK_PATH = resolve(__dirname, '../../promptline-session-register.sh');

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

describe('promptline-session-register.sh', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = createTmpDir();
  });

  afterEach(() => {
    removeTmpDir(homeDir);
  });

  it('creates queue file with correct structure', () => {
    runHook(
      HOOK_PATH,
      { session_id: 'ses-1', cwd: '/home/user/myproject', transcript_path: '' },
      homeDir,
    );

    const filePath = join(homeDir, '.promptline/queues/myproject/ses-1.json');
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));

    expect(data.sessionId).toBe('ses-1');
    expect(data.project).toBe('myproject');
    expect(data.directory).toBe('/home/user/myproject');
    expect(data.sessionName).toBeNull();
    expect(data.prompts).toEqual([]);
    expect(data.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.lastActivity).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.currentPromptId).toBeNull();
    expect(data.completedAt).toBeNull();
    expect(typeof data.ownerPid).toBe('number');
    expect(data.ownerPid).toBeGreaterThan(0);
    expect(data.ownerStartedAt === null || typeof data.ownerStartedAt === 'string').toBe(true);
  });

  it('derives project name from cwd basename', () => {
    runHook(
      HOOK_PATH,
      { session_id: 'ses-2', cwd: '/deep/nested/path/cool-project', transcript_path: '' },
      homeDir,
    );

    const filePath = join(homeDir, '.promptline/queues/cool-project/ses-2.json');
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));

    expect(data.project).toBe('cool-project');
    expect(data.directory).toBe('/deep/nested/path/cool-project');
  });

  it('updates lastActivity on existing session without changing startedAt', () => {
    const queueDir = join(homeDir, '.promptline/queues/myproject');
    mkdirSync(queueDir, { recursive: true });

    const oldDate = '2020-01-01T00:00:00+00:00';
    const existing = {
      sessionId: 'ses-3',
      project: 'myproject',
      directory: '/home/user/myproject',
      sessionName: 'Existing session',
      prompts: [],
      startedAt: oldDate,
      lastActivity: oldDate,
      currentPromptId: null,
      completedAt: null,
    };
    const filePath = join(queueDir, 'ses-3.json');
    writeFileSync(filePath, JSON.stringify(existing, null, 2));

    runHook(
      HOOK_PATH,
      { session_id: 'ses-3', cwd: '/home/user/myproject', transcript_path: '' },
      homeDir,
    );

    const data = JSON.parse(readFileSync(filePath, 'utf-8'));

    expect(data.startedAt).toBe(oldDate);
    expect(data.lastActivity).not.toBe(oldDate);
    expect(data.sessionName).toBe('Existing session');
  });

  it('extracts session name from transcript', () => {
    const transcriptDir = join(homeDir, 'transcripts');
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, 'session.jsonl');

    const transcriptLine = JSON.stringify({
      type: 'user',
      message: { content: 'Fix the login bug' },
    });
    writeFileSync(transcriptPath, transcriptLine + '\n');

    runHook(
      HOOK_PATH,
      { session_id: 'ses-4', cwd: '/home/user/myproject', transcript_path: transcriptPath },
      homeDir,
    );

    const filePath = join(homeDir, '.promptline/queues/myproject/ses-4.json');
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));

    expect(data.sessionName).toBe('Fix the login bug');
  });

  it('exits 0 when cwd is empty', () => {
    const output = runHook(
      HOOK_PATH,
      { session_id: 'ses-5', cwd: '', transcript_path: '' },
      homeDir,
    );

    expect(output).toBe('');
  });

  it('does not create duplicate when cwd changes to subdirectory', () => {
    // Register session under original project
    runHook(
      HOOK_PATH,
      { session_id: 'ses-dup', cwd: '/home/user/projects', transcript_path: '' },
      homeDir,
    );

    const originalFile = join(homeDir, '.promptline/queues/projects/ses-dup.json');
    expect(JSON.parse(readFileSync(originalFile, 'utf-8')).project).toBe('projects');

    // Same session, different cwd (Claude cd'd into a subdirectory)
    runHook(
      HOOK_PATH,
      { session_id: 'ses-dup', cwd: '/home/user/projects/promptline', transcript_path: '' },
      homeDir,
    );

    // Should NOT create file under "promptline" project
    const duplicateFile = join(homeDir, '.promptline/queues/promptline/ses-dup.json');
    expect(existsSync(duplicateFile)).toBe(false);

    // Should update the original file
    const updated = JSON.parse(readFileSync(originalFile, 'utf-8'));
    expect(updated.project).toBe('projects');
  });
});
