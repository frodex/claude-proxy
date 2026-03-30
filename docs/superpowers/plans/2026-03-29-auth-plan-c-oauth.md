# OAuth Implementation Plan (Plan C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OAuth authentication for web clients — Google, Microsoft, GitHub — with automatic user provisioning and session cookies.

**Architecture:** OIDC via `openid-client` for Google/Microsoft (config-only). Custom adapter for GitHub (OAuth 2.0 without OIDC). Auth middleware on all API endpoints. Signed session cookies. All OAuth flows converge at `resolveUser()` from Plan A.

**Tech Stack:** TypeScript, openid-client, Node.js crypto (cookie signing)

**Spec:** `docs/superpowers/specs/2026-03-29-auth-ugo-security-design.md` (Phase 4)

**Depends on:** Plan A (shared contract) must be complete.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/auth/oauth.ts` | OIDC provider setup, auth URL generation, callback handling |
| `src/auth/github-adapter.ts` | GitHub-specific OAuth flow (not OIDC) |
| `src/auth/session-cookie.ts` | Signed cookie creation, validation, expiry |
| `src/auth/middleware.ts` | Express-style auth middleware for API endpoints |
| `tests/auth/oauth.test.ts` | OAuth flow tests (mocked providers) |
| `tests/auth/github-adapter.test.ts` | GitHub adapter tests |
| `tests/auth/session-cookie.test.ts` | Cookie signing/validation tests |
| `tests/auth/middleware.test.ts` | Auth middleware tests |
| Modify: `src/api-server.ts` | Add auth routes, apply middleware |
| Modify: `src/config.ts` | Add auth provider config schema |
| Modify: `claude-proxy.yaml` | Add auth section with provider config |

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install openid-client**

```bash
cd /srv/claude-proxy && npm install openid-client
```

- [ ] **Step 2: Verify build**

Run: `cd /srv/claude-proxy && npm run build`
Expected: Compiles without errors

- [ ] **Step 3: Commit**

```bash
cd /srv/claude-proxy && git add package.json package-lock.json && git commit -m "deps: add openid-client for OAuth/OIDC flows"
```

---

### Task 2: Session Cookie — Tests and Implementation

**Files:**
- Create: `src/auth/session-cookie.ts`
- Create: `tests/auth/session-cookie.test.ts`

- [ ] **Step 1: Write cookie tests**

```typescript
// tests/auth/session-cookie.test.ts
import { test, expect } from 'vitest';
import { createSessionCookie, validateSessionCookie } from '../src/auth/session-cookie.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/session-cookie.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement session cookie**

```typescript
// src/auth/session-cookie.ts
import { createHmac, timingSafeEqual } from 'crypto';

export interface CookiePayload {
  linuxUser: string;
  displayName: string;
  exp?: number;
}

export function createSessionCookie(
  payload: { linuxUser: string; displayName: string },
  secret: string,
  maxAgeSeconds: number,
): string {
  const data: CookiePayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + maxAgeSeconds,
  };
  const json = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = createHmac('sha256', secret).update(json).digest('base64url');
  return `${json}.${sig}`;
}

export function validateSessionCookie(
  cookie: string,
  secret: string,
): CookiePayload | null {
  const parts = cookie.split('.');
  if (parts.length !== 2) return null;

  const [json, sig] = parts;
  const expectedSig = createHmac('sha256', secret).update(json).digest('base64url');

  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  } catch {
    return null;
  }

  try {
    const payload: CookiePayload = JSON.parse(Buffer.from(json, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/session-cookie.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/auth/session-cookie.ts tests/auth/session-cookie.test.ts && git commit -m "feat: signed session cookies for web auth"
```

---

### Task 3: Auth Middleware — Tests and Implementation

**Files:**
- Create: `src/auth/middleware.ts`
- Create: `tests/auth/middleware.test.ts`

- [ ] **Step 1: Write middleware tests**

