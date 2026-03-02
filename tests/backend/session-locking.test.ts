import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpDir, removeTmpDir, makeSession } from './helpers.ts';
import { withSessionLock, readSession, writeSession, addPrompt } from '../../src/backend/queue-store.ts';

describe('withSessionLock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    mkdirSync(join(tmpDir, 'myapp'), { recursive: true });
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('executes callback and returns result', () => {
    const session = makeSession({ sessionId: 's1', project: 'myapp' });
    writeFileSync(join(tmpDir, 'myapp', 's1.json'), JSON.stringify(session));

    const result = withSessionLock(tmpDir, 'myapp', 's1', () => {
      const s = readSession(tmpDir, 'myapp', 's1')!;
      addPrompt(s, 'p1', 'test prompt');
      writeSession(tmpDir, 'myapp', s);
      return s.prompts.length;
    });

    expect(result).toBe(1);
    const updated = JSON.parse(readFileSync(join(tmpDir, 'myapp', 's1.json'), 'utf-8'));
    expect(updated.prompts).toHaveLength(1);
  });

  it('cleans up lockfile after success', () => {
    const session = makeSession({ sessionId: 's1', project: 'myapp' });
    writeFileSync(join(tmpDir, 'myapp', 's1.json'), JSON.stringify(session));

    withSessionLock(tmpDir, 'myapp', 's1', () => {});

    expect(existsSync(join(tmpDir, 'myapp', 's1.json.lock'))).toBe(false);
  });

  it('cleans up lockfile after error', () => {
    const session = makeSession({ sessionId: 's1', project: 'myapp' });
    writeFileSync(join(tmpDir, 'myapp', 's1.json'), JSON.stringify(session));

    expect(() => {
      withSessionLock(tmpDir, 'myapp', 's1', () => { throw new Error('boom'); });
    }).toThrow('boom');

    expect(existsSync(join(tmpDir, 'myapp', 's1.json.lock'))).toBe(false);
  });

  it('handles stale lockfile', () => {
    const session = makeSession({ sessionId: 's1', project: 'myapp' });
    writeFileSync(join(tmpDir, 'myapp', 's1.json'), JSON.stringify(session));

    const lockPath = join(tmpDir, 'myapp', 's1.json.lock');
    writeFileSync(lockPath, '');
    const past = new Date(Date.now() - 20_000);
    utimesSync(lockPath, past, past);

    const result = withSessionLock(tmpDir, 'myapp', 's1', () => 'ok');
    expect(result).toBe('ok');
  });
});
