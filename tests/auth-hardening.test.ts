import { describe, test, expect } from 'vitest';

describe('input validation', () => {
  test('rejects username with shell metacharacters', async () => {
    const { validateUsername } = await import('../src/auth/provisioner.js');
    expect(() => validateUsername('valid_user')).not.toThrow();
    expect(() => validateUsername('$(whoami)')).toThrow(/invalid username/i);
    expect(() => validateUsername('user;rm -rf')).toThrow(/invalid username/i);
    expect(() => validateUsername('')).toThrow(/invalid username/i);
    expect(() => validateUsername('a'.repeat(33))).toThrow(/invalid username/i);
  });

  test('rejects group name with shell metacharacters', async () => {
    const { validateGroupName } = await import('../src/auth/provisioner.js');
    expect(() => validateGroupName('users')).not.toThrow();
    expect(() => validateGroupName('$(id)')).toThrow(/invalid group/i);
  });
});

describe('session-cookie exp bypass', () => {
  test('cookie with exp=0 is rejected', async () => {
    const { validateSessionCookie } = await import('../src/auth/session-cookie.js');
    const { createHmac } = await import('crypto');
    const secret = 'test-secret-32-chars-minimum!!!!!';
    const payload = { linuxUser: 'test', displayName: 'Test', exp: 0 };
    const json = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', secret).update(json).digest('base64url');
    const cookie = `${json}.${sig}`;
    expect(validateSessionCookie(cookie, secret)).toBeNull();
  });
});

describe('github adapter', () => {
  test('rejects when no verified primary email found', async () => {
    const { GitHubAdapter } = await import('../src/auth/github-adapter.js');
    const adapter = new GitHubAdapter('id', 'secret', 'http://localhost');

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string) => {
        if (url.includes('/login/oauth/access_token'))
          return { json: async () => ({ access_token: 'tok' }) } as Response;
        if (url.includes('/user/emails'))
          return { json: async () => ([{ email: 'x@test.com', primary: true, verified: false }]) } as Response;
        if (url.includes('/user'))
          return { json: async () => ({ id: 1, name: 'Test', login: 'test' }) } as Response;
        return new Response();
      }) as typeof fetch;

      await expect(adapter.handleCallback('code')).rejects.toThrow(/no verified primary email/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