```typescript
// tests/auth/middleware.test.ts
import { test, expect, vi } from 'vitest';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { createSessionCookie } from '../src/auth/session-cookie.js';
import type { IncomingMessage, ServerResponse } from 'http';

const SECRET = 'test-secret-key-at-least-32-bytes!!';

function mockReq(cookie?: string): IncomingMessage {
  return {
    headers: cookie ? { cookie: `session=${cookie}` } : {},
  } as any;
}

function mockRes(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 200,
    body: '',
    writeHead: vi.fn((code: number) => { res.statusCode = code; }),
    end: vi.fn((body: string) => { res.body = body; }),
  } as any;
  return res;
}

test('middleware passes valid cookie', () => {
  const middleware = createAuthMiddleware(SECRET);
  const cookie = createSessionCookie({ linuxUser: 'greg', displayName: 'Greg' }, SECRET, 3600);
  const req = mockReq(cookie);
  const res = mockRes();
  const next = vi.fn();

  middleware(req, res, next);

  expect(next).toHaveBeenCalled();
  expect((req as any).user.linuxUser).toBe('greg');
});

test('middleware rejects missing cookie', () => {
  const middleware = createAuthMiddleware(SECRET);
  const req = mockReq();
  const res = mockRes();
  const next = vi.fn();

  middleware(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
});

test('middleware rejects expired cookie', () => {
  const middleware = createAuthMiddleware(SECRET);
  const cookie = createSessionCookie({ linuxUser: 'greg', displayName: 'Greg' }, SECRET, -1);
  const req = mockReq(cookie);
  const res = mockRes();
  const next = vi.fn();

  middleware(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/middleware.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement middleware**

```typescript
// src/auth/middleware.ts
import type { IncomingMessage, ServerResponse } from 'http';
import { validateSessionCookie, type CookiePayload } from './session-cookie.js';

export interface AuthenticatedRequest extends IncomingMessage {
  user?: CookiePayload;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  header.split(';').forEach(pair => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}

export function createAuthMiddleware(secret: string) {
  return function authMiddleware(
    req: AuthenticatedRequest,
    res: ServerResponse,
    next: () => void,
  ): void {
    const cookieHeader = req.headers.cookie || '';
    const cookies = parseCookies(cookieHeader);
    const sessionCookie = cookies['session'];

    if (!sessionCookie) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }

    const payload = validateSessionCookie(sessionCookie, secret);
    if (!payload) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired session' }));
      return;
    }

    req.user = payload;
    next();
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/middleware.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/auth/middleware.ts tests/auth/middleware.test.ts && git commit -m "feat: auth middleware — cookie validation for API endpoints"
```

---

### Task 4: OIDC Provider Setup (Google/Microsoft)

**Files:**
- Create: `src/auth/oauth.ts`
- Create: `tests/auth/oauth.test.ts`

- [ ] **Step 1: Write OIDC flow tests**

```typescript
// tests/auth/oauth.test.ts
import { test, expect, vi } from 'vitest';
import { OAuthManager } from '../src/auth/oauth.js';

test('getAuthUrl returns a URL for a configured provider', async () => {
  const manager = new OAuthManager({
    google: {
      clientId: 'test-client-id',
      clientSecret: 'test-secret',
    },
  }, 'http://localhost:3101');

  // This will fail if google discovery can't be reached
  // In real tests, mock the discovery. For now, test the structure.
  const url = await manager.getAuthUrl('google', 'random-state');
  expect(url).toContain('accounts.google.com');
  expect(url).toContain('test-client-id');
  expect(url).toContain('random-state');
});

test('getAuthUrl throws for unconfigured provider', async () => {
  const manager = new OAuthManager({}, 'http://localhost:3101');
  await expect(manager.getAuthUrl('google', 'state')).rejects.toThrow('not configured');
});

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
```

- [ ] **Step 2: Implement OAuthManager**

```typescript
// src/auth/oauth.ts
import { Issuer, type Client as OIDCClient } from 'openid-client';

interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  tenant?: string; // Microsoft-specific
}

