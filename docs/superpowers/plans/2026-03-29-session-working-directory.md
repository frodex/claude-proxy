# Session Working Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to specify a working directory when creating sessions, with a picker showing git repos + history and freehand path entry.

**Architecture:** New `DirScanner` module scans for git repos and tracks directory history. A new `'workdir'` step in the lobby creation flow presents an interactive picker. The chosen directory is threaded through `SessionManager` → `PtyMultiplexer` as a `cd` prefix on the tmux launch command. A new `GET /api/directories` endpoint exposes the same data for browser clients.

**Tech Stack:** TypeScript, Node.js fs/child_process, vitest for tests

---

### Task 1: DirScanner — History Management

**Files:**
- Create: `src/dir-scanner.ts`
- Create: `tests/dir-scanner.test.ts`

- [ ] **Step 1: Write failing tests for history management**

```typescript
// tests/dir-scanner.test.ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { DirScanner } from '../src/dir-scanner.js';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const TEST_DATA_DIR = '/tmp/dir-scanner-test-data';
const TEST_HISTORY = join(TEST_DATA_DIR, 'dir-history.json');

beforeEach(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test('addToHistory writes path to history file', () => {
  const scanner = new DirScanner({ historyPath: TEST_HISTORY });
  scanner.addToHistory('/srv/project-a');
  const history = scanner.getHistory();
  expect(history).toEqual(['/srv/project-a']);
});

test('addToHistory puts most recent first', () => {
  const scanner = new DirScanner({ historyPath: TEST_HISTORY });
  scanner.addToHistory('/srv/project-a');
  scanner.addToHistory('/srv/project-b');
  const history = scanner.getHistory();
  expect(history).toEqual(['/srv/project-b', '/srv/project-a']);
});

test('addToHistory deduplicates — moves existing to front', () => {
  const scanner = new DirScanner({ historyPath: TEST_HISTORY });
  scanner.addToHistory('/srv/project-a');
  scanner.addToHistory('/srv/project-b');
  scanner.addToHistory('/srv/project-a');
  const history = scanner.getHistory();
  expect(history).toEqual(['/srv/project-a', '/srv/project-b']);
});

test('addToHistory caps at 50 entries', () => {
  const scanner = new DirScanner({ historyPath: TEST_HISTORY });
  for (let i = 0; i < 60; i++) {
    scanner.addToHistory(`/srv/project-${i}`);
  }
  const history = scanner.getHistory();
  expect(history.length).toBe(50);
  expect(history[0]).toBe('/srv/project-59');
});

test('getHistory returns empty array when no history file', () => {
  const scanner = new DirScanner({ historyPath: TEST_HISTORY });
  expect(scanner.getHistory()).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/dir-scanner.test.ts`
Expected: FAIL — module `../src/dir-scanner.js` not found

- [ ] **Step 3: Implement DirScanner history management**

```typescript
// src/dir-scanner.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const MAX_HISTORY = 50;

interface DirScannerOptions {
  historyPath: string;
  scanRoots?: string[];
  maxDepth?: number;
}

export class DirScanner {
  private historyPath: string;
  private scanRoots: string[];
  private maxDepth: number;
  private cachedScan: string[] | null = null;

  constructor(options: DirScannerOptions) {
    this.historyPath = options.historyPath;
    this.scanRoots = options.scanRoots ?? ['/srv', '/home', '/root'];
    this.maxDepth = options.maxDepth ?? 3;
  }

  getHistory(): string[] {
    if (!existsSync(this.historyPath)) return [];
    try {
      return JSON.parse(readFileSync(this.historyPath, 'utf-8'));
    } catch {
      return [];
    }
  }

  addToHistory(dir: string): void {
    const history = this.getHistory().filter(d => d !== dir);
    history.unshift(dir);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    mkdirSync(dirname(this.historyPath), { recursive: true });
    writeFileSync(this.historyPath, JSON.stringify(history, null, 2));
  }

  scan(): string[] {
    if (this.cachedScan) return this.cachedScan;
    this.cachedScan = this.performScan();
    return this.cachedScan;
  }

  rescan(): string[] {
    this.cachedScan = null;
    return this.scan();
  }

  getDirectories(): string[] {
    const history = this.getHistory();
    const scanned = this.scan();
    const historySet = new Set(history);
    const merged = [...history, ...scanned.filter(d => !historySet.has(d))];
    return merged;
  }

  private performScan(): string[] {
    // placeholder — implemented in Task 2
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/dir-scanner.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/dir-scanner.ts tests/dir-scanner.test.ts && git commit -m "feat: DirScanner with history management"
```

