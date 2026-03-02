import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTmpDir, removeTmpDir, makeSession, makePrompt } from './helpers.ts';
import {
  writeSession,
  readSession,
  listProjects,
  getProject,
  deleteProject,
  deleteSession,
  addPrompt,
  updatePrompt,
  deletePrompt,
} from '../../src/backend/queue-store.ts';

describe('CRUD operations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  describe('writeSession / readSession', () => {
    it('round-trips a session through write and read', () => {
      const session = makeSession({ project: 'proj-a' });
      writeSession(tmpDir, 'proj-a', session);
      const loaded = readSession(tmpDir, 'proj-a', session.sessionId);
      expect(loaded).toEqual(session);
    });

    it('returns null for a non-existent session', () => {
      const result = readSession(tmpDir, 'proj-a', 'no-such-session');
      expect(result).toBeNull();
    });
  });

  describe('listProjects', () => {
    it('returns empty array when queuesDir is empty', () => {
      const projects = listProjects(tmpDir);
      expect(projects).toEqual([]);
    });

    it('lists projects that have sessions', () => {
      const s1 = makeSession({ project: 'alpha' });
      const s2 = makeSession({ project: 'beta' });
      writeSession(tmpDir, 'alpha', s1);
      writeSession(tmpDir, 'beta', s2);

      const projects = listProjects(tmpDir);
      const names = projects.map(p => p.project).sort();
      expect(names).toEqual(['alpha', 'beta']);
    });
  });

  describe('getProject', () => {
    it('returns a project view for an existing project', () => {
      const session = makeSession({ project: 'proj-x' });
      writeSession(tmpDir, 'proj-x', session);

      const view = getProject(tmpDir, 'proj-x');
      expect(view).not.toBeNull();
      expect(view!.project).toBe('proj-x');
      expect(view!.sessions).toHaveLength(1);
    });

    it('returns null for a non-existent project', () => {
      const view = getProject(tmpDir, 'no-project');
      expect(view).toBeNull();
    });
  });

  describe('deleteProject', () => {
    it('removes an entire project directory', () => {
      const session = makeSession({ project: 'to-delete' });
      writeSession(tmpDir, 'to-delete', session);
      expect(getProject(tmpDir, 'to-delete')).not.toBeNull();

      deleteProject(tmpDir, 'to-delete');
      expect(getProject(tmpDir, 'to-delete')).toBeNull();
    });
  });

  describe('deleteSession', () => {
    it('removes a single session file', () => {
      const s1 = makeSession({ project: 'proj' });
      const s2 = makeSession({ project: 'proj' });
      writeSession(tmpDir, 'proj', s1);
      writeSession(tmpDir, 'proj', s2);

      deleteSession(tmpDir, 'proj', s1.sessionId);
      expect(readSession(tmpDir, 'proj', s1.sessionId)).toBeNull();
      expect(readSession(tmpDir, 'proj', s2.sessionId)).not.toBeNull();
    });
  });

  describe('addPrompt', () => {
    it('appends a prompt to the session', () => {
      const session = makeSession();
      const prompt = addPrompt(session, 'p1', 'Do something');
      expect(prompt.id).toBe('p1');
      expect(prompt.text).toBe('Do something');
      expect(prompt.status).toBe('pending');
      expect(session.prompts).toHaveLength(1);
      expect(session.prompts[0]).toBe(prompt);
    });

    it('appends multiple prompts in order', () => {
      const session = makeSession();
      addPrompt(session, 'p1', 'First');
      addPrompt(session, 'p2', 'Second');
      expect(session.prompts.map(p => p.id)).toEqual(['p1', 'p2']);
    });
  });

  describe('updatePrompt', () => {
    it('updates text of an existing prompt', () => {
      const session = makeSession();
      addPrompt(session, 'p1', 'Original');
      const updated = updatePrompt(session, 'p1', { text: 'Modified' });
      expect(updated).not.toBeNull();
      expect(updated!.text).toBe('Modified');
    });

    it('updates status to running', () => {
      const session = makeSession();
      addPrompt(session, 'p1', 'Task');
      const updated = updatePrompt(session, 'p1', { status: 'running' });
      expect(updated!.status).toBe('running');
      expect(updated!.completedAt).toBeNull();
    });

    it('sets completedAt when status is completed', () => {
      const session = makeSession();
      addPrompt(session, 'p1', 'Task');
      const updated = updatePrompt(session, 'p1', { status: 'completed' });
      expect(updated!.status).toBe('completed');
      expect(updated!.completedAt).not.toBeNull();
    });

    it('returns null for a non-existent prompt', () => {
      const session = makeSession();
      const result = updatePrompt(session, 'no-such-id', { text: 'x' });
      expect(result).toBeNull();
    });
  });

  describe('deletePrompt', () => {
    it('removes a prompt by id and returns it', () => {
      const session = makeSession();
      addPrompt(session, 'p1', 'Keep');
      addPrompt(session, 'p2', 'Remove');
      const removed = deletePrompt(session, 'p2');
      expect(removed).not.toBeNull();
      expect(removed!.id).toBe('p2');
      expect(session.prompts).toHaveLength(1);
      expect(session.prompts[0].id).toBe('p1');
    });

    it('returns null for a non-existent prompt', () => {
      const session = makeSession();
      const result = deletePrompt(session, 'ghost');
      expect(result).toBeNull();
    });
  });
});