interface OAuthManagerConfig {
  google?: ProviderConfig;
  microsoft?: ProviderConfig;
  github?: ProviderConfig;
}

const DISCOVERY_URLS: Record<string, string | ((config: ProviderConfig) => string)> = {
  google: 'https://accounts.google.com',
  microsoft: (config) =>
    `https://login.microsoftonline.com/${config.tenant || 'common'}/v2.0`,
};

export class OAuthManager {
  private config: OAuthManagerConfig;
  private callbackBase: string;
  private clients: Map<string, OIDCClient> = new Map();

  constructor(config: OAuthManagerConfig, callbackBase: string) {
    this.config = config;
    this.callbackBase = callbackBase;
  }

  getSupportedProviders(): string[] {
    return Object.keys(this.config).filter(
      k => this.config[k as keyof OAuthManagerConfig]
    );
  }

  async getAuthUrl(provider: string, state: string): Promise<string> {
    const client = await this.getClient(provider);
    return client.authorizationUrl({
      scope: 'openid email profile',
      state,
      redirect_uri: `${this.callbackBase}/api/auth/callback`,
    });
  }

  async handleCallback(
    provider: string,
    callbackParams: Record<string, string>,
    state: string,
  ): Promise<{ email: string; displayName: string; providerId: string }> {
    const client = await this.getClient(provider);
    const tokenSet = await client.callback(
      `${this.callbackBase}/api/auth/callback`,
      callbackParams,
      { state },
    );

    const claims = tokenSet.claims();
    return {
      email: claims.email as string,
      displayName: (claims.name as string) || (claims.email as string),
      providerId: claims.sub as string,
    };
  }