---

### Task 2: DirScanner — Git Repo Scanning

**Files:**
- Modify: `src/dir-scanner.ts` (the `performScan` method)
- Modify: `tests/dir-scanner.test.ts`

- [ ] **Step 1: Write failing tests for git repo scanning**

Add to `tests/dir-scanner.test.ts`:

```typescript
const TEST_SCAN_DIR = '/tmp/dir-scanner-test-scan';

test('scan finds git repos under scan roots', () => {
  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_SCAN_DIR, 'repo-a', '.git'), { recursive: true });
  mkdirSync(join(TEST_SCAN_DIR, 'repo-b', '.git'), { recursive: true });
  mkdirSync(join(TEST_SCAN_DIR, 'not-a-repo'), { recursive: true });

  const scanner = new DirScanner({
    historyPath: TEST_HISTORY,
    scanRoots: [TEST_SCAN_DIR],
  });
  const results = scanner.scan();
  expect(results).toContain(join(TEST_SCAN_DIR, 'repo-a'));
  expect(results).toContain(join(TEST_SCAN_DIR, 'repo-b'));
  expect(results).not.toContain(join(TEST_SCAN_DIR, 'not-a-repo'));

  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
});

test('scan respects maxDepth', () => {
  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_SCAN_DIR, 'a', 'b', 'c', 'deep-repo', '.git'), { recursive: true });
  mkdirSync(join(TEST_SCAN_DIR, 'shallow-repo', '.git'), { recursive: true });

  const scanner = new DirScanner({
    historyPath: TEST_HISTORY,
    scanRoots: [TEST_SCAN_DIR],
    maxDepth: 2,
  });
  const results = scanner.scan();
  expect(results).toContain(join(TEST_SCAN_DIR, 'shallow-repo'));
  expect(results).not.toContain(join(TEST_SCAN_DIR, 'a', 'b', 'c', 'deep-repo'));

  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
});

test('scan skips node_modules and hidden dirs', () => {
  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_SCAN_DIR, 'node_modules', 'pkg', '.git'), { recursive: true });
  mkdirSync(join(TEST_SCAN_DIR, '.hidden', 'secret-repo', '.git'), { recursive: true });
  mkdirSync(join(TEST_SCAN_DIR, 'real-repo', '.git'), { recursive: true });

  const scanner = new DirScanner({
    historyPath: TEST_HISTORY,
    scanRoots: [TEST_SCAN_DIR],
  });
  const results = scanner.scan();
  expect(results).toContain(join(TEST_SCAN_DIR, 'real-repo'));
  expect(results).not.toContain(join(TEST_SCAN_DIR, 'node_modules', 'pkg'));
  expect(results).not.toContain(join(TEST_SCAN_DIR, '.hidden', 'secret-repo'));

  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
});

test('scan caches results — rescan clears cache', () => {
  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_SCAN_DIR, 'repo-a', '.git'), { recursive: true });

  const scanner = new DirScanner({
    historyPath: TEST_HISTORY,
    scanRoots: [TEST_SCAN_DIR],
  });
  const first = scanner.scan();
  expect(first).toContain(join(TEST_SCAN_DIR, 'repo-a'));

  // Add new repo after cache
  mkdirSync(join(TEST_SCAN_DIR, 'repo-b', '.git'), { recursive: true });
  const cached = scanner.scan();
  expect(cached).not.toContain(join(TEST_SCAN_DIR, 'repo-b'));

  const refreshed = scanner.rescan();
  expect(refreshed).toContain(join(TEST_SCAN_DIR, 'repo-b'));

  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
});

test('getDirectories merges history and scan, history first', () => {
  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_SCAN_DIR, 'repo-a', '.git'), { recursive: true });
  mkdirSync(join(TEST_SCAN_DIR, 'repo-b', '.git'), { recursive: true });

  const scanner = new DirScanner({
    historyPath: TEST_HISTORY,
    scanRoots: [TEST_SCAN_DIR],
  });
  scanner.addToHistory(join(TEST_SCAN_DIR, 'repo-b'));

  const dirs = scanner.getDirectories();
  const idxB = dirs.indexOf(join(TEST_SCAN_DIR, 'repo-b'));
  const idxA = dirs.indexOf(join(TEST_SCAN_DIR, 'repo-a'));
  expect(idxB).toBeLessThan(idxA);
  // repo-b should not appear twice
  expect(dirs.filter(d => d === join(TEST_SCAN_DIR, 'repo-b')).length).toBe(1);

  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/dir-scanner.test.ts`
