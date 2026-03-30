// tests/auth/types.test.ts
import { test, expect } from 'vitest';
import type { UserIdentity, SshSource, OAuthSource } from '../../src/auth/types.js';

test('UserIdentity shape is correct', () => {
  const user: UserIdentity = {
    linuxUser: 'greg',
    displayName: 'Greg',
    email: 'greg@example.com',
    groups: ['users', 'devteam'],
    createdAt: new Date(),
    lastLogin: new Date(),
  };
  expect(user.linuxUser).toBe('greg');
  expect(user.groups).toContain('users');
});

test('SshSource and OAuthSource are distinct', () => {
  const ssh: SshSource = { type: 'ssh', linuxUser: 'greg' };
  const oauth: OAuthSource = {
    type: 'oauth',
    provider: 'google',
    providerId: '12345',
    email: 'greg@example.com',
    displayName: 'Greg',
  };
  expect(ssh.type).toBe('ssh');
  expect(oauth.type).toBe('oauth');
});
