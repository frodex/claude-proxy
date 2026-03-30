import { test, expect } from 'vitest';
import { createSessionCookie, validateSessionCookie } from '../../src/auth/session-cookie.js';

const SECRET = 'test-secret-key-at-least-32-bytes!!';

test('createSessionCookie returns a signed string', () => {
  const cookie = createSessionCookie({ linuxUser: 'greg', displayName: 'Greg' }, SECRET, 3600);
  expect(typeof cookie).toBe('string');
  expect(cookie.length).toBeGreaterThan(0);
});

test('validateSessionCookie returns payload for valid cookie', () => {
  const cookie = createSessionCookie({ linuxUser: 'greg', displayName: 'Greg' }, SECRET, 3600);
  const result = validateSessionCookie(cookie, SECRET);
  expect(result).not.toBeNull();
  expect(result!.linuxUser).toBe('greg');
  expect(result!.displayName).toBe('Greg');
});

test('validateSessionCookie returns null for tampered cookie', () => {
  const cookie = createSessionCookie({ linuxUser: 'greg', displayName: 'Greg' }, SECRET, 3600);
  const tampered = cookie.slice(0, -5) + 'XXXXX';
  expect(validateSessionCookie(tampered, SECRET)).toBeNull();
});

test('validateSessionCookie returns null for expired cookie', () => {
  const cookie = createSessionCookie({ linuxUser: 'greg', displayName: 'Greg' }, SECRET, -1);
  expect(validateSessionCookie(cookie, SECRET)).toBeNull();
});

test('validateSessionCookie returns null for wrong secret', () => {
  const cookie = createSessionCookie({ linuxUser: 'greg', displayName: 'Greg' }, SECRET, 3600);
  expect(validateSessionCookie(cookie, 'wrong-secret-key-at-least-32-byt!!')).toBeNull();
});
