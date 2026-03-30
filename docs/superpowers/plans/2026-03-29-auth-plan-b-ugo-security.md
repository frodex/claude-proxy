# UGO Security Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace application-level session access control with Unix socket permissions, tmux server-access ACLs, and inotify-based enforcement.

**Architecture:** Each tmux session gets its own socket file (`-S`). Socket ownership and group permissions control who can attach. tmux `server-access` manages per-user read/write access. `fs.watch('/etc/group')` triggers re-evaluation of active connections when group membership changes externally.

**Tech Stack:** TypeScript, tmux 3.5a (server-access), Linux UGO, fs.watch (inotify)

**Spec:** `docs/superpowers/specs/2026-03-29-auth-ugo-security-design.md` (Phase 3)

**Depends on:** Plan A (shared contract) must be complete.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/ugo/socket-manager.ts` | Create/destroy tmux sockets, set permissions, manage server-access ACLs |
| `src/ugo/group-watcher.ts` | inotify on /etc/group, re-evaluate active sessions |
| `tests/ugo/socket-manager.test.ts` | Socket creation, permissions, server-access tests |
| `tests/ugo/group-watcher.test.ts` | Group change detection tests |
| Modify: `src/pty-multiplexer.ts` | Switch from default tmux server to `-S` socket |
| Modify: `src/session-manager.ts` | Use SocketManager for session lifecycle, group-based visibility |
| Modify: `src/session-store.ts` | Add socketPath to StoredSession |

---

### Task 1: SocketManager — Tests First

**Files:**
- Create: `tests/ugo/socket-manager.test.ts`

- [ ] **Step 1: Write SocketManager tests with mocked execSync**

```typescript
// tests/ugo/socket-manager.test.ts
import { test, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { SocketManager } from '../src/ugo/socket-manager.js';
import type { Provisioner } from '../src/auth/types.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    chownSync: vi.fn(),
    chmodSync: vi.fn(),
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ uid: 1000, gid: 1000 })),
  };
});

const mockExec = vi.mocked(execSync);

let mockProvisioner: Provisioner;
let manager: SocketManager;

beforeEach(() => {
  vi.clearAllMocks();
  mockProvisioner = {
    createSystemAccount: vi.fn(),
    deleteSystemAccount: vi.fn(),
    installClaude: vi.fn(),
    addToGroup: vi.fn(),
    removeFromGroup: vi.fn(),
    createGroup: vi.fn(),
    deleteGroup: vi.fn(),
    getGroups: vi.fn(() => []),
    getGroupMembers: vi.fn(() => []),
    userExists: vi.fn(() => true),
    groupExists: vi.fn(() => true),
  };
  manager = new SocketManager('/tmp/test-sockets', mockProvisioner);
});

test('getSocketPath returns correct path', () => {
  expect(manager.getSocketPath('myproject')).toBe('/tmp/test-sockets/cp-myproject.sock');
});

test('createSessionSocket calls tmux with -S flag', () => {
  mockExec.mockReturnValue('' as any);
  manager.createSessionSocket('myproject', 'greg', { cols: 80, rows: 24 }, 'private');

  const calls = mockExec.mock.calls.map(c => c[0] as string);
  const tmuxCall = calls.find(c => c.includes('tmux') && c.includes('-S'));
  expect(tmuxCall).toBeTruthy();
  expect(tmuxCall).toContain('/tmp/test-sockets/cp-myproject.sock');
  expect(tmuxCall).toContain('su - greg');
});

test('createSessionSocket creates session group for shared mode', () => {
  mockExec.mockReturnValue('' as any);
  manager.createSessionSocket('teamwork', 'greg', { cols: 80, rows: 24 }, 'shared');

  expect(mockProvisioner.createGroup).toHaveBeenCalledWith('sess-teamwork');
  expect(mockProvisioner.addToGroup).toHaveBeenCalledWith('greg', 'sess-teamwork');
});

test('createSessionSocket does not create group for private mode', () => {
  mockExec.mockReturnValue('' as any);
  manager.createSessionSocket('private', 'greg', { cols: 80, rows: 24 }, 'private');

  expect(mockProvisioner.createGroup).not.toHaveBeenCalled();
});

test('grantAccess calls server-access -a with write', () => {
  mockExec.mockReturnValue('' as any);
  manager.grantAccess('myproject', 'greg', 'frodex', 'write');

  const calls = mockExec.mock.calls.map(c => c[0] as string);
  const accessCall = calls.find(c => c.includes('server-access'));
  expect(accessCall).toContain('-a frodex');
  expect(accessCall).toContain('-w');
});

