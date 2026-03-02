import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTmpDir, removeTmpDir, makeSession, makePrompt } from './helpers.ts';
import {
  withComputedStatus,
  writeSession,
  loadProjectView,
  SESSION_TIMEOUT_MS,
} from '../../src/backend/queue-store.ts';
import { join } from 'node:path';

describe('Status computation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  describe('withComputedStatus', () => {
    it('returns active when session has a running prompt', () => {
      const session = makeSession({
        lastActivity: new Date(Date.now() - 2 * 60_000).toISOString(),
        prompts: [makePrompt({ status: 'running' })],
      });
      const result = withComputedStatus(session);
      expect(result.status).toBe('active');
    });

    it('returns active when lastActivity is recent (not stale)', () => {
      const session = makeSession({
        lastActivity: new Date().toISOString(),
        prompts: [],
      });
      const result = withComputedStatus(session);
      expect(result.status).toBe('active');
    });

    it('returns idle when no running prompts and lastActivity is stale', () => {
      const session = makeSession({
        lastActivity: new Date(Date.now() - 2 * 60_000).toISOString(),
        prompts: [makePrompt({ status: 'completed' })],
      });
      const result = withComputedStatus(session);
      expect(result.status).toBe('idle');
    });

    it('returns idle when no prompts and lastActivity is stale', () => {
      const session = makeSession({
        lastActivity: new Date(Date.now() - 2 * 60_000).toISOString(),
        prompts: [],
      });
      const result = withComputedStatus(session);
      expect(result.status).toBe('idle');
    });

    it('returns active when has running prompt even if stale', () => {
      const session = makeSession({
        lastActivity: new Date(Date.now() - 2 * 60_000).toISOString(),
        prompts: [
          makePrompt({ status: 'completed' }),
          makePrompt({ status: 'running' }),
        ],
      });
      const result = withComputedStatus(session);
      expect(result.status).toBe('active');
    });
  });

  describe('queueStatus via loadProjectView', () => {
    it('returns empty when sessions have no prompts', () => {
      const session = makeSession({ project: 'proj' });
      writeSession(tmpDir, 'proj', session);

      const view = loadProjectView('proj', join(tmpDir, 'proj'));
      expect(view).not.toBeNull();
      expect(view!.queueStatus).toBe('empty');
    });

    it('returns active when some prompts are pending', () => {
      const session = makeSession({
        project: 'proj',
        prompts: [makePrompt({ status: 'pending' })],
      });
      writeSession(tmpDir, 'proj', session);

      const view = loadProjectView('proj', join(tmpDir, 'proj'));
      expect(view).not.toBeNull();
      expect(view!.queueStatus).toBe('active');
    });

    it('returns active when some prompts are running', () => {
      const session = makeSession({
        project: 'proj',
        prompts: [makePrompt({ status: 'running' })],
      });
      writeSession(tmpDir, 'proj', session);

      const view = loadProjectView('proj', join(tmpDir, 'proj'));
      expect(view!.queueStatus).toBe('active');
    });

    it('returns completed when all prompts across sessions are completed', () => {
      const s1 = makeSession({
        project: 'proj',
        prompts: [makePrompt({ status: 'completed' })],
      });
      const s2 = makeSession({
        project: 'proj',
        prompts: [makePrompt({ status: 'completed' })],
      });
      writeSession(tmpDir, 'proj', s1);
      writeSession(tmpDir, 'proj', s2);

      const view = loadProjectView('proj', join(tmpDir, 'proj'));
      expect(view!.queueStatus).toBe('completed');
    });

    it('returns active when one session has completed and another has pending', () => {
      const s1 = makeSession({
        project: 'proj',
        prompts: [makePrompt({ status: 'completed' })],
      });
      const s2 = makeSession({
        project: 'proj',
        prompts: [makePrompt({ status: 'pending' })],
      });
      writeSession(tmpDir, 'proj', s1);
      writeSession(tmpDir, 'proj', s2);

      const view = loadProjectView('proj', join(tmpDir, 'proj'));
      expect(view!.queueStatus).toBe('active');
    });
  });
});
