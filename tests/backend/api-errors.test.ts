import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTmpDir, removeTmpDir, makeSession } from './helpers.ts';
import {
  readSession,
  loadProjectView,
  deleteProject,
  deleteSession,
  updatePrompt,
  writeSession,
  addPrompt,
} from '../../src/backend/queue-store.ts';

describe('Error handling', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  describe('corrupted JSON', () => {
    it('readSession returns null for corrupted JSON', () => {
      const projDir = join(tmpDir, 'proj');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'bad.json'), '{ not valid json !!!');

      const result = readSession(tmpDir, 'proj', 'bad');
      expect(result).toBeNull();
    });
  });

  describe('loadProjectView', () => {
    it('returns null for a non-existent directory', () => {
      const result = loadProjectView(tmpDir, 'ghost');
      expect(result).toBeNull();
    });

    it('skips corrupted files and returns valid sessions', () => {
      const projDir = join(tmpDir, 'proj');
      mkdirSync(projDir, { recursive: true });

      // Write a valid session
      const session = makeSession({ project: 'proj' });
      writeSession(tmpDir, 'proj', session);

      // Write a corrupted file
      writeFileSync(join(projDir, 'corrupted.json'), '{{bad json}}');

      const view = loadProjectView(tmpDir, 'proj');
      expect(view).not.toBeNull();
      expect(view!.sessions).toHaveLength(1);
      expect(view!.sessions[0].sessionId).toBe(session.sessionId);
    });

    it('returns null when all files are corrupted', () => {
      const projDir = join(tmpDir, 'proj');
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, 'bad1.json'), 'nope');
      writeFileSync(join(projDir, 'bad2.json'), '!!!');

      const view = loadProjectView(tmpDir, 'proj');
      expect(view).toBeNull();
    });
  });

  describe('deleteProject / deleteSession throw for non-existent targets', () => {
    it('deleteProject throws for non-existent project', () => {
      expect(() => deleteProject(tmpDir, 'no-such-project')).toThrow();
    });

    it('deleteSession throws for non-existent session', () => {
      expect(() => deleteSession(tmpDir, 'proj', 'no-such-session')).toThrow();
    });
  });

  describe('updatePrompt edge cases', () => {
    it('returns null for non-existent prompt id', () => {
      const session = makeSession();
      addPrompt(session, 'p1', 'Something');
      const result = updatePrompt(session, 'nonexistent', { status: 'running' });
      expect(result).toBeNull();
    });
  });

  describe('atomic write', () => {
    it('leaves no tmp files after successful write', () => {
      const session = makeSession({ project: 'proj' });
      writeSession(tmpDir, 'proj', session);

      const projDir = join(tmpDir, 'proj');
      const files = readdirSync(projDir);
      const tmpFiles = files.filter(f => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });
  });
});