Expected: New scan tests FAIL (performScan returns empty array)

- [ ] **Step 3: Implement performScan**

Replace the `performScan` method in `src/dir-scanner.ts`:

```typescript
  private performScan(): string[] {
    const results: string[] = [];
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

    const walk = (dir: string, depth: number): void => {
      if (depth > this.maxDepth) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return; // permission denied or not a directory
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue;
        if (entry.startsWith('.')) continue;
        const full = join(dir, entry);
        try {
          if (!statSync(full).isDirectory()) continue;
        } catch {
          continue;
        }
        // Check if this directory is a git repo
        if (existsSync(join(full, '.git'))) {
          results.push(full);
          continue; // don't recurse into git repos
        }
        walk(full, depth + 1);
      }
    };

    for (const root of this.scanRoots) {
      if (existsSync(root)) {
        walk(root, 0);
      }
    }

    return results.sort();
  }
```

Add `readdirSync, statSync` to the existing fs import and `join` to the path import at the top of `src/dir-scanner.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/dir-scanner.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/dir-scanner.ts tests/dir-scanner.test.ts && git commit -m "feat: DirScanner git repo scanning with depth limit and skip rules"
```

---

### Task 3: Add workingDir to Types, Store, and PtyMultiplexer

**Files:**
- Modify: `src/types.ts:43-51` (Session interface)
- Modify: `src/session-store.ts:12-19` (StoredSession interface)
- Modify: `src/pty-multiplexer.ts:11-21` (PtyOptions interface)
- Modify: `src/pty-multiplexer.ts:56-115` (constructor — innerCommand building)
- Modify: `tests/pty-multiplexer.test.ts`

- [ ] **Step 1: Write failing test for workingDir in PtyMultiplexer**

Add to `tests/pty-multiplexer.test.ts`:

```typescript
test('launches tmux session with working directory', async () => {
  const tmuxId = uniqueTmuxId();
  const testDir = '/tmp';
  const mux = new PtyMultiplexer({
    command: 'pwd',
    args: [],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
    tmuxSessionId: tmuxId,
    workingDir: testDir,
  });

  const c1 = makeClient('c1');
  mux.attach(c1);

  await new Promise(r => setTimeout(r, 1500));

  const output = Buffer.concat(c1.written).toString();
  expect(output).toContain('/tmp');

  mux.destroy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /srv/claude-proxy && npx vitest run tests/pty-multiplexer.test.ts -t "working directory"`
Expected: FAIL — `workingDir` is not a known property on PtyOptions (TypeScript compile error or ignored)

- [ ] **Step 3: Add workingDir to types**

In `src/types.ts`, add `workingDir` to the Session interface after `runAsUser`:

```typescript
export interface Session {
  id: string;
  name: string;
  runAsUser: string;
  workingDir?: string;
  createdAt: Date;
  sizeOwner: string;
  clients: Map<string, Client>;
  access: SessionAccess;
}
```

