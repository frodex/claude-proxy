# Auth Shared Contract Implementation Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared interfaces and SQLite implementation that both UGO security (Plan B) and OAuth (Plan C) build on.

**Architecture:** Three contracts — `UserStore` (persistence), `Provisioner` (system account management), `resolveUser()` (identity resolution). SQLite implementation of UserStore. Linux command wrapper for Provisioner. TDD with contract tests first.

**Tech Stack:** TypeScript, better-sqlite3-multiple-ciphers (encrypted SQLite), vitest

**Spec:** `docs/superpowers/specs/2026-03-29-auth-ugo-security-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/auth/types.ts` | Shared types: UserIdentity, SshSource, OAuthSource, ResolveResult |
| `src/auth/user-store.ts` | UserStore interface + SQLiteUserStore implementation |
| `src/auth/provisioner.ts` | Provisioner interface + LinuxProvisioner implementation |
| `src/auth/resolve-user.ts` | resolveUser() function — routes SSH/OAuth to the right lookup/provision path |
| `tests/auth/user-store.test.ts` | SQLiteUserStore CRUD tests |
| `tests/auth/provisioner.test.ts` | LinuxProvisioner tests (mocked execSync) |
| `tests/auth/resolve-user.test.ts` | resolveUser integration tests |

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install better-sqlite3-multiple-ciphers**

```bash
cd /srv/claude-proxy && npm install better-sqlite3-multiple-ciphers
```

- [ ] **Step 2: Install type definitions**

```bash
cd /srv/claude-proxy && npm install -D @types/better-sqlite3
```

- [ ] **Step 3: Verify build still works**

Run: `cd /srv/claude-proxy && npm run build`
Expected: Compiles without errors

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add package.json package-lock.json && git commit -m "deps: add better-sqlite3-multiple-ciphers for encrypted user store"
```

---

### Task 2: Shared Types

**Files:**
- Create: `src/auth/types.ts`
- Test: `tests/auth/types.test.ts`

- [ ] **Step 1: Write the type file**

```typescript
// src/auth/types.ts

export interface UserIdentity {
  linuxUser: string;
  displayName: string;
  email?: string;
  groups: string[];
  createdAt: Date;
  lastLogin: Date;
}

export interface ProviderLink {
  provider: string;
  providerId: string;
  linuxUser: string;
  email?: string;
  linkedAt: Date;
}

export interface SshSource {
  type: 'ssh';
  linuxUser: string;
}

export interface OAuthSource {
  type: 'oauth';
  provider: string;
  providerId: string;
  email: string;
  displayName: string;
}

export type AuthSource = SshSource | OAuthSource;

export interface ResolveResult {
  identity: UserIdentity;
  isNew: boolean;
}

export interface UserStore {
  findByLinuxUser(username: string): UserIdentity | null;
  findByProvider(provider: string, providerId: string): UserIdentity | null;
  findByEmail(email: string): UserIdentity | null;

  createUser(identity: UserIdentity): void;
  updateLastLogin(linuxUser: string): void;
  linkProvider(linuxUser: string, provider: string, providerId: string, email?: string): void;
  getProviderLinks(linuxUser: string): ProviderLink[];

  listUsers(): UserIdentity[];
  listByGroup(group: string): UserIdentity[];

  close(): void;
}

export interface Provisioner {
  createSystemAccount(username: string, displayName: string): void;
  deleteSystemAccount(username: string): void;
  installClaude(username: string): void;

  addToGroup(username: string, group: string): void;
  removeFromGroup(username: string, group: string): void;

  createGroup(group: string): void;
  deleteGroup(group: string): void;

  getGroups(username: string): string[];
  getGroupMembers(group: string): string[];

  userExists(username: string): boolean;
  groupExists(group: string): boolean;
}
```

- [ ] **Step 2: Write a basic type check test**

```typescript
// tests/auth/types.test.ts
import { test, expect } from 'vitest';
import type { UserIdentity, SshSource, OAuthSource, UserStore, Provisioner } from '../src/auth/types.js';

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
```

- [ ] **Step 3: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/types.test.ts`
Expected: 2 tests PASS

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/auth/types.ts tests/auth/types.test.ts && git commit -m "feat: auth shared types — UserIdentity, AuthSource, UserStore, Provisioner interfaces"
```

---

### Task 3: SQLiteUserStore — Tests First

**Files:**
- Create: `tests/auth/user-store.test.ts`

- [ ] **Step 1: Write all UserStore contract tests**

```typescript
// tests/auth/user-store.test.ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteUserStore } from '../src/auth/user-store.js';
import { rmSync } from 'fs';

