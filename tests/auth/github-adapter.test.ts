import { test, expect } from 'vitest';
import { GitHubAdapter } from '../../src/auth/github-adapter.js';

test('getAuthUrl returns GitHub authorize URL', () => {
  const adapter = new GitHubAdapter('client-id', 'client-secret', 'http://localhost:3101');
  const url = adapter.getAuthUrl('random-state');
  expect(url).toContain('github.com/login/oauth/authorize');
  expect(url).toContain('client-id');
  expect(url).toContain('random-state');
  expect(url).toContain('scope=read%3Auser+user%3Aemail');
});

test('getAuthUrl includes callback URL', () => {
  const adapter = new GitHubAdapter('cid', 'csec', 'http://localhost:3101');
  const url = adapter.getAuthUrl('state');
  expect(url).toContain(encodeURIComponent('http://localhost:3101/api/auth/callback'));
});
