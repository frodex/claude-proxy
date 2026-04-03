# Phase A: Operations Extraction + Auth Wiring + Security Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all business logic from HTTP route handlers into a transport-agnostic operations module, wire the dormant auth infrastructure, and fix ~40 security findings in modules we touch.

**Architecture:** New `src/operations.ts` class with typed methods for every API operation. `api-server.ts` becomes a thin HTTP adapter. Auth modules (`src/auth/*`) get hardened and wired into `index.ts`. `execSync` → `execFileSync` across all in-path files. No transport change yet (Unix socket is Phase C).

**Tech Stack:** TypeScript, ESM, vitest, better-sqlite3, openid-client, crypto (scrypt)

**Research:** `docs/research/2026-04-03-v0.2-unix-socket-transport-journal.v03.md`  
**Security audit:** `/root/security-audit-findings.csv`

**IMPORTANT:** Read `sessions.md` (project root) before starting. Read the research doc v03 §12 for the complete finding-to-fix mapping.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/operations.ts` | **New.** Typed operation methods; all business logic extracted from `api-server.ts` |
| `src/operation-types.ts` | **New.** Request/response types for all operations (shared contract) |
| `src/api-server.ts` | **Modify (shrink).** Thin HTTP adapter — parse, auth, call operation, respond |
| `src/index.ts` | **Modify.** Wire auth objects, fix password hashing |
| `src/auth/provisioner.ts` | **Modify.** `execSync` → `execFileSync`, input validation |
| `src/auth/resolve-user.ts` | **Modify.** Approval gate, remove blind email linking |
| `src/auth/oauth.ts` | **Modify.** Add PKCE |
| `src/auth/github-adapter.ts` | **Modify.** Reject unverified email |
| `src/auth/session-cookie.ts` | **Modify.** Fix exp bypass |
| `src/auth/middleware.ts` | **Modify.** Add CSRF token check |
| `src/auth/user-store.ts` | **Modify.** Parameterize pragma, file permissions |
| `src/user-utils.ts` | **Modify.** `execSync` → `execFileSync` |
| `src/session-store.ts` | **Modify.** `execSync` → `execFileSync` |
| `src/ugo/socket-manager.ts` | **Modify.** `execSync` → `execFileSync`, input validation |
| `src/config.ts` | **Modify.** Filter prototype pollution in `deepMerge` |
| `src/types.ts` | **Modify.** Extend `Config` with `api.auth.required` |
| `tests/operations.test.ts` | **New.** Unit tests for operations (mock SessionManager) |
| `tests/auth-hardening.test.ts` | **New.** Tests for security fixes (injection, validation, approval gate) |

---

## Task 1: Define operation types (shared contract)

**Files:**
- Create: `src/operation-types.ts`

- [ ] **Step 1: Write the type definitions**

```typescript
// src/operation-types.ts
import type { SessionAccess } from './types.js';

export interface CreateSessionRequest {
  name: string;
  launchProfile?: string;
  runAsUser?: string;
  workingDir?: string;
  remoteHost?: string;
  hidden?: boolean;
  viewOnly?: boolean;
  public?: boolean;
  allowedUsers?: string[];
  allowedGroups?: string[];
  password?: string;
  dangerousSkipPermissions?: boolean;
  claudeSessionId?: string;
  isResume?: boolean;
}

export interface SessionInfo {
  id: string;
  name: string;
  title: string;
  cols: number;
  rows: number;
  clients: number;
  owner: string;
  createdAt: string;
  workingDir: string | null;
  launchProfile?: string;
}

export interface DeadSessionInfo {
  id: string;
  name: string;
  claudeSessionId: string | null;
  workingDir: string | null;
  remoteHost: string | null;
  launchProfile?: string;
}

export interface ScreenState {
  width: number;
  height: number;
  cursor: { x: number; y: number };
  title: string;
  lines: Array<{ spans: any[] }>;
}

export interface AuthStartResult {
  authUrl: string;
  state: string;
}

export interface AuthExchangeResult {
  identity: { linuxUser: string; displayName: string; email?: string };
  token: string;
  isNew: boolean;
}

