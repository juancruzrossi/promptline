import { describe, it, expect } from 'vitest';
import { isSafeSegment } from '../../vite-plugin-api.ts';

describe('isSafeSegment – path traversal prevention', () => {
  it('accepts a normal project name', () => {
    expect(isSafeSegment('my-project')).toBe(true);
  });

  it('accepts a normal session id', () => {
    expect(isSafeSegment('abc-123-def')).toBe(true);
  });

  it('rejects segments containing ".."', () => {
    expect(isSafeSegment('..')).toBe(false);
    expect(isSafeSegment('..%2F..%2Fetc')).toBe(false);
    expect(isSafeSegment('foo..bar')).toBe(false);
  });

  it('rejects segments containing forward slash', () => {
    expect(isSafeSegment('a/b')).toBe(false);
    expect(isSafeSegment('../etc')).toBe(false);
  });

  it('rejects segments containing backslash', () => {
    expect(isSafeSegment('a\\b')).toBe(false);
    expect(isSafeSegment('..\\etc')).toBe(false);
  });

  it('rejects empty segments', () => {
    expect(isSafeSegment('')).toBe(false);
  });

  it('accepts segments with dots that are not traversal', () => {
    expect(isSafeSegment('v1.0.0')).toBe(true);
    expect(isSafeSegment('.hidden')).toBe(true);
  });
});