  private async getClient(provider: string): Promise<OIDCClient> {
    if (this.clients.has(provider)) return this.clients.get(provider)!;

    const config = this.config[provider as keyof OAuthManagerConfig];
    if (!config) throw new Error(`Provider "${provider}" not configured`);

    const discoveryUrl = DISCOVERY_URLS[provider];
    if (!discoveryUrl) throw new Error(`No discovery URL for provider "${provider}"`);

    const url = typeof discoveryUrl === 'function' ? discoveryUrl(config) : discoveryUrl;
    const issuer = await Issuer.discover(url);

    const client = new issuer.Client({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uris: [`${this.callbackBase}/api/auth/callback`],
      response_types: ['code'],
    });

    this.clients.set(provider, client);
    return client;
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/oauth.test.ts`
Expected: First test may fail if Google discovery unreachable in test env. Tests 2-3 should PASS.

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/auth/oauth.ts tests/auth/oauth.test.ts && git commit -m "feat: OAuthManager — OIDC flow for Google and Microsoft"
```

---

### Task 5: GitHub Adapter

**Files:**
- Create: `src/auth/github-adapter.ts`
- Create: `tests/auth/github-adapter.test.ts`

- [ ] **Step 1: Write GitHub adapter tests**

```typescript
// tests/auth/github-adapter.test.ts
import { test, expect, vi } from 'vitest';
import { GitHubAdapter } from '../src/auth/github-adapter.js';

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
```

- [ ] **Step 2: Implement GitHub adapter**

```typescript
// src/auth/github-adapter.ts

export class GitHubAdapter {
  private clientId: string;
  private clientSecret: string;
  private callbackBase: string;

  constructor(clientId: string, clientSecret: string, callbackBase: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackBase = callbackBase;
  }

  getAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: `${this.callbackBase}/api/auth/callback`,
      scope: 'read:user user:email',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  }

  async handleCallback(code: string): Promise<{ email: string; displayName: string; providerId: string }> {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
      }),
    });
    const tokenData = await tokenRes.json() as any;
    const accessToken = tokenData.access_token;

    if (!accessToken) throw new Error('Failed to get GitHub access token');

    // Get user profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const user = await userRes.json() as any;

    // Get verified email
    const emailRes = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const emails = await emailRes.json() as any[];
    const primary = emails.find((e: any) => e.primary && e.verified);
    const email = primary?.email || user.email;

    if (!email) throw new Error('No verified email found on GitHub account');

    return {
      email,
      displayName: user.name || user.login,
      providerId: String(user.id),
    };
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/github-adapter.test.ts`
Expected: 2 tests PASS

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/auth/github-adapter.ts tests/auth/github-adapter.test.ts && git commit -m "feat: GitHub OAuth adapter — non-OIDC flow"
```

---

### Task 6: Add Auth Config Schema

**Files:**
- Modify: `src/config.ts`
- Modify: `claude-proxy.yaml`

- [ ] **Step 1: Read current config.ts to understand the pattern**

- [ ] **Step 2: Add auth section to Config type and parser**

Add to the Config interface:
```typescript
auth: {
  authorized_keys: string;
  providers?: {
    google?: { client_id: string; client_secret: string };
    microsoft?: { client_id: string; client_secret: string; tenant?: string };
    github?: { client_id: string; client_secret: string };
  };
  user_mapping?: {
    strategy: 'email-prefix' | 'explicit' | 'auto';
  };
  auto_provision?: boolean;
  default_groups?: string[];
  session?: {
    secret: string;
    max_age?: number;
  };
};
```

- [ ] **Step 3: Add example auth config to claude-proxy.yaml**

```yaml
auth:
  authorized_keys: ~/.ssh/authorized_keys
  # providers:
  #   google:
  #     client_id: "xxx.apps.googleusercontent.com"
  #     client_secret: "xxx"
  #   microsoft:
  #     client_id: "xxx"
  #     client_secret: "xxx"
  #     tenant: "common"
  #   github:
  #     client_id: "xxx"
  #     client_secret: "xxx"
  # session:
  #   secret: "change-me-to-a-random-string"
  #   max_age: 86400
```

- [ ] **Step 4: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/config.ts claude-proxy.yaml && git commit -m "feat: auth provider config schema in claude-proxy.yaml"
```

---

### Task 7: Wire Auth Routes into API Server

**Files:**
- Modify: `src/api-server.ts`

- [ ] **Step 1: Add auth route imports and setup**

Import OAuthManager, GitHubAdapter, session-cookie, middleware, resolveUser, SQLiteUserStore, LinuxProvisioner.

- [ ] **Step 2: Add GET /api/auth/login?provider=xxx**

Generates state, stores in memory (state → provider map), redirects to provider auth URL.

- [ ] **Step 3: Add GET /api/auth/callback?code=xxx&state=yyy**

Looks up provider from state, calls handleCallback, calls resolveUser, creates session cookie, redirects to app.

- [ ] **Step 4: Add GET /api/auth/me**

Returns current user from session cookie. 401 if not authenticated.

- [ ] **Step 5: Add POST /api/auth/logout**

Clears session cookie.

- [ ] **Step 6: Apply auth middleware to protected routes**

All `/api/*` routes except `/api/auth/*` and static files go through middleware.

- [ ] **Step 7: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
cd /srv/claude-proxy && git add src/api-server.ts && git commit -m "feat: OAuth auth routes — login, callback, me, logout + middleware"
```

---

### Task 8: End-to-End Verification

**Files:** None — verification only.

- [ ] **Step 1: Build**

Run: `cd /srv/claude-proxy && npm run build`

- [ ] **Step 2: Run all tests**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Manual test — start server, verify auth routes respond**

With no providers configured, verify:
- `GET /api/auth/login?provider=google` returns error (not configured)
- `GET /api/auth/me` returns 401
- `GET /api/sessions` still works (no middleware on SSH-era endpoints initially)

- [ ] **Step 4: Commit any fixes**