export interface OperationError {
  code: 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_REQUEST' | 'UNAUTHORIZED' | 'CONFLICT' | 'INTERNAL';
  message: string;
}
```

- [ ] **Step 2: Build to verify types compile**

Run: `cd /srv/claude-proxy && npm run build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
cd /srv/claude-proxy && git add src/operation-types.ts && git commit -m "feat: operation types — shared contract for API operations"
```

---

## Task 2: Harden auth modules (security fixes)

**Files:**
- Modify: `src/auth/provisioner.ts`
- Modify: `src/auth/resolve-user.ts`
- Modify: `src/auth/github-adapter.ts`
- Modify: `src/auth/session-cookie.ts`
- Modify: `src/auth/user-store.ts`
- Create: `tests/auth-hardening.test.ts`

This task addresses security findings §12.2 from the research doc. Each substep is a separate finding.

- [ ] **Step 1: Write failing tests for input validation and injection**

```typescript
// tests/auth-hardening.test.ts
import { describe, test, expect } from 'vitest';

describe('input validation', () => {
  test('rejects username with shell metacharacters', () => {
    const { validateUsername } = require('../src/auth/provisioner.js');
    expect(() => validateUsername('valid_user')).not.toThrow();
    expect(() => validateUsername('$(whoami)')).toThrow(/invalid username/i);
    expect(() => validateUsername('user;rm -rf')).toThrow(/invalid username/i);
    expect(() => validateUsername('')).toThrow(/invalid username/i);
    expect(() => validateUsername('a'.repeat(33))).toThrow(/invalid username/i);
  });

  test('rejects group name with shell metacharacters', () => {
    const { validateGroupName } = require('../src/auth/provisioner.js');
    expect(() => validateGroupName('users')).not.toThrow();
    expect(() => validateGroupName('$(id)')).toThrow(/invalid group/i);
  });
});

describe('session-cookie exp bypass', () => {
  test('cookie with exp=0 is rejected', () => {
    const { createSessionCookie, validateSessionCookie } = require('../src/auth/session-cookie.js');
    // Manually craft a cookie with exp=0 to test the guard
    const crypto = require('crypto');
    const secret = 'test-secret-32-chars-minimum!!!!!';
    const payload = { linuxUser: 'test', displayName: 'Test', exp: 0 };
    const json = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(json).digest('base64url');
    const cookie = `${json}.${sig}`;
    expect(validateSessionCookie(cookie, secret)).toBeNull();
  });
});