const TEST_DB = '/tmp/claude-proxy-test-users.db';

let store: SQLiteUserStore;

beforeEach(() => {
  rmSync(TEST_DB, { force: true });
  store = new SQLiteUserStore(TEST_DB, 'test-encryption-key');
});

afterEach(() => {
  store.close();
  rmSync(TEST_DB, { force: true });
});

test('createUser and findByLinuxUser', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    email: 'greg@example.com',
    groups: ['users', 'devteam'],
    createdAt: new Date('2026-03-29T00:00:00Z'),
    lastLogin: new Date('2026-03-29T00:00:00Z'),
  });

  const user = store.findByLinuxUser('greg');
  expect(user).not.toBeNull();
  expect(user!.linuxUser).toBe('greg');
  expect(user!.displayName).toBe('Greg');
  expect(user!.email).toBe('greg@example.com');
  expect(user!.groups).toEqual(['users', 'devteam']);
});

test('findByLinuxUser returns null for nonexistent user', () => {
  expect(store.findByLinuxUser('nobody')).toBeNull();
});

test('findByEmail returns matching user', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    email: 'greg@example.com',
    groups: [],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  const user = store.findByEmail('greg@example.com');
  expect(user).not.toBeNull();
  expect(user!.linuxUser).toBe('greg');
});

test('findByEmail returns null for no match', () => {
  expect(store.findByEmail('nobody@example.com')).toBeNull();
});

test('updateLastLogin changes the timestamp', () => {
  const oldDate = new Date('2026-01-01T00:00:00Z');
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: [],
    createdAt: oldDate,
    lastLogin: oldDate,
  });

  store.updateLastLogin('greg');
  const user = store.findByLinuxUser('greg');
  expect(user!.lastLogin.getTime()).toBeGreaterThan(oldDate.getTime());
});

test('linkProvider and findByProvider', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: [],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  store.linkProvider('greg', 'google', 'google-12345', 'greg@gmail.com');

  const user = store.findByProvider('google', 'google-12345');
  expect(user).not.toBeNull();
  expect(user!.linuxUser).toBe('greg');
});

test('findByProvider returns null for unlinked provider', () => {
  expect(store.findByProvider('google', 'unknown-id')).toBeNull();
});

test('getProviderLinks returns all links for a user', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: [],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  store.linkProvider('greg', 'google', 'g-123', 'greg@gmail.com');
  store.linkProvider('greg', 'github', 'gh-456', 'greg@github.com');

  const links = store.getProviderLinks('greg');
  expect(links).toHaveLength(2);
  expect(links.map(l => l.provider).sort()).toEqual(['github', 'google']);
});

test('listUsers returns all users', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: [],
    createdAt: new Date(),
    lastLogin: new Date(),
  });
  store.createUser({
    linuxUser: 'frodex',
    displayName: 'Frodex',
    groups: [],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  const users = store.listUsers();
  expect(users).toHaveLength(2);
  expect(users.map(u => u.linuxUser).sort()).toEqual(['frodex', 'greg']);
});

test('listByGroup returns users in a specific group', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: ['devteam', 'users'],
    createdAt: new Date(),
    lastLogin: new Date(),
  });
  store.createUser({
    linuxUser: 'frodex',
    displayName: 'Frodex',
    groups: ['users'],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  const devteam = store.listByGroup('devteam');
  expect(devteam).toHaveLength(1);
  expect(devteam[0].linuxUser).toBe('greg');

  const users = store.listByGroup('users');
  expect(users).toHaveLength(2);
});