In `src/session-store.ts`, add `workingDir` to StoredSession after `runAsUser`:

```typescript
interface StoredSession {
  tmuxId: string;
  name: string;
  runAsUser: string;
  workingDir?: string;
  createdAt: string;
  access: SessionAccess;
  claudeSessionId?: string;
}
```

- [ ] **Step 4: Add workingDir to PtyOptions and use it in constructor**

In `src/pty-multiplexer.ts`, add `workingDir` to PtyOptions:

```typescript
interface PtyOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  scrollbackBytes: number;
  tmuxSessionId: string;
  runAsUser?: string;
  remoteHost?: string;
  workingDir?: string;
  onExit?: (code: number) => void;
}
```

In the constructor, after building `innerCommand` but before the tmux launch block, prepend the `cd` if `workingDir` is set. Add this right before `if (this.remoteHost) {` (around line 88):

```typescript
    // Prepend cd to working directory if specified
    if (options.workingDir) {
      innerCommand = `cd ${options.workingDir} && ${innerCommand}`;
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /srv/claude-proxy && npx vitest run tests/pty-multiplexer.test.ts -t "working directory"`
Expected: PASS — output contains `/tmp`

- [ ] **Step 6: Run all existing tests to verify no regressions**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /srv/claude-proxy && git add src/types.ts src/session-store.ts src/pty-multiplexer.ts tests/pty-multiplexer.test.ts && git commit -m "feat: add workingDir to types, store, and PtyMultiplexer"
```

---

### Task 4: Thread workingDir Through SessionManager

**Files:**
- Modify: `src/session-manager.ts:106-182` (createSession method)
- Modify: `tests/session-manager.test.ts`

- [ ] **Step 1: Write failing test for workingDir in createSession**

Read `tests/session-manager.test.ts` first to understand the existing test patterns. Then add:

```typescript
test('createSession passes workingDir to pty', () => {
  // This test verifies the parameter is accepted and persisted in metadata
  const manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 5,
  });

  const client = makeClient('test-wd');
  const tmuxId = `cp-workdir-test-${Date.now()}`;

  try {
    const session = manager.createSession(
      `workdir-test-${Date.now()}`,
      client,
      'root',
      'echo',
      { owner: 'test-wd', public: true },
      ['hello'],
      undefined,    // no remoteHost
      '/tmp',       // workingDir
    );

    expect(session.workingDir).toBe('/tmp');
    manager.destroySession(session.id);
  } catch {
    // cleanup if session was partially created
    try { execSync(`tmux kill-session -t ${tmuxId} 2>/dev/null`); } catch {}
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /srv/claude-proxy && npx vitest run tests/session-manager.test.ts -t "workingDir"`
Expected: FAIL — createSession doesn't accept 8th parameter or session.workingDir is undefined

- [ ] **Step 3: Add workingDir parameter to createSession**

In `src/session-manager.ts`, update the `createSession` method signature (line 106):

```typescript
  createSession(
    name: string,
    creator: Client,
    runAsUser?: string,
    command: string = 'claude',
    access?: Partial<SessionAccess>,
    commandArgs: string[] = [],
    remoteHost?: string,
    workingDir?: string,
  ): Session {
```

Pass `workingDir` to PtyMultiplexer constructor (add after `remoteHost` in the options object around line 135):

```typescript
    const pty = new PtyMultiplexer({
      command,
      args: commandArgs,
      cols: creator.termSize.cols,
      rows: creator.termSize.rows,
      scrollbackBytes: this.options.scrollbackBytes,
      tmuxSessionId: tmuxId,
      runAsUser: user,
      remoteHost,
      workingDir,
      onExit: (code) => {
        // ... existing callback
      },
    });
```

Add `workingDir` to the ManagedSession object (around line 152):

```typescript
    const session: ManagedSession = {
      id: tmuxId,
      name,
      runAsUser: user,
      workingDir,
      createdAt: new Date(),
      // ... rest unchanged
    };
```

Add `workingDir` to saveSessionMeta call (around line 170):

```typescript
    saveSessionMeta(tmuxId, {
      tmuxId,
      name,
      runAsUser: user,
      workingDir,
      createdAt: session.createdAt.toISOString(),
      access: sessionAccess,
    });
```

Also update `discoverSessions` (around line 82) to restore `workingDir` from metadata:

```typescript
        const session: ManagedSession = {
          id,
          name: meta?.name ?? ts.name,
          runAsUser: meta?.runAsUser ?? this.options.defaultUser,
          workingDir: meta?.workingDir,
          createdAt: meta ? new Date(meta.createdAt) : ts.created,
          // ... rest unchanged
        };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /srv/claude-proxy && npx vitest run tests/session-manager.test.ts -t "workingDir"`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /srv/claude-proxy && git add src/session-manager.ts tests/session-manager.test.ts && git commit -m "feat: thread workingDir through SessionManager.createSession"
```

---

### Task 5: Lobby Creation Flow — workdir Step

**Files:**
- Modify: `src/index.ts:51-69` (creationFlow type)
- Modify: `src/index.ts:150-170` (startNewSessionFlow)
- Modify: `src/index.ts:206-244` (finalizeSession)
- Modify: `src/index.ts:514-534` (name step transition)
- Modify: `src/index.ts:358-381` (launchDeepScan)
- Modify: `src/index.ts:326-339` (restart flow — pass workingDir)

This is the largest task — adding the interactive directory picker step to the creation flow. No unit test for this step as it's TUI interaction code tested manually via SSH.

- [ ] **Step 1: Initialize DirScanner at startup**

At the top of `src/index.ts`, after the existing imports, add:

```typescript
import { DirScanner } from './dir-scanner.js';
```

After the `lobby` initialization (around line 39), add:

```typescript
const dirScanner = new DirScanner({
  historyPath: resolve(__dirname, '..', 'data', 'dir-history.json'),
});
// Pre-warm the scan cache
dirScanner.scan();
```

- [ ] **Step 2: Update the creationFlow type**

Update the creationFlow Map type (line 51) to add workdir fields:

```typescript
const creationFlow: Map<string, {
  step: 'name' | 'workdir' | 'runas' | 'server' | 'hidden' | 'viewonly' | 'public' | 'users' | 'groups' | 'password' | 'dangermode';
  isResume?: boolean;
  name: string;
  workingDir?: string;
  workdirCursor: number;
  workdirCustom: boolean;   // true = freehand mode
  workdirFilter: string;    // typed filter text
  runAsUser?: string;
  remoteHost?: string;
  serverCursor?: number;
  hidden: boolean;
  viewOnly: boolean;
  dangerousSkipPermissions: boolean;
  public: boolean;
  selectedUsers: Set<string>;
  selectedGroups: Set<string>;
  availableUsers: string[];
  availableGroups: Array<{ name: string; systemName: string }>;
  userCursor: number;
  groupCursor: number;
  buffer: string;
}> = new Map();
```

- [ ] **Step 3: Update startNewSessionFlow and launchDeepScan to initialize new fields**

In `startNewSessionFlow` (line 151), add the new fields to the initial object:

```typescript
function startNewSessionFlow(client: Client): void {
  creationFlow.set(client.id, {
    step: 'name',
    name: '',
    workdirCursor: 0,
    workdirCustom: false,
    workdirFilter: '',
    runAsUser: client.username,
    hidden: false,
    viewOnly: false,
    dangerousSkipPermissions: false,
    public: true,
    selectedUsers: new Set(),
    selectedGroups: new Set(),
    availableUsers: getClaudeUsers().filter(u => u !== client.username),
    availableGroups: getClaudeGroups(),
    userCursor: 0,
    groupCursor: 0,
    buffer: '',
  });
  client.write('\x1b[2J\x1b[H');
  client.write(`\x1b[1mNew session\x1b[0m (as ${client.username})\r\n\r\n`);
  client.write('Session name: ');
}
```

Same for `launchDeepScan` (line 361) — add the three new fields there too.

- [ ] **Step 4: Change name step to transition to workdir**

In `handleCreationInput`, in the `flow.step === 'name'` block (line 519-534), change the Enter handler to go to `'workdir'` instead of `'runas'` or `'hidden'`:

```typescript
    if (str === '\r' || str === '\n') {
      if (flow.buffer.trim() === '') { client.write('\r\nName cannot be empty. Session name: '); return; }
      flow.name = flow.buffer.trim();
      flow.buffer = '';
      flow.step = 'workdir';
      flow.workdirCursor = 0;
      flow.workdirCustom = false;
      flow.workdirFilter = '';
      renderWorkdirPicker(client, flow);
      return;
    }
```

- [ ] **Step 5: Add renderWorkdirPicker function**

Add this function near the other render functions (after `renderGroupPicker`, around line 204):

```typescript
function getFilteredWorkdirs(flow: { workdirFilter: string }): Array<{ path: string; label: string; section: 'home' | 'recent' | 'projects' | 'custom' }> {
  const items: Array<{ path: string; label: string; section: 'home' | 'recent' | 'projects' | 'custom' }> = [];

  // Always first: home directory
  items.push({ path: '~', label: '~ (home directory)', section: 'home' });

  const history = dirScanner.getHistory();
  const scanned = dirScanner.scan();
  const historySet = new Set(history);

  for (const dir of history) {
    items.push({ path: dir, label: dir, section: 'recent' });
  }
  for (const dir of scanned) {
    if (!historySet.has(dir)) {
      items.push({ path: dir, label: dir, section: 'projects' });
    }
  }

  // Always last: custom path option
  items.push({ path: '', label: 'Custom path...', section: 'custom' });

  // Apply filter
  if (flow.workdirFilter) {
    const f = flow.workdirFilter.toLowerCase();
    return items.filter(item =>
      item.section === 'home' || item.section === 'custom' || item.path.toLowerCase().includes(f)
    );
  }

  return items;
}

function renderWorkdirPicker(client: Client, flow: ReturnType<typeof creationFlow.get>): void {
  if (!flow) return;

  if (flow.workdirCustom) {
    client.write('\x1b[2J\x1b[H');
    client.write('\x1b[1mWorking directory:\x1b[0m (enter path, esc to go back)\r\n\r\n');
    client.write(`  Path: ${flow.buffer}`);
    return;
  }

  const items = getFilteredWorkdirs(flow);

  client.write('\x1b[2J\x1b[H');
  client.write('\x1b[1mWorking directory:\x1b[0m (arrows, enter, type to filter, esc=cancel)\r\n\r\n');

  let lastSection = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // Section headers
    if (item.section !== lastSection && item.section !== 'home' && item.section !== 'custom') {
      if (item.section === 'recent') client.write('  \x1b[38;5;245mRecent:\x1b[0m\r\n');
      if (item.section === 'projects') client.write('  \x1b[38;5;245mProjects:\x1b[0m\r\n');
      lastSection = item.section;
    }
    const arrow = i === flow.workdirCursor ? '\x1b[33m>\x1b[0m' : ' ';
    if (item.section === 'custom') {
      client.write(`\r\n  ${arrow} \x1b[36m${item.label}\x1b[0m\r\n`);
    } else {
      client.write(`  ${arrow} ${item.label}\r\n`);
    }
  }

  if (flow.workdirFilter) {
    client.write(`\r\n  \x1b[38;5;245mFilter: ${flow.workdirFilter}\x1b[0m\r\n`);
  }
}
```

- [ ] **Step 6: Add workdir step handler in handleCreationInput**

Add the workdir step handler in `handleCreationInput`, right after the `name` step block (after line 534):

```typescript
  if (flow.step === 'workdir') {
    if (flow.workdirCustom) {
      // Freehand path entry mode
      if (str === '\x1b' && data.length === 1) {
        flow.workdirCustom = false;
        flow.buffer = '';
        renderWorkdirPicker(client, flow);
        return;
      }
      if (str === '\x7f' || str === '\b') {
        if (flow.buffer.length > 0) { flow.buffer = flow.buffer.slice(0, -1); client.write('\b \b'); }
        return;
      }
      if (str === '\r' || str === '\n') {
        const dir = flow.buffer.trim();
        if (!dir) { client.write('\r\n  Path cannot be empty.\r\n  Path: '); return; }
        // Resolve ~ to home
        const resolved = dir.startsWith('~') ? dir.replace('~', process.env.HOME || '/root') : dir;
        if (!existsSync(resolved)) {
          client.write(`\r\n  \x1b[31mDirectory not found: ${resolved}\x1b[0m\r\n  Path: `);
          flow.buffer = '';
          return;
        }
        flow.workingDir = dir === '~' ? undefined : resolved;
        flow.buffer = '';
        // Advance to next step
        if (isAdmin(client.username)) {
          flow.step = 'runas';
          client.write(`\r\n\r\nRun as user [${client.username}]: `);
        } else {
          flow.step = 'hidden';
          client.write(`\r\n\r\nHidden session? (only you can see it) [\x1b[1mN\x1b[0m/y]: `);
        }
        return;
      }
      flow.buffer += str;
      client.write(str);
      return;
    }

    // Picker mode
    const items = getFilteredWorkdirs(flow);

    // Arrow up
    if (str === '\x1b[A' || str === '\x1bOA') {
      flow.workdirCursor = Math.max(0, flow.workdirCursor - 1);
      renderWorkdirPicker(client, flow);
      return;
    }
    // Arrow down
    if (str === '\x1b[B' || str === '\x1bOB') {
      flow.workdirCursor = Math.min(items.length - 1, flow.workdirCursor + 1);
      renderWorkdirPicker(client, flow);
      return;
    }
    // Enter or space = select
    if (str === '\r' || str === '\n' || str === ' ') {
      const selected = items[flow.workdirCursor];
      if (!selected) return;

      if (selected.section === 'custom') {
        flow.workdirCustom = true;
        flow.buffer = '';
        renderWorkdirPicker(client, flow);
        return;
      }

      flow.workingDir = selected.path === '~' ? undefined : selected.path;
      flow.workdirFilter = '';

      // Advance to next step
      if (isAdmin(client.username)) {
        flow.step = 'runas';
        client.write(`\r\n\r\nRun as user [${client.username}]: `);
      } else {
        flow.step = 'hidden';
        client.write(`\r\n\r\nHidden session? (only you can see it) [\x1b[1mN\x1b[0m/y]: `);
      }
      return;
    }
    // Backspace in filter
    if (str === '\x7f' || str === '\b') {
      if (flow.workdirFilter.length > 0) {
        flow.workdirFilter = flow.workdirFilter.slice(0, -1);
        flow.workdirCursor = 0;
        renderWorkdirPicker(client, flow);
      }
      return;
    }
    // Tab or / switches to custom mode
    if (str === '\t' || str === '/') {
      flow.workdirCustom = true;
      flow.buffer = str === '/' ? '/' : '';
      renderWorkdirPicker(client, flow);
      return;
    }
    // Printable character = filter
    if (str.length === 1 && str >= ' ') {
      flow.workdirFilter += str;
      flow.workdirCursor = 0;
      renderWorkdirPicker(client, flow);
      return;
    }
    return;
  }
```

Add the `existsSync` import at the top of `src/index.ts` (if not already present):

```typescript
import { existsSync } from 'fs';
```

- [ ] **Step 7: Update finalizeSession to pass workingDir**

In `finalizeSession` (line 228), update the createSession call:

```typescript
    const session = sessionManager.createSession(flow.name, client, runAs, 'claude', access, commandArgs, remote, flow.workingDir);
```

Also add history tracking right after the createSession call:

```typescript
    if (flow.workingDir) {
      dirScanner.addToHistory(flow.workingDir);
    }
```

- [ ] **Step 8: Update restart flow to pass stored workingDir**

In `handleRestartInput`, in the restart block (around line 332), update the createSession call:

```typescript
      const session = sessionManager.createSession(
        dead.name,
        client,
        dead.runAsUser || client.username,
        'claude',
        dead.access,
        resumeArgs,
        undefined,        // remoteHost
        dead.workingDir,  // preserved from original session
      );
```

- [ ] **Step 9: Build and verify compilation**

Run: `cd /srv/claude-proxy && npm run build`
Expected: Compiles without errors

- [ ] **Step 10: Run all tests**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 11: Commit**

```bash
cd /srv/claude-proxy && git add src/index.ts src/dir-scanner.ts && git commit -m "feat: workdir picker step in session creation flow"
```

---

### Task 6: Web API — Directories Endpoint and Session workingDir

**Files:**
- Modify: `src/api-server.ts:82-167` (HTTP routes)
- Modify: `src/api-server.ts:100-118` (session list response)

- [ ] **Step 1: Add DirScanner import and parameter to startApiServer**

In `src/api-server.ts`, add import:

```typescript
import { DirScanner } from './dir-scanner.js';
```

Update `ApiServerOptions` interface:

```typescript
interface ApiServerOptions {
  port: number;
  host: string;
  sessionManager: SessionManager;
  config: Config;
  staticDir: string;
  dirScanner: DirScanner;
}
```

Update the destructuring at the start of `startApiServer`:

```typescript
  const { port, host, sessionManager, staticDir, dirScanner } = options;
```

- [ ] **Step 2: Add workingDir to session list response**

In the `/api/sessions` handler (around line 102), add `workingDir` to the response object:

```typescript
      return {
        id: s.id,
        name: s.name,
        title: composeTitle(s),
        cols: dims.cols,
        rows: dims.rows,
        clients: s.clients.size,
        owner: s.access?.owner,
        workingDir: (s as any).workingDir || null,
        createdAt: s.createdAt.toISOString(),
      };
```

- [ ] **Step 3: Add GET /api/directories endpoint**

Add this route handler after the `/api/sessions` handler and before the screen state handler (around line 119):

```typescript
    // API: directory list for browser picker
    if (url.pathname === '/api/directories' && req.method === 'GET') {
      const history = dirScanner.getHistory();
      const scanned = dirScanner.scan();
      const historySet = new Set(history);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        history,
        projects: scanned.filter(d => !historySet.has(d)),
      }));
      return;
    }
```

- [ ] **Step 4: Update the startApiServer call in index.ts**

In `src/index.ts`, find where `startApiServer` is called and add `dirScanner`:

```typescript
startApiServer({
  port: (config.port || 3100) + 1,
  host: config.host || '0.0.0.0',
  sessionManager,
  config,
  staticDir: resolve(__dirname, '..', 'web'),
  dirScanner,
});
```

- [ ] **Step 5: Build and verify**

Run: `cd /srv/claude-proxy && npm run build`
Expected: Compiles without errors

- [ ] **Step 6: Run all tests**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /srv/claude-proxy && git add src/api-server.ts src/index.ts && git commit -m "feat: /api/directories endpoint and workingDir in session list"
```

---

### Task 7: Manual Integration Test

**Files:** None — this is a verification task.

- [ ] **Step 1: Build the project**

Run: `cd /srv/claude-proxy && npm run build`

- [ ] **Step 2: Verify the directory scanner finds repos**

Run: `cd /srv/claude-proxy && node -e "import('./dist/dir-scanner.js').then(m => { const s = new m.DirScanner({ historyPath: '/tmp/test-hist.json' }); console.log('Scanned:', s.scan()); })"`
Expected: Lists git repos found under /srv, /home, /root

- [ ] **Step 3: Verify the API directories endpoint**

If the service is running, test:
Run: `curl -s http://localhost:3101/api/directories | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)))"`
Expected: JSON with `history` and `projects` arrays

- [ ] **Step 4: Commit any fixes if needed**

Only if issues were found in steps above.