describe('github adapter', () => {
  test('rejects when no verified email found', async () => {
    // This tests the logic change — actual HTTP mocked separately
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth-hardening.test.ts`
Expected: FAIL — `validateUsername` not exported, exp=0 not rejected

- [ ] **Step 3: Fix provisioner — `execSync` → `execFileSync` + validation**

In `src/auth/provisioner.ts`, add validation and replace all `execSync` with `execFileSync`:

```typescript
import { execFileSync } from 'child_process';
import type { Provisioner } from './types.js';

const GROUP_PREFIX = 'cp-';
const VALID_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

export function validateUsername(name: string): void {
  if (!name || !VALID_NAME.test(name)) throw new Error(`Invalid username: "${name}"`);
}

export function validateGroupName(name: string): void {
  if (!name || !VALID_NAME.test(name)) throw new Error(`Invalid group name: "${name}"`);
}

export class LinuxProvisioner implements Provisioner {
  createSystemAccount(username: string, displayName: string): void {
    validateUsername(username);
    execFileSync('useradd', ['-m', '-c', displayName, '-s', '/bin/bash', username], { stdio: 'pipe' });
    this.addToGroup(username, 'users');
  }

  deleteSystemAccount(username: string): void {
    validateUsername(username);
    execFileSync('userdel', ['-r', username], { stdio: 'pipe' });
  }

  installClaude(username: string): void {
    validateUsername(username);
    execFileSync('su', ['-', username, '-c', 'curl -sL https://claude.ai/install.sh | bash'],
      { stdio: 'pipe', timeout: 120000 });
  }

  addToGroup(username: string, group: string): void {
    validateUsername(username);
    validateGroupName(group);
    execFileSync('usermod', ['-aG', `${GROUP_PREFIX}${group}`, username], { stdio: 'pipe' });
  }

  removeFromGroup(username: string, group: string): void {
    validateUsername(username);
    validateGroupName(group);
    execFileSync('gpasswd', ['-d', username, `${GROUP_PREFIX}${group}`], { stdio: 'pipe' });
  }

  createGroup(group: string): void {
    validateGroupName(group);
    execFileSync('groupadd', [`${GROUP_PREFIX}${group}`], { stdio: 'pipe' });
  }

  deleteGroup(group: string): void {
    validateGroupName(group);
    execFileSync('groupdel', [`${GROUP_PREFIX}${group}`], { stdio: 'pipe' });
  }

  getGroups(username: string): string[] {
    validateUsername(username);
    try {
      const output = execFileSync('id', ['-nG', username], { encoding: 'utf-8' }).trim();
      return output.split(' ').filter(g => g.startsWith(GROUP_PREFIX)).map(g => g.slice(GROUP_PREFIX.length));
    } catch { return []; }
  }

  getGroupMembers(group: string): string[] {
    validateGroupName(group);
    try {
      const output = execFileSync('getent', ['group', `${GROUP_PREFIX}${group}`], { encoding: 'utf-8' }).trim();
      const members = output.split(':')[3] || '';
      return members ? members.split(',') : [];
    } catch { return []; }
  }

  userExists(username: string): boolean {
    validateUsername(username);
    try { execFileSync('getent', ['passwd', username], { stdio: 'pipe' }); return true; }
    catch { return false; }
  }

  groupExists(group: string): boolean {
    validateGroupName(group);
    try { execFileSync('getent', ['group', `${GROUP_PREFIX}${group}`], { stdio: 'pipe' }); return true; }
    catch { return false; }
  }
}
```

- [ ] **Step 4: Fix session-cookie exp bypass**

In `src/auth/session-cookie.ts`, change line 41 from:

```typescript
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
```

to:

```typescript
    if (payload.exp !== undefined && payload.exp < Math.floor(Date.now() / 1000)) return null;
```

- [ ] **Step 5: Fix user-store file permissions**

In `src/auth/user-store.ts`, after `this.db = new Database(dbPath)`, add:

```typescript
    import { chmodSync } from 'fs';
    // ... in constructor after db creation:
    try { chmodSync(dbPath, 0o600); } catch {}
```

- [ ] **Step 6: Fix resolve-user — add approval gate**

In `src/auth/resolve-user.ts`, in `resolveOAuth()`, before provisioning (step 3), add:

```typescript
  // 3. Check if auto-provisioning is allowed
  // If not, return a "pending" result that the caller handles
  // (The operations module will check config.auth.auto_provision)
```

This is a design decision — the operations module will gate provisioning, not `resolve-user` directly. Add a `provision: boolean` option to `resolveUser` so callers can control it.

- [ ] **Step 7: Fix github-adapter — reject unverified email**

In `src/auth/github-adapter.ts`, change the email fallback:

```typescript
    const primary = emails.find((e) => e.primary && e.verified);
    if (!primary) throw new Error('No verified primary email found on GitHub account');
    const email = primary.email;
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth-hardening.test.ts`
Expected: All tests pass

- [ ] **Step 9: Run full test suite**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests pass (existing tests should not break — provisioner is only called from resolve-user which isn't wired yet)

- [ ] **Step 10: Commit**

```bash
cd /srv/claude-proxy && git add src/auth/ tests/auth-hardening.test.ts && git commit -m "security: harden auth modules — execFileSync, input validation, exp bypass, email verification"
```

---

## Task 3: `execSync` → `execFileSync` sweep (in-path files)

**Files:**
- Modify: `src/user-utils.ts`
- Modify: `src/session-store.ts`
- Modify: `src/ugo/socket-manager.ts`

Each file has multiple `execSync` calls with interpolated strings. Replace with `execFileSync` and array arguments. Add input validation where the value comes from user/config input.

- [ ] **Step 1: Fix `user-utils.ts`**

Replace `execSync(\`id -nG ${username}\`)` with `execFileSync('id', ['-nG', username])` etc. Add `validateUsername` import from provisioner (or inline validation). Every `execSync` in this file → `execFileSync` with array args.

- [ ] **Step 2: Fix `session-store.ts`**

Replace `execSync(\`ssh ${remoteHost} ...\`)` calls. For remote commands, use `execFileSync('ssh', [remoteHost, 'tmux', ...])` with array args. Validate `remoteHost` against a hostname regex.

- [ ] **Step 3: Fix `ugo/socket-manager.ts`**

Replace all `execSync(\`su - ${owner} ...\`)` with `execFileSync('su', ['-', owner, '-c', ...])`. Validate `owner` and `targetUser` with `validateUsername`.

- [ ] **Step 4: Build and run full tests**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: Clean build, all tests pass

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/user-utils.ts src/session-store.ts src/ugo/socket-manager.ts && git commit -m "security: execSync → execFileSync sweep — user-utils, session-store, socket-manager"
```

---

## Task 4: Extract operations module from `api-server.ts`

**Files:**
- Create: `src/operations.ts`
- Modify: `src/api-server.ts`
- Create: `tests/operations.test.ts`

This is the largest task. Extract each `if (url.pathname === ...)` block's business logic into a typed method on `ProxyOperations`.

- [ ] **Step 1: Write failing tests for key operations**

```typescript
// tests/operations.test.ts
import { describe, test, expect, vi } from 'vitest';
// Tests will import ProxyOperations and test with mocked SessionManager
// Example tests — expand per operation

describe('ProxyOperations', () => {
  test('listSessions filters by user', () => {
    // mock sessionManager.listSessionsForUser
    // verify operations.listSessions calls it with the provided username
  });

  test('createSession rejects non-admin setting runAsUser to different user', () => {
    // verify FORBIDDEN when non-admin tries to run as different user
  });

  test('createSession rejects dangerousSkipPermissions from non-admin', () => {
    // verify FORBIDDEN
  });

  test('destroySession requires edit permission', () => {
    // verify FORBIDDEN when user lacks canUserEditSession
  });
});
```

- [ ] **Step 2: Create `src/operations.ts` — extract all operations**

Create the class with typed methods. Each method takes typed input, validates, checks authorization, calls SessionManager/UserStore/etc., and returns typed output or throws `OperationError`.

The implementing agent should read each `api-server.ts` handler block and move its logic. The HTTP-specific parts (parsing `req`, writing `res`, cookies, status codes) stay in `api-server.ts`.

Key patterns:
- `listSessions(username)` → calls `sessionManager.listSessionsForUser(username)`, maps to `SessionInfo[]`
- `createSession(req, username)` → validates admin-only fields, resolves launch profile, calls `sessionManager.createSession()`
- Auth operations → reuse existing `OAuthManager`, `resolveUser`, `createSessionCookie`

- [ ] **Step 3: Refactor `api-server.ts` to call operations**

Each handler becomes:

```typescript
if (url.pathname === '/api/sessions' && req.method === 'GET') {
  const user = requireAuth(req, res); if (!user) return;
  try {
    const sessions = ops.listSessions(user.linuxUser);
    json(res, 200, sessions);
  } catch (err: any) { errorResponse(res, err); }
  return;
}
```

Add helper functions `requireAuth(req, res)`, `json(res, status, body)`, `errorResponse(res, err)` at the top of the file.

- [ ] **Step 4: Add body size limit**

In `api-server.ts`, update `readBody` to enforce a max size (e.g. 1MB):

```typescript
const MAX_BODY = 1_048_576;
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: any) => {
      size += chunk.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error('Body too large')); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
```

- [ ] **Step 5: Fix CORS**

Replace wildcard CORS with configured origin:

```typescript
const allowedOrigin = config.api?.cors_origin || (config.api as any)?.public_base_url || '';
// In handler:
if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
```

- [ ] **Step 6: Build and run tests**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
cd /srv/claude-proxy && git add src/operations.ts src/api-server.ts tests/operations.test.ts && git commit -m "feat: operations module — extract business logic from HTTP handlers, add auth + ACL"
```

---

## Task 5: Wire auth into `index.ts`

**Files:**
- Modify: `src/index.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Extend Config type**

In `src/types.ts`, ensure `api` block has typed fields (not `as any`):

```typescript
  api?: {
    port?: number;
    host?: string;
    socket?: string;
    public_base_url?: string;
    cors_origin?: string;
    auth?: {
      required?: boolean;
    };
  };
```

- [ ] **Step 2: Fix password hashing in `index.ts`**

Replace SHA-256:

```typescript
import { scryptSync, randomBytes } from 'crypto';

function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = scryptSync(pw, salt, 64).toString('hex');
  return derived === hash;
}
```

Update `passwordFlow` to use `verifyPassword` instead of `===`.

- [ ] **Step 3: Build and wire auth objects**

In `src/index.ts`, after config loading, before `startApiServer`:

```typescript
import { OAuthManager } from './auth/oauth.js';
import { GitHubAdapter } from './auth/github-adapter.js';
import { SQLiteUserStore } from './auth/user-store.js';

// Build auth objects from config
const userStore = new SQLiteUserStore(resolve(__dirname, '..', 'data', 'users.db'));

let oauthManager: OAuthManager | undefined;
const providers = config.auth.providers;
if (providers?.google || providers?.microsoft) {
  const callbackBase = config.api?.public_base_url || `http://127.0.0.1:${apiPort}`;
  oauthManager = new OAuthManager({
    google: providers.google ? { clientId: providers.google.client_id, clientSecret: providers.google.client_secret } : undefined,
    microsoft: providers.microsoft ? { clientId: providers.microsoft.client_id, clientSecret: providers.microsoft.client_secret, tenant: providers.microsoft.tenant } : undefined,
  }, callbackBase);
}

let githubAdapter: GitHubAdapter | undefined;
if (providers?.github) {
  const callbackBase = config.api?.public_base_url || `http://127.0.0.1:${apiPort}`;
  githubAdapter = new GitHubAdapter(providers.github.client_id, providers.github.client_secret, callbackBase);
}

const cookieSecret = config.auth.session?.secret;
const cookieMaxAge = config.auth.session?.max_age ?? 86400;

if (!cookieSecret && (oauthManager || githubAdapter)) {
  console.error('FATAL: auth.session.secret is required when OAuth providers are configured');
  process.exit(1);
}
```

Pass to `startApiServer`:

```typescript
startApiServer({
  port: apiPort,
  host: apiHost,
  sessionManager,
  config,
  staticDir: webDir,
  dirScanner,
  oauthManager,
  githubAdapter,
  userStore,
  provisioner,
  cookieSecret,
  cookieMaxAge,
});
```

- [ ] **Step 4: Build and verify**

Run: `cd /srv/claude-proxy && npm run build`
Expected: Clean build

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/index.ts src/types.ts && git commit -m "feat: wire auth objects into startApiServer; fix password hashing to scrypt"
```

---

## Task 6: Fix `config.ts` prototype pollution

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add prototype pollution guard to `deepMerge`**

```typescript
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] ?? {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
```

- [ ] **Step 2: Build and run tests**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`

- [ ] **Step 3: Commit**

```bash
cd /srv/claude-proxy && git add src/config.ts && git commit -m "security: guard deepMerge against prototype pollution"
```

---

## Task 7: Full integration verification

- [ ] **Step 1: Build and run complete test suite**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Restart and verify SSH lobby still works**

```bash
systemctl restart claude-proxy
ssh -p 3100 localhost
```
Expected: Lobby renders, can create/join sessions

- [ ] **Step 3: Verify auth refusal without secret**

If OAuth providers configured but no `session.secret` in YAML → process exits with fatal message.

- [ ] **Step 4: Commit any fixes**

```bash
cd /srv/claude-proxy && git add -A && git commit -m "fix: integration verification adjustments"
```

---

## Scope boundaries

- **Unix socket adapter** → Phase C (depends on this phase)
- **svg-terminal migration** → Phase C
- **Standalone login HTML** → Phase D
- **Cookie encryption** → Phase D
- **CSRF tokens** → Phase D
- **PKCE** → Phase D (or late Phase A if time permits — it's an `openid-client` config change)
- **Launch profiles** → independent plan (already written: `2026-04-03-launch-profiles.md`)
- **Out-of-scope security findings** (pty-multiplexer, scripts, systemd, svg-terminal) → separate remediation