test('groups are stored and retrieved correctly', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: ['users', 'admins', 'devteam'],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  const user = store.findByLinuxUser('greg');
  expect(user!.groups).toEqual(['users', 'admins', 'devteam']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/user-store.test.ts`
Expected: FAIL — module `../src/auth/user-store.js` not found

- [ ] **Step 3: Commit test file**

```bash
cd /srv/claude-proxy && git add tests/auth/user-store.test.ts && git commit -m "test: UserStore contract tests (red — implementation pending)"
```

---

### Task 4: SQLiteUserStore — Implementation

**Files:**
- Create: `src/auth/user-store.ts`

- [ ] **Step 1: Implement SQLiteUserStore**

```typescript
// src/auth/user-store.ts
import Database from 'better-sqlite3-multiple-ciphers';
import type { UserIdentity, ProviderLink, UserStore } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  linux_user TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  groups_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_login TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_links (
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  linux_user TEXT NOT NULL REFERENCES users(linux_user),
  email TEXT,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_links_user ON provider_links(linux_user);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`;

export class SQLiteUserStore implements UserStore {
  private db: InstanceType<typeof Database>;

  constructor(dbPath: string, encryptionKey?: string) {
    this.db = new Database(dbPath);
    if (encryptionKey) {
      this.db.pragma(`key='${encryptionKey}'`);
    }
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  findByLinuxUser(username: string): UserIdentity | null {
    const row = this.db.prepare('SELECT * FROM users WHERE linux_user = ?').get(username) as any;
    return row ? this.rowToIdentity(row) : null;
  }

  findByProvider(provider: string, providerId: string): UserIdentity | null {
    const link = this.db.prepare(
      'SELECT linux_user FROM provider_links WHERE provider = ? AND provider_id = ?'
    ).get(provider, providerId) as any;
    if (!link) return null;
    return this.findByLinuxUser(link.linux_user);
  }

  findByEmail(email: string): UserIdentity | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    return row ? this.rowToIdentity(row) : null;
  }

  createUser(identity: UserIdentity): void {
    this.db.prepare(
      'INSERT INTO users (linux_user, display_name, email, groups_json, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      identity.linuxUser,
      identity.displayName,
      identity.email ?? null,
      JSON.stringify(identity.groups),
      identity.createdAt.toISOString(),
      identity.lastLogin.toISOString(),
    );
  }

  updateLastLogin(linuxUser: string): void {
    this.db.prepare(
      'UPDATE users SET last_login = ? WHERE linux_user = ?'
    ).run(new Date().toISOString(), linuxUser);
  }

  linkProvider(linuxUser: string, provider: string, providerId: string, email?: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO provider_links (provider, provider_id, linux_user, email, linked_at) VALUES (?, ?, ?, ?, ?)'
    ).run(provider, providerId, linuxUser, email ?? null, new Date().toISOString());
  }

  getProviderLinks(linuxUser: string): ProviderLink[] {
    const rows = this.db.prepare(
      'SELECT * FROM provider_links WHERE linux_user = ?'
    ).all(linuxUser) as any[];
    return rows.map(row => ({
      provider: row.provider,
      providerId: row.provider_id,
      linuxUser: row.linux_user,
      email: row.email ?? undefined,
      linkedAt: new Date(row.linked_at),
    }));
  }

  listUsers(): UserIdentity[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY linux_user').all() as any[];
    return rows.map(row => this.rowToIdentity(row));
  }

  listByGroup(group: string): UserIdentity[] {
    // SQLite JSON — filter users whose groups_json contains the group
    const rows = this.db.prepare('SELECT * FROM users ORDER BY linux_user').all() as any[];
    return rows
      .map(row => this.rowToIdentity(row))
      .filter(user => user.groups.includes(group));
  }

  close(): void {
    this.db.close();
  }

  private rowToIdentity(row: any): UserIdentity {
    return {
      linuxUser: row.linux_user,
      displayName: row.display_name,
      email: row.email ?? undefined,
      groups: JSON.parse(row.groups_json),
      createdAt: new Date(row.created_at),
      lastLogin: new Date(row.last_login),
    };
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/user-store.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 3: Run all tests to check for regressions**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/auth/user-store.ts && git commit -m "feat: SQLiteUserStore — encrypted user persistence with provider links"
```

---

### Task 5: LinuxProvisioner — Tests First

**Files:**
- Create: `tests/auth/provisioner.test.ts`

- [ ] **Step 1: Write Provisioner tests with mocked execSync**

```typescript
// tests/auth/provisioner.test.ts
import { test, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { LinuxProvisioner } from '../src/auth/provisioner.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockExec = vi.mocked(execSync);

let provisioner: LinuxProvisioner;

beforeEach(() => {
  vi.clearAllMocks();
  provisioner = new LinuxProvisioner();
});

test('createSystemAccount runs useradd with correct args', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.createSystemAccount('newuser', 'New User');

  expect(mockExec).toHaveBeenCalledWith(
    expect.stringContaining('useradd'),
    expect.any(Object),
  );
  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('newuser');
  expect(cmd).toContain('New User');
});

test('deleteSystemAccount runs userdel', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.deleteSystemAccount('olduser');

  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('userdel');
  expect(cmd).toContain('olduser');
});

test('addToGroup runs usermod -aG with cp- prefix', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.addToGroup('greg', 'devteam');

  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('usermod');
  expect(cmd).toContain('-aG');
  expect(cmd).toContain('cp-devteam');
  expect(cmd).toContain('greg');
});

test('removeFromGroup runs gpasswd -d with cp- prefix', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.removeFromGroup('greg', 'devteam');

  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('gpasswd');
  expect(cmd).toContain('-d');
  expect(cmd).toContain('greg');
  expect(cmd).toContain('cp-devteam');
});

test('createGroup runs groupadd with cp- prefix', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.createGroup('devteam');

  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('groupadd');
  expect(cmd).toContain('cp-devteam');
});

test('deleteGroup runs groupdel with cp- prefix', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.deleteGroup('devteam');

  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('groupdel');
  expect(cmd).toContain('cp-devteam');
});

test('getGroups parses id -nG output and strips cp- prefix', () => {
  mockExec.mockReturnValue('greg cp-users cp-devteam docker\n' as any);

  const groups = provisioner.getGroups('greg');
  expect(groups).toContain('users');
  expect(groups).toContain('devteam');
  expect(groups).not.toContain('greg');
  expect(groups).not.toContain('docker');
});

test('getGroupMembers parses getent group output', () => {
  mockExec.mockReturnValue('cp-devteam:x:1001:greg,frodex\n' as any);

  const members = provisioner.getGroupMembers('devteam');
  expect(members).toEqual(['greg', 'frodex']);
});

test('userExists returns true when getent succeeds', () => {
  mockExec.mockReturnValue('greg:x:1000:1000::/home/greg:/bin/bash\n' as any);
  expect(provisioner.userExists('greg')).toBe(true);
});

test('userExists returns false when getent fails', () => {
  mockExec.mockImplementation(() => { throw new Error('exit code 2'); });
  expect(provisioner.userExists('nobody')).toBe(false);
});

test('groupExists returns true when getent succeeds', () => {
  mockExec.mockReturnValue('cp-devteam:x:1001:\n' as any);
  expect(provisioner.groupExists('devteam')).toBe(true);
});

test('groupExists returns false when getent fails', () => {
  mockExec.mockImplementation(() => { throw new Error('exit code 2'); });
  expect(provisioner.groupExists('nobody')).toBe(false);
});

test('installClaude runs curl installer as the target user', () => {
  mockExec.mockReturnValue('' as any);
  provisioner.installClaude('newuser');

  const cmd = mockExec.mock.calls[0][0] as string;
  expect(cmd).toContain('su');
  expect(cmd).toContain('newuser');
  expect(cmd).toContain('curl');
  expect(cmd).toContain('claude.ai/install.sh');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/provisioner.test.ts`
Expected: FAIL — module `../src/auth/provisioner.js` not found

- [ ] **Step 3: Commit test file**

```bash
cd /srv/claude-proxy && git add tests/auth/provisioner.test.ts && git commit -m "test: LinuxProvisioner contract tests (red — implementation pending)"
```

---

### Task 6: LinuxProvisioner — Implementation

**Files:**
- Create: `src/auth/provisioner.ts`

- [ ] **Step 1: Implement LinuxProvisioner**

```typescript
// src/auth/provisioner.ts
import { execSync } from 'child_process';
import type { Provisioner } from './types.js';

const GROUP_PREFIX = 'cp-';

export class LinuxProvisioner implements Provisioner {
  createSystemAccount(username: string, displayName: string): void {
    execSync(
      `useradd -m -c '${displayName.replace(/'/g, "\\'")}' -s /bin/bash ${username}`,
      { stdio: 'pipe' },
    );
    // Add to base cp-users group
    this.addToGroup(username, 'users');
  }

  deleteSystemAccount(username: string): void {
    execSync(`userdel -r ${username}`, { stdio: 'pipe' });
  }

  installClaude(username: string): void {
    execSync(
      `su - ${username} -c 'curl -sL https://claude.ai/install.sh | bash'`,
      { stdio: 'pipe', timeout: 120000 },
    );
  }

  addToGroup(username: string, group: string): void {
    const systemGroup = `${GROUP_PREFIX}${group}`;
    execSync(`usermod -aG ${systemGroup} ${username}`, { stdio: 'pipe' });
  }

  removeFromGroup(username: string, group: string): void {
    const systemGroup = `${GROUP_PREFIX}${group}`;
    execSync(`gpasswd -d ${username} ${systemGroup}`, { stdio: 'pipe' });
  }

  createGroup(group: string): void {
    const systemGroup = `${GROUP_PREFIX}${group}`;
    execSync(`groupadd ${systemGroup}`, { stdio: 'pipe' });
  }

  deleteGroup(group: string): void {
    const systemGroup = `${GROUP_PREFIX}${group}`;
    execSync(`groupdel ${systemGroup}`, { stdio: 'pipe' });
  }

  getGroups(username: string): string[] {
    try {
      const output = execSync(`id -nG ${username}`, { encoding: 'utf-8' }).trim();
      return output.split(' ')
        .filter(g => g.startsWith(GROUP_PREFIX))
        .map(g => g.slice(GROUP_PREFIX.length));
    } catch {
      return [];
    }
  }

  getGroupMembers(group: string): string[] {
    const systemGroup = `${GROUP_PREFIX}${group}`;
    try {
      const output = execSync(`getent group ${systemGroup}`, { encoding: 'utf-8' }).trim();
      const members = output.split(':')[3] || '';
      return members ? members.split(',') : [];
    } catch {
      return [];
    }
  }

  userExists(username: string): boolean {
    try {
      execSync(`getent passwd ${username}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  groupExists(group: string): boolean {
    const systemGroup = `${GROUP_PREFIX}${group}`;
    try {
      execSync(`getent group ${systemGroup}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/provisioner.test.ts`
Expected: All 13 tests PASS

- [ ] **Step 3: Run all tests**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/auth/provisioner.ts && git commit -m "feat: LinuxProvisioner — system account and group management"
```

---

### Task 7: resolveUser — Tests First

**Files:**
- Create: `tests/auth/resolve-user.test.ts`

- [ ] **Step 1: Write resolveUser tests**

```typescript
// tests/auth/resolve-user.test.ts
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveUser } from '../src/auth/resolve-user.js';
import { SQLiteUserStore } from '../src/auth/user-store.js';
import type { Provisioner, SshSource, OAuthSource } from '../src/auth/types.js';
import { rmSync } from 'fs';

const TEST_DB = '/tmp/claude-proxy-test-resolve.db';

let store: SQLiteUserStore;
let mockProvisioner: Provisioner;

beforeEach(() => {
  rmSync(TEST_DB, { force: true });
  store = new SQLiteUserStore(TEST_DB);
  mockProvisioner = {
    createSystemAccount: vi.fn(),
    deleteSystemAccount: vi.fn(),
    installClaude: vi.fn(),
    addToGroup: vi.fn(),
    removeFromGroup: vi.fn(),
    createGroup: vi.fn(),
    deleteGroup: vi.fn(),
    getGroups: vi.fn(() => ['users']),
    getGroupMembers: vi.fn(() => []),
    userExists: vi.fn(() => true),
    groupExists: vi.fn(() => true),
  };
});

afterEach(() => {
  store.close();
  rmSync(TEST_DB, { force: true });
});

test('SSH source resolves existing user from store', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: ['users'],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  const source: SshSource = { type: 'ssh', linuxUser: 'greg' };
  const result = resolveUser(source, store, mockProvisioner);

  expect(result.identity.linuxUser).toBe('greg');
  expect(result.isNew).toBe(false);
});

test('SSH source creates store entry for user not in store but on system', () => {
  (mockProvisioner.userExists as any).mockReturnValue(true);
  (mockProvisioner.getGroups as any).mockReturnValue(['users']);

  const source: SshSource = { type: 'ssh', linuxUser: 'existinguser' };
  const result = resolveUser(source, store, mockProvisioner);

  expect(result.identity.linuxUser).toBe('existinguser');
  expect(result.isNew).toBe(true);
  // Should be persisted
  expect(store.findByLinuxUser('existinguser')).not.toBeNull();
});

test('SSH source throws for user not on system', () => {
  (mockProvisioner.userExists as any).mockReturnValue(false);

  const source: SshSource = { type: 'ssh', linuxUser: 'ghost' };
  expect(() => resolveUser(source, store, mockProvisioner)).toThrow();
});

test('OAuth source resolves user by provider link', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    email: 'greg@gmail.com',
    groups: ['users'],
    createdAt: new Date(),
    lastLogin: new Date(),
  });
  store.linkProvider('greg', 'google', 'g-123', 'greg@gmail.com');

  const source: OAuthSource = {
    type: 'oauth',
    provider: 'google',
    providerId: 'g-123',
    email: 'greg@gmail.com',
    displayName: 'Greg',
  };
  const result = resolveUser(source, store, mockProvisioner);

  expect(result.identity.linuxUser).toBe('greg');
  expect(result.isNew).toBe(false);
});

test('OAuth source matches by email when no provider link', () => {
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    email: 'greg@gmail.com',
    groups: ['users'],
    createdAt: new Date(),
    lastLogin: new Date(),
  });

  const source: OAuthSource = {
    type: 'oauth',
    provider: 'github',
    providerId: 'gh-789',
    email: 'greg@gmail.com',
    displayName: 'Greg GH',
  };
  const result = resolveUser(source, store, mockProvisioner);

  expect(result.identity.linuxUser).toBe('greg');
  expect(result.isNew).toBe(false);
  // Should have created the provider link
  const links = store.getProviderLinks('greg');
  expect(links.find(l => l.provider === 'github')).toBeTruthy();
});

test('OAuth source provisions new account when no match', () => {
  (mockProvisioner.userExists as any).mockReturnValue(false);
  (mockProvisioner.getGroups as any).mockReturnValue(['users']);

  const source: OAuthSource = {
    type: 'oauth',
    provider: 'google',
    providerId: 'g-new',
    email: 'newperson@gmail.com',
    displayName: 'New Person',
  };
  const result = resolveUser(source, store, mockProvisioner);

  expect(result.isNew).toBe(true);
  expect(result.identity.linuxUser).toBe('newperson');
  expect(mockProvisioner.createSystemAccount).toHaveBeenCalledWith('newperson', 'New Person');
  expect(mockProvisioner.installClaude).toHaveBeenCalledWith('newperson');
  // Should be persisted with provider link
  expect(store.findByLinuxUser('newperson')).not.toBeNull();
  expect(store.findByProvider('google', 'g-new')).not.toBeNull();
});

test('OAuth provisioning handles username collision', () => {
  // greg already exists on system
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg Original',
    groups: [],
    createdAt: new Date(),
    lastLogin: new Date(),
  });
  (mockProvisioner.userExists as any)
    .mockReturnValueOnce(true)   // greg exists
    .mockReturnValueOnce(false)  // greg2 doesn't
    .mockReturnValueOnce(true);  // after creation
  (mockProvisioner.getGroups as any).mockReturnValue(['users']);

  const source: OAuthSource = {
    type: 'oauth',
    provider: 'google',
    providerId: 'g-dup',
    email: 'greg@otherdomain.com',
    displayName: 'Greg Other',
  };
  const result = resolveUser(source, store, mockProvisioner);

  expect(result.identity.linuxUser).toBe('greg2');
  expect(result.isNew).toBe(true);
});

test('OAuth updates lastLogin for returning user', () => {
  const oldDate = new Date('2026-01-01T00:00:00Z');
  store.createUser({
    linuxUser: 'greg',
    displayName: 'Greg',
    groups: ['users'],
    createdAt: oldDate,
    lastLogin: oldDate,
  });
  store.linkProvider('greg', 'google', 'g-123');

  const source: OAuthSource = {
    type: 'oauth',
    provider: 'google',
    providerId: 'g-123',
    email: 'greg@gmail.com',
    displayName: 'Greg',
  };
  resolveUser(source, store, mockProvisioner);

  const updated = store.findByLinuxUser('greg');
  expect(updated!.lastLogin.getTime()).toBeGreaterThan(oldDate.getTime());
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/resolve-user.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Commit test file**

```bash
cd /srv/claude-proxy && git add tests/auth/resolve-user.test.ts && git commit -m "test: resolveUser contract tests (red — implementation pending)"
```

---

### Task 8: resolveUser — Implementation

**Files:**
- Create: `src/auth/resolve-user.ts`

- [ ] **Step 1: Implement resolveUser**

```typescript
// src/auth/resolve-user.ts
import type { AuthSource, SshSource, OAuthSource, ResolveResult, UserStore, Provisioner } from './types.js';

function emailToUsername(email: string): string {
  // greg@example.com → greg
  return email.split('@')[0].replace(/[^a-z0-9_-]/gi, '').toLowerCase();
}

function findAvailableUsername(base: string, store: UserStore, provisioner: Provisioner): string {
  if (!store.findByLinuxUser(base) && !provisioner.userExists(base)) {
    return base;
  }
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}${i}`;
    if (!store.findByLinuxUser(candidate) && !provisioner.userExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Cannot find available username for base "${base}"`);
}

function resolveSsh(source: SshSource, store: UserStore, provisioner: Provisioner): ResolveResult {
  // Check store first
  const existing = store.findByLinuxUser(source.linuxUser);
  if (existing) {
    store.updateLastLogin(source.linuxUser);
    return { identity: { ...existing, lastLogin: new Date() }, isNew: false };
  }

  // Not in store — check if user exists on system
  if (!provisioner.userExists(source.linuxUser)) {
    throw new Error(`System user "${source.linuxUser}" does not exist`);
  }

  // Create store entry for existing system user
  const groups = provisioner.getGroups(source.linuxUser);
  const now = new Date();
  const identity = {
    linuxUser: source.linuxUser,
    displayName: source.linuxUser,
    groups,
    createdAt: now,
    lastLogin: now,
  };
  store.createUser(identity);
  return { identity, isNew: true };
}

function resolveOAuth(source: OAuthSource, store: UserStore, provisioner: Provisioner): ResolveResult {
  // 1. Check by provider link
  const byProvider = store.findByProvider(source.provider, source.providerId);
  if (byProvider) {
    store.updateLastLogin(byProvider.linuxUser);
    return { identity: { ...byProvider, lastLogin: new Date() }, isNew: false };
  }

  // 2. Check by email match
  const byEmail = store.findByEmail(source.email);
  if (byEmail) {
    // Link this provider to the existing account
    store.linkProvider(byEmail.linuxUser, source.provider, source.providerId, source.email);
    store.updateLastLogin(byEmail.linuxUser);
    return { identity: { ...byEmail, lastLogin: new Date() }, isNew: false };
  }

  // 3. Provision new account
  const baseUsername = emailToUsername(source.email);
  const username = findAvailableUsername(baseUsername, store, provisioner);

  provisioner.createSystemAccount(username, source.displayName);
  provisioner.installClaude(username);

  const groups = provisioner.getGroups(username);
  const now = new Date();
  const identity = {
    linuxUser: username,
    displayName: source.displayName,
    email: source.email,
    groups,
    createdAt: now,
    lastLogin: now,
  };
  store.createUser(identity);
  store.linkProvider(username, source.provider, source.providerId, source.email);

  return { identity, isNew: true };
}

export function resolveUser(
  source: AuthSource,
  store: UserStore,
  provisioner: Provisioner,
): ResolveResult {
  if (source.type === 'ssh') {
    return resolveSsh(source, store, provisioner);
  }
  return resolveOAuth(source, store, provisioner);
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/auth/resolve-user.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 3: Run all tests**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/auth/resolve-user.ts && git commit -m "feat: resolveUser — identity resolution for SSH and OAuth sources"
```

---

### Task 9: Build Verification and Full Test Run

**Files:** None — verification only.

- [ ] **Step 1: Build the project**

Run: `cd /srv/claude-proxy && npm run build`
Expected: Compiles without errors

- [ ] **Step 2: Run all tests**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS (existing 64 + new ~33 = ~97)

- [ ] **Step 3: Verify the auth module exports work**

Run: `cd /srv/claude-proxy && node -e "import('./dist/auth/types.js').then(m => console.log(Object.keys(m))); import('./dist/auth/user-store.js').then(m => console.log('UserStore:', typeof m.SQLiteUserStore)); import('./dist/auth/provisioner.js').then(m => console.log('Provisioner:', typeof m.LinuxProvisioner)); import('./dist/auth/resolve-user.js').then(m => console.log('resolveUser:', typeof m.resolveUser));"`
Expected: Prints type names showing all exports work

- [ ] **Step 4: Commit if any fixes were needed**
