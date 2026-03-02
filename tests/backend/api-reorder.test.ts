import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTmpDir, removeTmpDir, makeSession } from './helpers.ts';
import { addPrompt, reorderPrompts } from '../../src/backend/queue-store.ts';

describe('reorderPrompts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  it('reorders prompts by given array', () => {
    const session = makeSession();
    addPrompt(session, 'a', 'First');
    addPrompt(session, 'b', 'Second');
    addPrompt(session, 'c', 'Third');

    const err = reorderPrompts(session, ['c', 'a', 'b']);
    expect(err).toBeNull();
    expect(session.prompts.map(p => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('appends prompts not in the order array at the end', () => {
    const session = makeSession();
    addPrompt(session, 'a', 'First');
    addPrompt(session, 'b', 'Second');
    addPrompt(session, 'c', 'Third');

    const err = reorderPrompts(session, ['b']);
    expect(err).toBeNull();
    expect(session.prompts.map(p => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('returns error for unknown prompt ID', () => {
    const session = makeSession();
    addPrompt(session, 'a', 'First');

    const err = reorderPrompts(session, ['a', 'unknown-id']);
    expect(err).toBe('Prompt "unknown-id" not found');
  });

  it('keeps original order when given empty order array', () => {
    const session = makeSession();
    addPrompt(session, 'a', 'First');
    addPrompt(session, 'b', 'Second');

    const err = reorderPrompts(session, []);
    expect(err).toBeNull();
    expect(session.prompts.map(p => p.id)).toEqual(['a', 'b']);
  });
});