test('grantAccess calls server-access -a with read-only', () => {
  mockExec.mockReturnValue('' as any);
  manager.grantAccess('myproject', 'greg', 'viewer', 'read');

  const calls = mockExec.mock.calls.map(c => c[0] as string);
  const accessCall = calls.find(c => c.includes('server-access'));
  expect(accessCall).toContain('-a viewer');
  expect(accessCall).toContain('-r');
});

test('revokeAccess calls server-access -d and detaches client', () => {
  mockExec.mockReturnValue('' as any);
  manager.revokeAccess('myproject', 'greg', 'frodex');

  const calls = mockExec.mock.calls.map(c => c[0] as string);
  expect(calls.some(c => c.includes('server-access') && c.includes('-d frodex'))).toBe(true);
});

test('destroySessionSocket kills tmux and cleans up', () => {
  mockExec.mockReturnValue('' as any);
  manager.destroySessionSocket('myproject', 'greg');

  const calls = mockExec.mock.calls.map(c => c[0] as string);
  expect(calls.some(c => c.includes('kill-server') || c.includes('kill-session'))).toBe(true);
});

test('discoverSockets scans directory for alive sessions', () => {
  const { readdirSync } = require('fs');
  (readdirSync as any).mockReturnValue(['cp-proj1.sock', 'cp-proj2.sock', 'other.txt']);
  mockExec
    .mockReturnValueOnce('cp-proj1: 1 windows\n' as any)  // proj1 alive
    .mockImplementationOnce(() => { throw new Error('no server'); });  // proj2 dead

  const alive = manager.discoverSockets();
  expect(alive).toEqual(['/tmp/test-sockets/cp-proj1.sock']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/ugo/socket-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Commit test file**

```bash
cd /srv/claude-proxy && git add tests/ugo/socket-manager.test.ts && git commit -m "test: SocketManager contract tests (red — implementation pending)"
```

---

### Task 2: SocketManager — Implementation

**Files:**
- Create: `src/ugo/socket-manager.ts`

- [ ] **Step 1: Implement SocketManager**

```typescript
// src/ugo/socket-manager.ts
import { execSync } from 'child_process';
import { mkdirSync, chownSync, chmodSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Provisioner } from '../auth/types.js';

export type SessionMode = 'private' | 'shared' | 'team' | 'public';

export class SocketManager {
  private socketDir: string;
  private provisioner: Provisioner;

  constructor(socketDir: string, provisioner: Provisioner) {
    this.socketDir = socketDir;
    mkdirSync(this.socketDir, { recursive: true, mode: 0o755 });
  }

  getSocketPath(sessionName: string): string {
    const safe = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.socketDir, `cp-${safe}.sock`);
  }

  createSessionSocket(
    sessionName: string,
    owner: string,
    termSize: { cols: number; rows: number },
    mode: SessionMode,
    teamGroup?: string,
  ): string {
    const socketPath = this.getSocketPath(sessionName);
    const tmuxId = `cp-${sessionName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    // Create session group if shared
    if (mode === 'shared') {
      const groupName = `sess-${sessionName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      if (!this.provisioner.groupExists(groupName)) {
        this.provisioner.createGroup(groupName);
      }
      this.provisioner.addToGroup(owner, groupName);
    }

    // Launch tmux with custom socket as the owner
    const tmuxCmd = `tmux -S ${socketPath} new-session -d -s ${tmuxId} -x ${termSize.cols} -y ${termSize.rows}`;
    execSync(`su - ${owner} -c '${tmuxCmd}'`, { stdio: 'pipe' });

    // Set socket permissions based on mode
    this.setSocketPermissions(socketPath, owner, mode, sessionName, teamGroup);

    // Grant owner write access via server-access
    execSync(
      `su - ${owner} -c 'tmux -S ${socketPath} server-access -a ${owner} -w'`,
      { stdio: 'pipe' },
    );

    return socketPath;
  }

  private setSocketPermissions(
    socketPath: string,
    owner: string,
    mode: SessionMode,
    sessionName: string,
    teamGroup?: string,
  ): void {
    // Get owner UID
    const ownerUid = parseInt(
      execSync(`id -u ${owner}`, { encoding: 'utf-8' }).trim()
    );

    let groupGid: number;
    switch (mode) {
      case 'private':
        groupGid = parseInt(
          execSync(`id -g ${owner}`, { encoding: 'utf-8' }).trim()
        );
        chownSync(socketPath, ownerUid, groupGid);
        chmodSync(socketPath, 0o700);
        break;

      case 'shared': {
        const groupName = `cp-sess-${sessionName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        groupGid = parseInt(
          execSync(`getent group ${groupName} | cut -d: -f3`, { encoding: 'utf-8' }).trim()
        );
        chownSync(socketPath, ownerUid, groupGid);
        chmodSync(socketPath, 0o770);
        break;
      }

      case 'team': {
        const tg = teamGroup ? `cp-${teamGroup}` : `cp-users`;
        groupGid = parseInt(
          execSync(`getent group ${tg} | cut -d: -f3`, { encoding: 'utf-8' }).trim()
        );
        chownSync(socketPath, ownerUid, groupGid);
        chmodSync(socketPath, 0o770);
        break;
      }

      case 'public': {
        groupGid = parseInt(
          execSync(`getent group cp-users | cut -d: -f3`, { encoding: 'utf-8' }).trim()
        );
        chownSync(socketPath, ownerUid, groupGid);
        chmodSync(socketPath, 0o770);
        break;
      }
    }
  }

  grantAccess(
    sessionName: string,
    owner: string,
    targetUser: string,
    accessLevel: 'write' | 'read',
  ): void {
    const socketPath = this.getSocketPath(sessionName);
    const flag = accessLevel === 'write' ? '-w' : '-r';
    execSync(
      `su - ${owner} -c 'tmux -S ${socketPath} server-access -a ${targetUser} ${flag}'`,
      { stdio: 'pipe' },
    );
  }

  revokeAccess(sessionName: string, owner: string, targetUser: string): void {
    const socketPath = this.getSocketPath(sessionName);
    // Revoke server-access
    try {
      execSync(
        `su - ${owner} -c 'tmux -S ${socketPath} server-access -d ${targetUser}'`,
        { stdio: 'pipe' },
      );
    } catch {}
    // Detach any active client for this user
    try {
      execSync(
        `su - ${owner} -c 'tmux -S ${socketPath} detach-client -s ${targetUser}'`,
        { stdio: 'pipe' },
      );
    } catch {}
  }

  destroySessionSocket(sessionName: string, owner: string): void {
    const socketPath = this.getSocketPath(sessionName);
    try {
      execSync(
        `su - ${owner} -c 'tmux -S ${socketPath} kill-server'`,
        { stdio: 'pipe' },
      );
    } catch {}
    try { unlinkSync(socketPath); } catch {}

    // Clean up session group if it exists
    const groupName = `sess-${sessionName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    if (this.provisioner.groupExists(groupName)) {
      try { this.provisioner.deleteGroup(groupName); } catch {}
    }
  }

  discoverSockets(): string[] {
    if (!existsSync(this.socketDir)) return [];
    const files = readdirSync(this.socketDir).filter(f => f.endsWith('.sock'));
    const alive: string[] = [];

    for (const file of files) {
      const socketPath = join(this.socketDir, file);
      try {
        execSync(`tmux -S ${socketPath} list-sessions`, { stdio: 'pipe' });
        alive.push(socketPath);
      } catch {
        // Dead socket — clean up
        try { unlinkSync(socketPath); } catch {}
      }
    }

    return alive;
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/ugo/socket-manager.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 3: Run all tests**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/ugo/socket-manager.ts && git commit -m "feat: SocketManager — tmux socket creation, UGO permissions, server-access ACLs"
```

---

### Task 3: GroupWatcher — Tests and Implementation

**Files:**
- Create: `src/ugo/group-watcher.ts`
- Create: `tests/ugo/group-watcher.test.ts`

- [ ] **Step 1: Write GroupWatcher tests**

```typescript
// tests/ugo/group-watcher.test.ts
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroupWatcher } from '../src/ugo/group-watcher.js';
import type { Provisioner } from '../src/auth/types.js';

let mockProvisioner: Provisioner;

beforeEach(() => {
  mockProvisioner = {
    createSystemAccount: vi.fn(),
    deleteSystemAccount: vi.fn(),
    installClaude: vi.fn(),
    addToGroup: vi.fn(),
    removeFromGroup: vi.fn(),
    createGroup: vi.fn(),
    deleteGroup: vi.fn(),
    getGroups: vi.fn(() => []),
    getGroupMembers: vi.fn(() => []),
    userExists: vi.fn(() => true),
    groupExists: vi.fn(() => true),
  };
});

test('checkAccess returns true when user is in session group', () => {
  (mockProvisioner.getGroups as any).mockReturnValue(['users', 'sess-myproject']);
  const watcher = new GroupWatcher(mockProvisioner);
  expect(watcher.checkAccess('greg', 'sess-myproject')).toBe(true);
});

test('checkAccess returns false when user is not in session group', () => {
  (mockProvisioner.getGroups as any).mockReturnValue(['users']);
  const watcher = new GroupWatcher(mockProvisioner);
  expect(watcher.checkAccess('greg', 'sess-myproject')).toBe(false);
});

test('evaluateSessions calls onRevoke for users who lost access', () => {
  (mockProvisioner.getGroups as any)
    .mockReturnValueOnce(['users'])  // greg lost sess-myproject
    .mockReturnValueOnce(['users', 'sess-myproject']);  // frodex still has it

  const watcher = new GroupWatcher(mockProvisioner);
  const onRevoke = vi.fn();

  const sessions = [
    {
      sessionName: 'myproject',
      sessionGroup: 'sess-myproject',
      owner: 'admin',
      connectedUsers: ['greg', 'frodex'],
    },
  ];

  watcher.evaluateSessions(sessions, onRevoke);

  expect(onRevoke).toHaveBeenCalledTimes(1);
  expect(onRevoke).toHaveBeenCalledWith('myproject', 'greg');
});

test('evaluateSessions never revokes the owner', () => {
  (mockProvisioner.getGroups as any).mockReturnValue([]);  // owner not even in group

  const watcher = new GroupWatcher(mockProvisioner);
  const onRevoke = vi.fn();

  const sessions = [
    {
      sessionName: 'myproject',
      sessionGroup: 'sess-myproject',
      owner: 'greg',
      connectedUsers: ['greg'],
    },
  ];

  watcher.evaluateSessions(sessions, onRevoke);
  expect(onRevoke).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/ugo/group-watcher.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement GroupWatcher**

```typescript
// src/ugo/group-watcher.ts
import { watch, type FSWatcher } from 'fs';
import type { Provisioner } from '../auth/types.js';

export interface SessionInfo {
  sessionName: string;
  sessionGroup: string;
  owner: string;
  connectedUsers: string[];
}

export type RevokeCallback = (sessionName: string, username: string) => void;

export class GroupWatcher {
  private provisioner: Provisioner;
  private watcher: FSWatcher | null = null;

  constructor(provisioner: Provisioner) {
    this.provisioner = provisioner;
  }

  checkAccess(username: string, sessionGroup: string): boolean {
    const groups = this.provisioner.getGroups(username);
    return groups.includes(sessionGroup);
  }

  evaluateSessions(sessions: SessionInfo[], onRevoke: RevokeCallback): void {
    for (const session of sessions) {
      for (const user of session.connectedUsers) {
        // Never revoke the owner
        if (user === session.owner) continue;

        if (!this.checkAccess(user, session.sessionGroup)) {
          onRevoke(session.sessionName, user);
        }
      }
    }
  }

  startWatching(
    getSessions: () => SessionInfo[],
    onRevoke: RevokeCallback,
  ): void {
    this.watcher = watch('/etc/group', () => {
      console.log('[group-watcher] /etc/group changed — re-evaluating sessions');
      const sessions = getSessions();
      this.evaluateSessions(sessions, onRevoke);
    });
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/ugo/group-watcher.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Run all tests**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /srv/claude-proxy && git add src/ugo/group-watcher.ts tests/ugo/group-watcher.test.ts && git commit -m "feat: GroupWatcher — inotify on /etc/group with reactive session enforcement"
```

---

### Task 4: Add socketPath to Session Metadata

**Files:**
- Modify: `src/types.ts`
- Modify: `src/session-store.ts`

- [ ] **Step 1: Add socketPath to Session interface**

In `src/types.ts`, add `socketPath?: string` to Session:

```typescript
export interface Session {
  id: string;
  name: string;
  runAsUser: string;
  workingDir?: string;
  remoteHost?: string;
  socketPath?: string;
  createdAt: Date;
  sizeOwner: string;
  clients: Map<string, Client>;
  access: SessionAccess;
}
```

- [ ] **Step 2: Add socketPath to StoredSession**

In `src/session-store.ts`, add `socketPath?: string` to StoredSession:

```typescript
interface StoredSession {
  tmuxId: string;
  name: string;
  runAsUser: string;
  workingDir?: string;
  remoteHost?: string;
  socketPath?: string;
  createdAt: string;
  access: SessionAccess;
  claudeSessionId?: string;
}
```

- [ ] **Step 3: Build and run tests**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: Compiles, all tests PASS

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/types.ts src/session-store.ts && git commit -m "feat: add socketPath to Session and StoredSession types"
```

---

### Task 5: Integrate SocketManager into PtyMultiplexer

This is the core wiring task — changing how tmux sessions are created and attached to use `-S` custom sockets.

**Files:**
- Modify: `src/pty-multiplexer.ts`

- [ ] **Step 1: Add socketPath to PtyOptions and AttachOptions**

Add `socketPath?: string` to both interfaces. When present, tmux commands use `-S socketPath` instead of the default server.

- [ ] **Step 2: Update constructor to use -S when socketPath is provided**

In the local session launch block, when `socketPath` is set:
```typescript
const tmuxCmd = socketPath
  ? `tmux -S ${socketPath} new-session -d -s ${this.tmuxId} -x ${options.cols} -y ${options.rows} ${scriptPath}`
  : `tmux -f ${confPath} new-session -d -s ${this.tmuxId} -x ${options.cols} -y ${options.rows} ${scriptPath}`;
```

- [ ] **Step 3: Update attachToTmux to use -S when socketPath is provided**

Store socketPath as instance field. In `attachToTmux`:
```typescript
if (this.socketPath) {
  this.pty = spawn('tmux', ['-S', this.socketPath, 'attach-session', '-t', this.tmuxId], { ... });
} else {
  // existing code for default tmux server
}
```

- [ ] **Step 4: Update reattach static method to accept socketPath**

- [ ] **Step 5: Update isTmuxSessionAlive to use -S**

- [ ] **Step 6: Update destroy to use -S**

- [ ] **Step 7: Update listTmuxSessions to handle socket-based sessions**

- [ ] **Step 8: Build and run all tests**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: All tests PASS (existing tests use default server, still work)

- [ ] **Step 9: Commit**

```bash
cd /srv/claude-proxy && git add src/pty-multiplexer.ts && git commit -m "feat: PtyMultiplexer supports -S socket path for UGO-controlled sessions"
```

---

### Task 6: Integrate into SessionManager

**Files:**
- Modify: `src/session-manager.ts`

- [ ] **Step 1: Add SocketManager and GroupWatcher to SessionManager constructor**

Accept optional `SocketManager` and `GroupWatcher` in options. When present, use socket-based session creation.

- [ ] **Step 2: Update createSession to use SocketManager**

When SocketManager is available:
1. Determine session mode (private/shared/team/public) from access settings
2. Call `socketManager.createSessionSocket()`
3. Pass socketPath to PtyMultiplexer
4. Save socketPath in session metadata

- [ ] **Step 3: Update discoverSessions to scan socket directory**

When SocketManager is available, use `socketManager.discoverSockets()` in addition to `PtyMultiplexer.listTmuxSessions()` for backward compatibility.

- [ ] **Step 4: Update listSessionsForUser to use group-based visibility**

Use `provisioner.getGroups(username)` to filter sessions by socket group access, instead of the current `canUserAccessSession()` logic.

- [ ] **Step 5: Start GroupWatcher on init**

Call `groupWatcher.startWatching()` with a callback that detaches revoked users.

- [ ] **Step 6: Build and run all tests**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /srv/claude-proxy && git add src/session-manager.ts && git commit -m "feat: SessionManager uses SocketManager for UGO-enforced sessions"
```

---

### Task 7: Wire Up in index.ts and Verify End-to-End

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Create SocketManager and GroupWatcher at startup**

```typescript
import { LinuxProvisioner } from './auth/provisioner.js';
import { SocketManager } from './ugo/socket-manager.js';
import { GroupWatcher } from './ugo/group-watcher.js';

const provisioner = new LinuxProvisioner();
const socketManager = new SocketManager('/var/run/claude-proxy/sessions', provisioner);
const groupWatcher = new GroupWatcher(provisioner);
```

Pass them to SessionManager.

- [ ] **Step 2: Ensure socket directory is created on startup**

```bash
mkdir -p /var/run/claude-proxy/sessions
```

Add to systemd service if needed.

- [ ] **Step 3: Build, restart service, test session creation**

Run: `cd /srv/claude-proxy && npm run build`
Run: `systemctl restart claude-proxy`
Verify: Create a session, check that socket file exists with correct permissions.

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/index.ts && git commit -m "feat: wire SocketManager and GroupWatcher into proxy startup"
```
