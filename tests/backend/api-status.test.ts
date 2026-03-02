import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTmpDir, removeTmpDir, makeSession, makePrompt } from './helpers.ts';
import {
  withComputedStatus,
  writeSession,
  loadProjectView,
  isSessionVisible,
  SESSION_TIMEOUT_MS,
  STALE_SESSION_MS,
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

  describe('isSessionVisible', () => {
    it('hides closed sessions without pending work', () => {
      const session = makeSession({
        closedAt: new Date().toISOString(),
        prompts: [],
      });
      expect(isSessionVisible(session)).toBe(false);
    });

    it('hides closed sessions with only completed prompts', () => {
      const session = makeSession({
        closedAt: new Date().toISOString(),
        prompts: [makePrompt({ status: 'completed' })],
      });
      expect(isSessionVisible(session)).toBe(false);
    });

    it('shows closed sessions that have pending prompts', () => {
      const session = makeSession({
        closedAt: new Date().toISOString(),
        prompts: [makePrompt({ status: 'pending' })],
      });
      expect(isSessionVisible(session)).toBe(true);
    });

    it('shows closed sessions that have running prompts', () => {
      const session = makeSession({
        closedAt: new Date().toISOString(),
        prompts: [makePrompt({ status: 'running' })],
      });
      expect(isSessionVisible(session)).toBe(true);
    });

    it('hides stale sessions (>5min) without pending work', () => {
      const session = makeSession({
        lastActivity: new Date(Date.now() - STALE_SESSION_MS - 1000).toISOString(),
        closedAt: null,
        prompts: [],
      });
      expect(isSessionVisible(session)).toBe(false);
    });

    it('shows stale sessions that have pending prompts', () => {
      const session = makeSession({
        lastActivity: new Date(Date.now() - STALE_SESSION_MS - 1000).toISOString(),
        closedAt: null,
        prompts: [makePrompt({ status: 'pending' })],
      });
      expect(isSessionVisible(session)).toBe(true);
    });

    it('shows active non-closed sessions', () => {
      const session = makeSession({
        lastActivity: new Date().toISOString(),
        closedAt: null,
        prompts: [],
      });
      expect(isSessionVisible(session)).toBe(true);
    });

    it('treats missing closedAt (backward compat) as null', () => {
      const session = makeSession({
        lastActivity: new Date().toISOString(),
        prompts: [],
      });
      // closedAt defaults to null from makeSession
      expect(isSessionVisible(session)).toBe(true);
    });
  });

  describe('loadProjectView session filtering', () => {
    it('filters out closed sessions without pending work', () => {
      const active = makeSession({
        project: 'proj',
        lastActivity: new Date().toISOString(),
        closedAt: null,
      });
      const closed = makeSession({
        project: 'proj',
        closedAt: new Date().toISOString(),
        prompts: [],
      });
      writeSession(tmpDir, 'proj', active);
      writeSession(tmpDir, 'proj', closed);

      const view = loadProjectView('proj', join(tmpDir, 'proj'));
      expect(view).not.toBeNull();
      expect(view!.sessions).toHaveLength(1);
      expect(view!.sessions[0].sessionId).toBe(active.sessionId);
    });

    it('keeps closed sessions that have pending prompts', () => {
      const closed = makeSession({
        project: 'proj',
        closedAt: new Date().toISOString(),
        prompts: [makePrompt({ status: 'pending' })],
      });
      writeSession(tmpDir, 'proj', closed);

      const view = loadProjectView('proj', join(tmpDir, 'proj'));
      expect(view).not.toBeNull();
      expect(view!.sessions).toHaveLength(1);
    });

    it('filters out stale sessions (>5min) without pending work', () => {
      const active = makeSession({
        project: 'proj',
        lastActivity: new Date().toISOString(),
        closedAt: null,
      });
      const stale = makeSession({
        project: 'proj',
        lastActivity: new Date(Date.now() - STALE_SESSION_MS - 1000).toISOString(),
        closedAt: null,
        prompts: [],
      });
      writeSession(tmpDir, 'proj', active);
      writeSession(tmpDir, 'proj', stale);

      const view = loadProjectView('proj', join(tmpDir, 'proj'));
      expect(view).not.toBeNull();
      expect(view!.sessions).toHaveLength(1);
      expect(view!.sessions[0].sessionId).toBe(active.sessionId);
    });

    it('returns null when all sessions are filtered out', () => {
      const closed = makeSession({
        project: 'proj',
        closedAt: new Date().toISOString(),
        prompts: [],
      });
      writeSession(tmpDir, 'proj', closed);

      const view = loadProjectView('proj', join(tmpDir, 'proj'));
      expect(view).toBeNull();
    });
  });
});
