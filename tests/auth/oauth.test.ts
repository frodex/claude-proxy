import { test, expect } from 'vitest';
import { OAuthManager } from '../../src/auth/oauth.js';

test('getSupportedProviders returns configured provider names', () => {
  const manager = new OAuthManager({
    google: { clientId: 'x', clientSecret: 'y' },
    microsoft: { clientId: 'a', clientSecret: 'b' },
  }, 'http://localhost:3101');

  const providers = manager.getSupportedProviders();
  expect(providers).toContain('google');
  expect(providers).toContain('microsoft');
  expect(providers).not.toContain('github');
});

test('getAuthUrl throws for unconfigured provider', async () => {
  const manager = new OAuthManager({}, 'http://localhost:3101');
  await expect(manager.getAuthUrl('google', 'state')).rejects.toThrow('not configured');
});

test('getSupportedProviders returns empty for no config', () => {
  const manager = new OAuthManager({}, 'http://localhost:3101');
  expect(manager.getSupportedProviders()).toEqual([]);
});
