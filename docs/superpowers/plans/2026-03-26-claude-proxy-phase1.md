# claude-proxy Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js SSH server that multiplexes Claude Code PTY sessions with a lobby UI, live presence status bar, and size-owner terminal management.

**Architecture:** SSH server (ssh2) accepts key-authenticated connections, shows a lobby TUI, and attaches clients to shared PTY processes running `claude`. A transport abstraction keeps SSH decoupled from session logic for Phase 3 WebSocket support. Each client gets a composited view: PTY output in a scroll region + a 2-row status bar rendered independently.

**Tech Stack:** Node.js 22, TypeScript, ssh2, node-pty, yaml, vitest

---

## File Structure

```
claude-proxy/
├── package.json
├── tsconfig.json
├── claude-proxy.yaml
├── src/
│   ├── index.ts                   # entry point — loads config, wires components, starts server
│   ├── types.ts                   # shared types: Client, Session, Config, Transport
│   ├── config.ts                  # YAML + env + CLI flag config loader
│   ├── transport.ts               # Transport interface
│   ├── ssh-transport.ts           # ssh2 SSH server implementing Transport
│   ├── hotkey.ts                  # Ctrl+B prefix detection and command dispatch
│   ├── pty-multiplexer.ts         # PTY spawn, scrollback buffer, fan-out, input merge
│   ├── status-bar.ts              # Per-client ANSI status bar rendering, presence tracking
│   ├── session-manager.ts         # Session CRUD, client attach/detach, lifecycle
│   ├── lobby.ts                   # Lobby TUI rendering and input handling
│   └── ansi.ts                    # ANSI escape code helpers (cursor, color, scroll region)
├── tests/
│   ├── config.test.ts
│   ├── hotkey.test.ts
│   ├── pty-multiplexer.test.ts
│   ├── status-bar.test.ts
│   ├── session-manager.test.ts
│   ├── lobby.test.ts
│   └── ansi.test.ts
├── scripts/
│   └── generate-host-keys.sh      # generates SSH host keys
├── host-keys/                      # generated SSH host keys (gitignored)
└── systemd/
    └── claude-proxy.service
```

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `claude-proxy.yaml`

- [ ] **Step 1: Initialize package.json**

```bash
cd /srv/claude-proxy
npm init -y
```

Then edit `package.json`:

```json
{
  "name": "claude-proxy",
  "version": "0.1.0",
  "description": "SSH server that multiplexes Claude Code terminal sessions",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd /srv/claude-proxy
npm install ssh2 node-pty yaml
npm install -D typescript tsx vitest @types/node @types/ssh2
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
host-keys/
*.log
```

- [ ] **Step 5: Create default config file**

`claude-proxy.yaml`:

```yaml
port: 3100
host: 0.0.0.0

auth:
  authorized_keys: ~/.ssh/authorized_keys

sessions:
  default_user: root
  scrollback_bytes: 1048576
  max_sessions: 10

lobby:
  motd: "Welcome to claude-proxy"
```

- [ ] **Step 6: Verify build works**

```bash
mkdir -p src && echo 'console.log("claude-proxy");' > src/index.ts
npx tsc
node dist/index.js
```

Expected: prints `claude-proxy`

- [ ] **Step 7: Verify tests work**

```bash
mkdir -p tests && echo 'import { test, expect } from "vitest"; test("setup", () => { expect(true).toBe(true); });' > tests/setup.test.ts
npx vitest run
```

Expected: 1 test passes

- [ ] **Step 8: Commit**

```bash
cd /srv/claude-proxy
git add package.json tsconfig.json .gitignore claude-proxy.yaml src/index.ts tests/setup.test.ts package-lock.json
git commit -m "feat: project scaffold with TypeScript, vitest, and dependencies"
```

---

### Task 2: Types & ANSI Helpers

**Files:**
- Create: `src/types.ts`
- Create: `src/ansi.ts`
- Create: `tests/ansi.test.ts`

- [ ] **Step 1: Write types.ts**

```typescript
// src/types.ts

export interface Config {
  port: number;
  host: string;
  auth: {
    authorized_keys: string;
  };
  sessions: {
    default_user: string;
    scrollback_bytes: number;
    max_sessions: number;
  };
  lobby: {
    motd: string;
  };
}

export interface Client {
  id: string;
  username: string;
  transport: 'ssh' | 'websocket';
  termSize: { cols: number; rows: number };
  write: (data: Buffer | string) => void;
  lastKeystroke: number;  // Date.now() timestamp
}

export interface Session {
  id: string;
  name: string;
  runAsUser: string;
  createdAt: Date;
  sizeOwner: string;          // client id
  clients: Map<string, Client>;
}

export interface Transport {
  onConnect(callback: (client: Client) => void): void;
  onData(client: Client, callback: (data: Buffer) => void): void;
  onResize(client: Client, callback: (size: { cols: number; rows: number }) => void): void;
  onDisconnect(client: Client, callback: () => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

- [ ] **Step 2: Write failing ANSI helper tests**

`tests/ansi.test.ts`:

```typescript
import { test, expect } from 'vitest';
import { moveTo, setScrollRegion, clearLine, color, saveCursor, restoreCursor, hideCursor, showCursor } from '../src/ansi.js';

test('moveTo generates correct escape sequence', () => {
  expect(moveTo(1, 1)).toBe('\x1b[1;1H');
  expect(moveTo(10, 5)).toBe('\x1b[10;5H');
});

test('setScrollRegion sets top and bottom rows', () => {
  expect(setScrollRegion(1, 40)).toBe('\x1b[1;40r');
});

test('clearLine clears the current line', () => {
  expect(clearLine()).toBe('\x1b[2K');
});

test('color wraps text in ANSI color codes', () => {
  expect(color('hello', 33)).toBe('\x1b[33mhello\x1b[0m');
  expect(color('bold', 1)).toBe('\x1b[1mbold\x1b[0m');
});

test('saveCursor and restoreCursor', () => {
  expect(saveCursor()).toBe('\x1b7');
  expect(restoreCursor()).toBe('\x1b8');
});

test('hideCursor and showCursor', () => {
  expect(hideCursor()).toBe('\x1b[?25l');
  expect(showCursor()).toBe('\x1b[?25h');
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd /srv/claude-proxy && npx vitest run tests/ansi.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 4: Implement ansi.ts**

```typescript
// src/ansi.ts

export function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function setScrollRegion(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`;
}

export function clearLine(): string {
  return '\x1b[2K';
}

export function color(text: string, code: number): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

export function saveCursor(): string {
  return '\x1b7';
}

export function restoreCursor(): string {
  return '\x1b8';
}

export function hideCursor(): string {
  return '\x1b[?25l';
}

export function showCursor(): string {
  return '\x1b[?25h';
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /srv/claude-proxy && npx vitest run tests/ansi.test.ts
```

Expected: all 6 tests PASS

- [ ] **Step 6: Commit**

```bash
cd /srv/claude-proxy
git add src/types.ts src/ansi.ts tests/ansi.test.ts
git commit -m "feat: shared types and ANSI escape code helpers"
```

---

### Task 3: Config Loader

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write failing config tests**

`tests/config.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmpDir = join(tmpdir(), 'claude-proxy-test-' + Date.now());
const tmpConfig = join(tmpDir, 'test-config.yaml');

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try { unlinkSync(tmpConfig); } catch {}
});

test('loads defaults when no config file exists', () => {
  const config = loadConfig({ configPath: '/nonexistent/path.yaml' });
  expect(config.port).toBe(3100);
  expect(config.host).toBe('0.0.0.0');
  expect(config.sessions.default_user).toBe('root');
  expect(config.sessions.scrollback_bytes).toBe(1048576);
  expect(config.sessions.max_sessions).toBe(10);
});

test('loads and merges config from YAML file', () => {
  writeFileSync(tmpConfig, 'port: 4000\nlobby:\n  motd: "Hello test"');
  const config = loadConfig({ configPath: tmpConfig });
  expect(config.port).toBe(4000);
  expect(config.lobby.motd).toBe('Hello test');
  expect(config.host).toBe('0.0.0.0');  // default preserved
});

test('CLI flags override config file', () => {
  writeFileSync(tmpConfig, 'port: 4000');
  const config = loadConfig({ configPath: tmpConfig, port: 5000 });
  expect(config.port).toBe(5000);
});

test('env var PORT overrides config file', () => {
  writeFileSync(tmpConfig, 'port: 4000');
  process.env.PORT = '6000';
  const config = loadConfig({ configPath: tmpConfig });
  expect(config.port).toBe(6000);
  delete process.env.PORT;
});

test('CLI flag overrides env var', () => {
  process.env.PORT = '6000';
  const config = loadConfig({ port: 7000 });
  expect(config.port).toBe(7000);
  delete process.env.PORT;
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /srv/claude-proxy && npx vitest run tests/config.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement config.ts**

```typescript
// src/config.ts

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';
import type { Config } from './types.js';

const DEFAULTS: Config = {
  port: 3100,
  host: '0.0.0.0',
  auth: {
    authorized_keys: '~/.ssh/authorized_keys',
  },
  sessions: {
    default_user: 'root',
    scrollback_bytes: 1048576,
    max_sessions: 10,
  },
  lobby: {
    motd: 'Welcome to claude-proxy',
  },
};

interface LoadOptions {
  configPath?: string;
  port?: number;
}

export function loadConfig(options: LoadOptions = {}): Config {
  const configPath = options.configPath ?? resolve('claude-proxy.yaml');

  // Start with defaults
  let config: Config = structuredClone(DEFAULTS);

  // Layer 1: YAML file
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    const fileConfig = parse(raw) ?? {};
    config = deepMerge(config, fileConfig) as Config;
  }

  // Layer 2: Environment variables
  if (process.env.PORT) {
    config.port = parseInt(process.env.PORT, 10);
  }

  // Layer 3: CLI flags (highest priority)
  if (options.port !== undefined) {
    config.port = options.port;
  }

  return config;
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] ?? {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /srv/claude-proxy && npx vitest run tests/config.test.ts
```

Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy
git add src/config.ts tests/config.test.ts
git commit -m "feat: config loader with YAML, env var, and CLI flag precedence"
```

---

### Task 4: Hotkey Handler

**Files:**
- Create: `src/hotkey.ts`
- Create: `tests/hotkey.test.ts`

The hotkey handler detects the `Ctrl+B` prefix and dispatches commands. It must be stateful per-client (tracking whether the prefix has been pressed). All other input passes through transparently.

- [ ] **Step 1: Write failing hotkey tests**

`tests/hotkey.test.ts`:

```typescript
import { test, expect } from 'vitest';
import { HotkeyHandler } from '../src/hotkey.js';

test('passes through normal input', () => {
  const results: Array<{ type: string; data?: Buffer }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: (data) => results.push({ type: 'passthrough', data }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
  });

  handler.feed(Buffer.from('hello'));
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('passthrough');
  expect(results[0].data!.toString()).toBe('hello');
});

test('Ctrl+B then d triggers detach', () => {
  const results: Array<{ type: string }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: (data) => results.push({ type: 'passthrough' }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
  });

  handler.feed(Buffer.from('\x02'));  // Ctrl+B
  expect(results).toHaveLength(0);    // buffered, waiting for next key

  handler.feed(Buffer.from('d'));     // detach command
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('detach');
});

test('Ctrl+B then s triggers claimSize', () => {
  const results: Array<{ type: string }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: (data) => results.push({ type: 'passthrough' }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
  });

  handler.feed(Buffer.from('\x02'));  // Ctrl+B
  handler.feed(Buffer.from('s'));     // claim size
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('claimSize');
});

test('Ctrl+B then unknown key passes both through', () => {
  const results: Array<{ type: string; data?: Buffer }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: (data) => results.push({ type: 'passthrough', data }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
  });

  handler.feed(Buffer.from('\x02'));  // Ctrl+B
  handler.feed(Buffer.from('x'));     // unknown
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('passthrough');
  expect(results[0].data!.toString()).toBe('\x02x');
});

test('Ctrl+B Ctrl+B passes single Ctrl+B through', () => {
  const results: Array<{ type: string; data?: Buffer }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: (data) => results.push({ type: 'passthrough', data }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
  });

  handler.feed(Buffer.from('\x02'));  // Ctrl+B
  handler.feed(Buffer.from('\x02'));  // Ctrl+B again — escape
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('passthrough');
  expect(results[0].data!.toString()).toBe('\x02');
});

test('Ctrl+B timeout passes Ctrl+B through', async () => {
  const results: Array<{ type: string; data?: Buffer }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: (data) => results.push({ type: 'passthrough', data }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
    timeoutMs: 50,
  });

  handler.feed(Buffer.from('\x02'));  // Ctrl+B
  expect(results).toHaveLength(0);

  await new Promise(r => setTimeout(r, 100));
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('passthrough');
  expect(results[0].data!.toString()).toBe('\x02');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /srv/claude-proxy && npx vitest run tests/hotkey.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement hotkey.ts**

```typescript
// src/hotkey.ts

const CTRL_B = 0x02;

interface HotkeyCallbacks {
  onPassthrough: (data: Buffer) => void;
  onDetach: () => void;
  onClaimSize: () => void;
  timeoutMs?: number;
}

export class HotkeyHandler {
  private prefixActive = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private callbacks: HotkeyCallbacks;
  private timeoutMs: number;

  constructor(callbacks: HotkeyCallbacks) {
    this.callbacks = callbacks;
    this.timeoutMs = callbacks.timeoutMs ?? 1000;
  }

  feed(data: Buffer): void {
    if (this.prefixActive) {
      this.clearTimeout();
      this.prefixActive = false;

      if (data.length === 1) {
        const byte = data[0];
        if (byte === 0x64) {  // 'd'
          this.callbacks.onDetach();
          return;
        }
        if (byte === 0x73) {  // 's'
          this.callbacks.onClaimSize();
          return;
        }
        if (byte === CTRL_B) {  // Ctrl+B again — pass single Ctrl+B
          this.callbacks.onPassthrough(Buffer.from([CTRL_B]));
          return;
        }
      }

      // Unknown command — pass prefix + data through
      this.callbacks.onPassthrough(Buffer.concat([Buffer.from([CTRL_B]), data]));
      return;
    }

    // Check if this data starts with Ctrl+B
    if (data.length === 1 && data[0] === CTRL_B) {
      this.prefixActive = true;
      this.timeout = setTimeout(() => {
        this.prefixActive = false;
        this.callbacks.onPassthrough(Buffer.from([CTRL_B]));
      }, this.timeoutMs);
      return;
    }

    this.callbacks.onPassthrough(data);
  }

  private clearTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  destroy(): void {
    this.clearTimeout();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /srv/claude-proxy && npx vitest run tests/hotkey.test.ts
```

Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy
git add src/hotkey.ts tests/hotkey.test.ts
git commit -m "feat: hotkey handler with Ctrl+B prefix, detach, and size claim"
```

---

### Task 5: PTY Multiplexer

**Files:**
- Create: `src/pty-multiplexer.ts`
- Create: `tests/pty-multiplexer.test.ts`

- [ ] **Step 1: Write failing PTY multiplexer tests**

`tests/pty-multiplexer.test.ts`:

```typescript
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { PtyMultiplexer } from '../src/pty-multiplexer.js';
import type { Client } from '../src/types.js';

function makeClient(id: string, cols = 120, rows = 40): Client & { written: Buffer[] } {
  const written: Buffer[] = [];
  return {
    id,
    username: id,
    transport: 'ssh' as const,
    termSize: { cols, rows },
    write: (data: Buffer | string) => written.push(Buffer.isBuffer(data) ? data : Buffer.from(data)),
    lastKeystroke: Date.now(),
    written,
  };
}

test('broadcasts output to all attached clients', async () => {
  const mux = new PtyMultiplexer({
    command: 'echo',
    args: ['hello'],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
  });

  const c1 = makeClient('c1');
  const c2 = makeClient('c2');
  mux.attach(c1);
  mux.attach(c2);

  // Wait for echo to produce output and exit
  await new Promise(r => setTimeout(r, 500));

  expect(c1.written.length).toBeGreaterThan(0);
  expect(c2.written.length).toBeGreaterThan(0);
  const c1out = Buffer.concat(c1.written).toString();
  const c2out = Buffer.concat(c2.written).toString();
  expect(c1out).toContain('hello');
  expect(c2out).toContain('hello');

  mux.destroy();
});

test('scrollback buffer replays to late joiners', async () => {
  const mux = new PtyMultiplexer({
    command: 'echo',
    args: ['scrollback-test'],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
  });

  // Wait for echo to produce output
  await new Promise(r => setTimeout(r, 500));

  // Late joiner
  const late = makeClient('late');
  mux.attach(late);

  const output = Buffer.concat(late.written).toString();
  expect(output).toContain('scrollback-test');

  mux.destroy();
});

test('detach stops sending output to client', async () => {
  const mux = new PtyMultiplexer({
    command: 'cat',  // stays open, echoes input
    args: [],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
  });

  const c1 = makeClient('c1');
  mux.attach(c1);

  await new Promise(r => setTimeout(r, 100));
  const countBefore = c1.written.length;

  mux.detach(c1);
  mux.write(Buffer.from('after-detach\n'));

  await new Promise(r => setTimeout(r, 200));
  expect(c1.written.length).toBe(countBefore);

  mux.destroy();
});

test('resize changes PTY dimensions', () => {
  const mux = new PtyMultiplexer({
    command: 'cat',
    args: [],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
  });

  // Should not throw
  mux.resize(120, 40);

  mux.destroy();
});

test('onExit fires when process exits', async () => {
  const exitPromise = new Promise<number>(resolve => {
    const mux = new PtyMultiplexer({
      command: 'true',  // exits immediately with 0
      args: [],
      cols: 80,
      rows: 24,
      scrollbackBytes: 4096,
      onExit: (code) => resolve(code),
    });
  });

  const code = await exitPromise;
  expect(code).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /srv/claude-proxy && npx vitest run tests/pty-multiplexer.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement pty-multiplexer.ts**

```typescript
// src/pty-multiplexer.ts

import { spawn, type IPty } from 'node-pty';
import type { Client } from './types.js';

interface PtyOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  scrollbackBytes: number;
  runAsUser?: string;
  onExit?: (code: number) => void;
}

export class PtyMultiplexer {
  private pty: IPty;
  private clients: Map<string, Client> = new Map();
  private scrollback: Buffer[] = [];
  private scrollbackSize = 0;
  private maxScrollback: number;

  constructor(options: PtyOptions) {
    this.maxScrollback = options.scrollbackBytes;

    let command = options.command;
    let args = options.args;

    if (options.runAsUser) {
      args = ['-', options.runAsUser, '-c', [command, ...args].join(' ')];
      command = 'su';
    }

    this.pty = spawn(command, args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      env: process.env as Record<string, string>,
    });

    this.pty.onData((data: string) => {
      const buf = Buffer.from(data);
      this.appendScrollback(buf);
      for (const client of this.clients.values()) {
        client.write(buf);
      }
    });

    this.pty.onExit(({ exitCode }) => {
      options.onExit?.(exitCode);
    });
  }

  attach(client: Client): void {
    // Replay scrollback to new joiner
    for (const chunk of this.scrollback) {
      client.write(chunk);
    }
    this.clients.set(client.id, client);
  }

  detach(client: Client): void {
    this.clients.delete(client.id);
  }

  write(data: Buffer): void {
    this.pty.write(data.toString());
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  destroy(): void {
    this.pty.kill();
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
  }

  private appendScrollback(data: Buffer): void {
    this.scrollback.push(data);
    this.scrollbackSize += data.length;

    while (this.scrollbackSize > this.maxScrollback && this.scrollback.length > 1) {
      const removed = this.scrollback.shift()!;
      this.scrollbackSize -= removed.length;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /srv/claude-proxy && npx vitest run tests/pty-multiplexer.test.ts
```

Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy
git add src/pty-multiplexer.ts tests/pty-multiplexer.test.ts
git commit -m "feat: PTY multiplexer with fan-out, scrollback, and run-as-user"
```

---

### Task 6: Status Bar Renderer

**Files:**
- Create: `src/status-bar.ts`
- Create: `tests/status-bar.test.ts`

- [ ] **Step 1: Write failing status bar tests**

`tests/status-bar.test.ts`:

```typescript
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { StatusBar } from '../src/status-bar.js';

test('renders session name and users', () => {
  const bar = new StatusBar();
  const output = bar.render({
    sessionName: 'bugfix-auth',
    users: [
      { username: 'greg', isSizeOwner: true, isTyping: false },
      { username: 'sam', isSizeOwner: false, isTyping: true },
      { username: 'alice', isSizeOwner: false, isTyping: false },
    ],
    cols: 60,
  });

  // Should contain session name
  expect(output).toContain('bugfix-auth');
  // Should contain all usernames
  expect(output).toContain('greg');
  expect(output).toContain('sam');
  expect(output).toContain('alice');
});

test('size owner is bracketed and bold', () => {
  const bar = new StatusBar();
  const output = bar.render({
    sessionName: 'test',
    users: [
      { username: 'greg', isSizeOwner: true, isTyping: false },
    ],
    cols: 60,
  });

  // Bold bracket: \x1b[1m[\x1b[0m or similar
  expect(output).toContain('[greg]');
});

test('typing users are orange (ANSI 33)', () => {
  const bar = new StatusBar();
  const output = bar.render({
    sessionName: 'test',
    users: [
      { username: 'sam', isSizeOwner: false, isTyping: true },
    ],
    cols: 60,
  });

  expect(output).toContain('\x1b[33m');  // orange/yellow
  expect(output).toContain('sam');
});

test('idle users are gray (ANSI 90)', () => {
  const bar = new StatusBar();
  const output = bar.render({
    sessionName: 'test',
    users: [
      { username: 'alice', isSizeOwner: false, isTyping: false },
    ],
    cols: 60,
  });

  expect(output).toContain('\x1b[90m');  // gray
  expect(output).toContain('alice');
});

test('typing indicator shows keyboard emoji for typers', () => {
  const bar = new StatusBar();
  const output = bar.render({
    sessionName: 'test',
    users: [
      { username: 'greg', isSizeOwner: true, isTyping: true },
      { username: 'sam', isSizeOwner: false, isTyping: true },
      { username: 'alice', isSizeOwner: false, isTyping: false },
    ],
    cols: 60,
  });

  // Line 2 should show typing indicator
  const lines = output.split('\n');
  expect(lines.length).toBeGreaterThanOrEqual(2);
});

test('renderFrame wraps PTY output with scroll region and status bar', () => {
  const bar = new StatusBar();
  const frame = bar.renderFrame({
    ptyData: 'hello world',
    sessionName: 'test',
    users: [{ username: 'greg', isSizeOwner: true, isTyping: false }],
    clientRows: 24,
    clientCols: 80,
  });

  // Should contain scroll region escape
  expect(frame).toContain('\x1b[1;22r');  // rows 1-22 (24 - 2 for status bar)
  // Should contain the PTY data
  expect(frame).toContain('hello world');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /srv/claude-proxy && npx vitest run tests/status-bar.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement status-bar.ts**

```typescript
// src/status-bar.ts

import { moveTo, clearLine, color, saveCursor, restoreCursor, setScrollRegion, hideCursor, showCursor } from './ansi.js';

interface UserPresence {
  username: string;
  isSizeOwner: boolean;
  isTyping: boolean;
}

interface RenderOptions {
  sessionName: string;
  users: UserPresence[];
  cols: number;
}

interface FrameOptions {
  ptyData: string;
  sessionName: string;
  users: UserPresence[];
  clientRows: number;
  clientCols: number;
}

const TYPING_TIMEOUT_MS = 2000;

export class StatusBar {
  private typingTimestamps: Map<string, number> = new Map();

  recordKeystroke(username: string): void {
    this.typingTimestamps.set(username, Date.now());
  }

  isTyping(username: string): boolean {
    const ts = this.typingTimestamps.get(username);
    if (!ts) return false;
    return (Date.now() - ts) < TYPING_TIMEOUT_MS;
  }

  render(options: RenderOptions): string {
    const { sessionName, users, cols } = options;

    // Line 1: session name | user list
    const userParts = users.map(u => {
      const name = u.isSizeOwner ? `[${u.username}]` : u.username;
      if (u.isTyping) {
        return color(name, 33);  // orange
      }
      return color(name, 90);    // gray
    });

    const left = color(sessionName, 36);  // cyan
    const right = userParts.join(' ');
    const line1 = `${left} │ ${right}`;

    // Line 2: typing indicator
    const typers = users.filter(u => u.isTyping).map(u => u.username);
    let line2 = '';
    if (typers.length > 0) {
      const pad = ' '.repeat(sessionName.length + 3);
      line2 = `${pad}⌨  ${color(typers.join(', '), 33)}`;
    }

    return `${line1}\n${line2}`;
  }

  renderFrame(options: FrameOptions): string {
    const { ptyData, sessionName, users, clientRows, clientCols } = options;
    const statusRows = 2;
    const contentRows = clientRows - statusRows;

    const parts: string[] = [];

    // Set scroll region for PTY content (top area)
    parts.push(setScrollRegion(1, contentRows));

    // Write PTY data into the scroll region
    parts.push(moveTo(1, 1));
    parts.push(ptyData);

    // Render status bar in the reserved bottom rows
    parts.push(saveCursor());
    parts.push(hideCursor());

    const barOutput = this.render({ sessionName, users, cols: clientCols });
    const barLines = barOutput.split('\n');

    // Status bar separator + content
    const separatorRow = clientRows - 1;
    parts.push(moveTo(separatorRow, 1));
    parts.push(clearLine());
    parts.push(barLines[0] || '');

    parts.push(moveTo(clientRows, 1));
    parts.push(clearLine());
    parts.push(barLines[1] || '');

    parts.push(restoreCursor());
    parts.push(showCursor());

    return parts.join('');
  }

  renderStatusOnly(options: {
    sessionName: string;
    users: UserPresence[];
    clientRows: number;
    clientCols: number;
  }): string {
    const parts: string[] = [];
    const barOutput = this.render({
      sessionName: options.sessionName,
      users: options.users,
      cols: options.clientCols,
    });
    const barLines = barOutput.split('\n');

    parts.push(saveCursor());
    parts.push(hideCursor());

    const separatorRow = options.clientRows - 1;
    parts.push(moveTo(separatorRow, 1));
    parts.push(clearLine());
    parts.push(barLines[0] || '');

    parts.push(moveTo(options.clientRows, 1));
    parts.push(clearLine());
    parts.push(barLines[1] || '');

    parts.push(restoreCursor());
    parts.push(showCursor());

    return parts.join('');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /srv/claude-proxy && npx vitest run tests/status-bar.test.ts
```

Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy
git add src/status-bar.ts tests/status-bar.test.ts
git commit -m "feat: status bar with live presence, typing indicators, and scroll region framing"
```

---

### Task 7: Session Manager

**Files:**
- Create: `src/session-manager.ts`
- Create: `tests/session-manager.test.ts`

- [ ] **Step 1: Write failing session manager tests**

`tests/session-manager.test.ts`:

```typescript
import { test, expect, vi, afterEach } from 'vitest';
import { SessionManager } from '../src/session-manager.js';
import type { Client } from '../src/types.js';

function makeClient(id: string): Client {
  return {
    id,
    username: id,
    transport: 'ssh' as const,
    termSize: { cols: 120, rows: 40 },
    write: vi.fn(),
    lastKeystroke: Date.now(),
  };
}

let manager: SessionManager;

afterEach(() => {
  manager?.destroyAll();
});

test('creates a session and lists it', () => {
  manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 10,
  });

  const client = makeClient('greg');
  const session = manager.createSession('test-session', client);

  expect(session.name).toBe('test-session');
  expect(session.id).toBeTruthy();

  const list = manager.listSessions();
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe('test-session');
  expect(list[0].clients.size).toBe(1);
});

test('join adds client to existing session', () => {
  manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 10,
  });

  const greg = makeClient('greg');
  const session = manager.createSession('shared', greg);

  const sam = makeClient('sam');
  manager.joinSession(session.id, sam);

  const updated = manager.getSession(session.id);
  expect(updated?.clients.size).toBe(2);
});

test('leave removes client but keeps session alive', () => {
  manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 10,
  });

  const greg = makeClient('greg');
  const sam = makeClient('sam');
  const session = manager.createSession('shared', greg);
  manager.joinSession(session.id, sam);

  manager.leaveSession(session.id, greg);

  const updated = manager.getSession(session.id);
  expect(updated?.clients.size).toBe(1);
  expect(updated?.clients.has('sam')).toBe(true);
});

test('size owner defaults to session creator', () => {
  manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 10,
  });

  const greg = makeClient('greg');
  const session = manager.createSession('test', greg);

  expect(session.sizeOwner).toBe('greg');
});

test('claimSizeOwner transfers ownership', () => {
  manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 10,
  });

  const greg = makeClient('greg');
  const sam = makeClient('sam');
  const session = manager.createSession('test', greg);
  manager.joinSession(session.id, sam);

  manager.claimSizeOwner(session.id, sam);

  const updated = manager.getSession(session.id);
  expect(updated?.sizeOwner).toBe('sam');
});

test('respects max sessions limit', () => {
  manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 2,
  });

  const c1 = makeClient('c1');
  const c2 = makeClient('c2');
  const c3 = makeClient('c3');

  manager.createSession('s1', c1);
  manager.createSession('s2', c2);

  expect(() => manager.createSession('s3', c3)).toThrow('max sessions');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /srv/claude-proxy && npx vitest run tests/session-manager.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement session-manager.ts**

```typescript
// src/session-manager.ts

import { randomUUID } from 'crypto';
import { PtyMultiplexer } from './pty-multiplexer.js';
import { StatusBar } from './status-bar.js';
import { HotkeyHandler } from './hotkey.js';
import type { Client, Session } from './types.js';

interface SessionManagerOptions {
  defaultUser: string;
  scrollbackBytes: number;
  maxSessions: number;
}

interface ManagedSession extends Session {
  pty: PtyMultiplexer;
  statusBar: StatusBar;
  hotkeys: Map<string, HotkeyHandler>;
  onClientDetach?: (client: Client) => void;
}

export class SessionManager {
  private sessions: Map<string, ManagedSession> = new Map();
  private options: SessionManagerOptions;
  private onSessionEnd?: (sessionId: string) => void;

  constructor(options: SessionManagerOptions) {
    this.options = options;
  }

  setOnSessionEnd(callback: (sessionId: string) => void): void {
    this.onSessionEnd = callback;
  }

  createSession(
    name: string,
    creator: Client,
    runAsUser?: string,
  ): Session {
    if (this.sessions.size >= this.options.maxSessions) {
      throw new Error(`Cannot create session: max sessions (${this.options.maxSessions}) reached`);
    }

    const id = randomUUID();
    const user = runAsUser ?? this.options.defaultUser;

    const pty = new PtyMultiplexer({
      command: 'claude',
      args: [],
      cols: creator.termSize.cols,
      rows: creator.termSize.rows - 2,  // reserve 2 rows for status bar
      scrollbackBytes: this.options.scrollbackBytes,
      runAsUser: user !== process.env.USER ? user : undefined,
      onExit: () => {
        this.destroySession(id);
        this.onSessionEnd?.(id);
      },
    });

    const session: ManagedSession = {
      id,
      name,
      runAsUser: user,
      createdAt: new Date(),
      sizeOwner: creator.id,
      clients: new Map(),
      pty,
      statusBar: new StatusBar(),
      hotkeys: new Map(),
    };

    this.sessions.set(id, session);
    this.joinSession(id, creator);

    return session;
  }

  joinSession(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.clients.set(client.id, client);

    // Set up scroll region on client
    const contentRows = client.termSize.rows - 2;
    const { setScrollRegion } = require('./ansi.js');
    client.write(setScrollRegion(1, contentRows));

    // Attach to PTY output
    session.pty.attach(client);

    // Set up hotkey handler for this client
    const hotkey = new HotkeyHandler({
      onPassthrough: (data) => {
        session.statusBar.recordKeystroke(client.username);
        client.lastKeystroke = Date.now();
        session.pty.write(data);
        this.refreshStatusBars(sessionId);
      },
      onDetach: () => {
        this.leaveSession(sessionId, client);
        session.onClientDetach?.(client);
      },
      onClaimSize: () => {
        this.claimSizeOwner(sessionId, client);
      },
    });
    session.hotkeys.set(client.id, hotkey);

    this.refreshStatusBars(sessionId);
  }

  leaveSession(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.pty.detach(client);
    session.clients.delete(client.id);
    session.hotkeys.get(client.id)?.destroy();
    session.hotkeys.delete(client.id);

    // Transfer size ownership if owner left
    if (session.sizeOwner === client.id && session.clients.size > 0) {
      const nextOwner = session.clients.values().next().value!;
      session.sizeOwner = nextOwner.id;
      session.pty.resize(nextOwner.termSize.cols, nextOwner.termSize.rows - 2);
    }

    this.refreshStatusBars(sessionId);
  }

  handleInput(sessionId: string, client: Client, data: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const hotkey = session.hotkeys.get(client.id);
    if (hotkey) {
      hotkey.feed(data);
    }
  }

  handleResize(sessionId: string, client: Client, size: { cols: number; rows: number }): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    client.termSize = size;

    if (session.sizeOwner === client.id) {
      session.pty.resize(size.cols, size.rows - 2);
    }

    this.refreshStatusBars(sessionId);
  }

  claimSizeOwner(sessionId: string, client: Client): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.sizeOwner = client.id;
    session.pty.resize(client.termSize.cols, client.termSize.rows - 2);
    this.refreshStatusBars(sessionId);
  }

  setOnClientDetach(sessionId: string, callback: (client: Client) => void): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.onClientDetach = callback;
    }
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const hotkey of session.hotkeys.values()) {
      hotkey.destroy();
    }
    session.pty.destroy();
    this.sessions.delete(sessionId);
  }

  destroyAll(): void {
    for (const id of this.sessions.keys()) {
      this.destroySession(id);
    }
  }

  private refreshStatusBars(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const users = Array.from(session.clients.values()).map(c => ({
      username: c.username,
      isSizeOwner: c.id === session.sizeOwner,
      isTyping: session.statusBar.isTyping(c.username),
    }));

    for (const client of session.clients.values()) {
      const statusOutput = session.statusBar.renderStatusOnly({
        sessionName: session.name,
        users,
        clientRows: client.termSize.rows,
        clientCols: client.termSize.cols,
      });
      client.write(statusOutput);
    }
  }
}
```

Note: The `joinSession` method uses a dynamic require for `ansi.js` which won't work in ESM. Fix in step 4.

- [ ] **Step 4: Fix ESM import and run tests**

Replace the dynamic require in `joinSession` with a top-level import. Change:

```typescript
const { setScrollRegion } = require('./ansi.js');
```

To add at the top of the file:

```typescript
import { setScrollRegion } from './ansi.js';
```

Then run:

```bash
cd /srv/claude-proxy && npx vitest run tests/session-manager.test.ts
```

Expected: all 6 tests PASS (note: tests use mock clients with `vi.fn()` for write, so the PTY spawns `claude` — tests may need the `command` to be overridable or we mock `PtyMultiplexer`).

**Important:** The unit tests above use mock clients but the `SessionManager` spawns real PTY processes internally. For these tests to pass in CI or without `claude` installed, we need to allow injecting a command override. Update the `createSession` method signature:

```typescript
createSession(
  name: string,
  creator: Client,
  runAsUser?: string,
  command?: string,  // default: 'claude', override for testing
): Session {
```

And in the test setup, pass `command: 'cat'` so tests don't require `claude` to be installed.

Update test calls:
```typescript
const session = manager.createSession('test-session', client, undefined, 'cat');
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /srv/claude-proxy && npx vitest run tests/session-manager.test.ts
```

Expected: all 6 tests PASS

- [ ] **Step 6: Commit**

```bash
cd /srv/claude-proxy
git add src/session-manager.ts tests/session-manager.test.ts
git commit -m "feat: session manager with create, join, leave, size ownership, and hotkey routing"
```

---

### Task 8: Lobby UI

**Files:**
- Create: `src/lobby.ts`
- Create: `tests/lobby.test.ts`

- [ ] **Step 1: Write failing lobby tests**

`tests/lobby.test.ts`:

```typescript
import { test, expect, vi } from 'vitest';
import { Lobby } from '../src/lobby.js';
import type { Session } from '../src/types.js';

test('renderScreen shows MOTD and session list', () => {
  const lobby = new Lobby({ motd: 'Welcome to droidware' });

  const sessions: Session[] = [
    {
      id: '1',
      name: 'bugfix-auth',
      runAsUser: 'root',
      createdAt: new Date(),
      sizeOwner: 'greg',
      clients: new Map([['greg', {} as any], ['sam', {} as any]]),
    },
    {
      id: '2',
      name: 'feature-api',
      runAsUser: 'root',
      createdAt: new Date(),
      sizeOwner: 'alice',
      clients: new Map([['alice', {} as any]]),
    },
  ];

  const output = lobby.renderScreen({
    username: 'greg',
    sessions,
    selectedIndex: 0,
    cols: 60,
    rows: 24,
  });

  expect(output).toContain('Welcome to droidware');
  expect(output).toContain('greg');
  expect(output).toContain('bugfix-auth');
  expect(output).toContain('feature-api');
  expect(output).toContain('2 users');
  expect(output).toContain('1 user');
});

test('renderScreen shows empty state when no sessions', () => {
  const lobby = new Lobby({ motd: 'Welcome' });

  const output = lobby.renderScreen({
    username: 'greg',
    sessions: [],
    selectedIndex: 0,
    cols: 60,
    rows: 24,
  });

  expect(output).toContain('No active sessions');
  expect(output).toContain('[n]');  // new session hint
});

test('handleInput moves selection down', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const state = { selectedIndex: 0, sessionCount: 3 };

  // Down arrow: \x1b[B
  const result = lobby.handleInput(Buffer.from('\x1b[B'), state);
  expect(result.type).toBe('navigate');
  expect(result.selectedIndex).toBe(1);
});

test('handleInput moves selection up', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const state = { selectedIndex: 2, sessionCount: 3 };

  // Up arrow: \x1b[A
  const result = lobby.handleInput(Buffer.from('\x1b[A'), state);
  expect(result.type).toBe('navigate');
  expect(result.selectedIndex).toBe(1);
});

test('handleInput enter selects session', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const state = { selectedIndex: 1, sessionCount: 3 };

  const result = lobby.handleInput(Buffer.from('\r'), state);
  expect(result.type).toBe('join');
  expect(result.selectedIndex).toBe(1);
});

test('handleInput n triggers new session', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const state = { selectedIndex: 0, sessionCount: 2 };

  const result = lobby.handleInput(Buffer.from('n'), state);
  expect(result.type).toBe('new');
});

test('handleInput q triggers quit', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const state = { selectedIndex: 0, sessionCount: 2 };

  const result = lobby.handleInput(Buffer.from('q'), state);
  expect(result.type).toBe('quit');
});

test('handleInput wraps selection at boundaries', () => {
  const lobby = new Lobby({ motd: 'Welcome' });

  // At bottom, going down wraps to top
  const down = lobby.handleInput(Buffer.from('\x1b[B'), { selectedIndex: 2, sessionCount: 3 });
  expect(down.selectedIndex).toBe(0);

  // At top, going up wraps to bottom
  const up = lobby.handleInput(Buffer.from('\x1b[A'), { selectedIndex: 0, sessionCount: 3 });
  expect(up.selectedIndex).toBe(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /srv/claude-proxy && npx vitest run tests/lobby.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement lobby.ts**

```typescript
// src/lobby.ts

import { moveTo, clearLine, color, hideCursor, showCursor } from './ansi.js';
import type { Session } from './types.js';

interface LobbyOptions {
  motd: string;
}

interface RenderOptions {
  username: string;
  sessions: Session[];
  selectedIndex: number;
  cols: number;
  rows: number;
}

interface InputState {
  selectedIndex: number;
  sessionCount: number;
}

type InputResult =
  | { type: 'navigate'; selectedIndex: number }
  | { type: 'join'; selectedIndex: number }
  | { type: 'new' }
  | { type: 'quit' }
  | { type: 'none' };

export class Lobby {
  private motd: string;

  constructor(options: LobbyOptions) {
    this.motd = options.motd;
  }

  renderScreen(options: RenderOptions): string {
    const { username, sessions, selectedIndex, cols, rows } = options;
    const parts: string[] = [];

    // Clear screen
    parts.push('\x1b[2J');
    parts.push(hideCursor());
    parts.push(moveTo(1, 1));

    // Border
    const width = Math.min(cols - 4, 56);
    const hr = '═'.repeat(width);
    const pad = (text: string) => {
      // Rough padding — strip ANSI for length calc
      const visible = text.replace(/\x1b\[[0-9;]*m/g, '');
      const remaining = width - 2 - visible.length;
      return `║ ${text}${' '.repeat(Math.max(0, remaining))} ║`;
    };

    parts.push(`╔${hr}╗\n`);
    parts.push(pad(color('claude-proxy', 1)));
    parts.push('\n');
    parts.push(pad(`Connected as: ${color(username, 36)}`));
    parts.push('\n');
    parts.push(`╠${hr}╣\n`);
    parts.push(pad(''));
    parts.push('\n');

    if (sessions.length === 0) {
      parts.push(pad('  No active sessions'));
      parts.push('\n');
    } else {
      parts.push(pad(color('  Active Sessions:', 1)));
      parts.push('\n');

      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const arrow = i === selectedIndex ? '▸' : ' ';
        const userCount = s.clients.size;
        const userWord = userCount === 1 ? 'user' : 'users';
        const userNames = Array.from(s.clients.values()).map(c => c.username).join(', ');
        const line = `  ${arrow} ${i + 1}. ${s.name} (${userCount} ${userWord}) [${userNames}]`;
        parts.push(pad(i === selectedIndex ? color(line, 1) : line));
        parts.push('\n');
      }
    }

    parts.push(pad(''));
    parts.push('\n');
    parts.push(pad(`  ${color('[n]', 33)} New session`));
    parts.push('\n');
    parts.push(pad(`  ${color('[q]', 33)} Quit`));
    parts.push('\n');
    parts.push(pad(''));
    parts.push('\n');

    if (this.motd) {
      parts.push(pad(color(this.motd, 90)));
      parts.push('\n');
    }

    parts.push(`╚${hr}╝\n`);

    return parts.join('');
  }

  handleInput(data: Buffer, state: InputState): InputResult {
    const str = data.toString();

    // Arrow down
    if (str === '\x1b[B') {
      if (state.sessionCount === 0) return { type: 'none' };
      const next = (state.selectedIndex + 1) % state.sessionCount;
      return { type: 'navigate', selectedIndex: next };
    }

    // Arrow up
    if (str === '\x1b[A') {
      if (state.sessionCount === 0) return { type: 'none' };
      const next = (state.selectedIndex - 1 + state.sessionCount) % state.sessionCount;
      return { type: 'navigate', selectedIndex: next };
    }

    // Enter
    if (str === '\r' || str === '\n') {
      if (state.sessionCount === 0) return { type: 'none' };
      return { type: 'join', selectedIndex: state.selectedIndex };
    }

    // Number keys
    if (/^[1-9]$/.test(str)) {
      const idx = parseInt(str, 10) - 1;
      if (idx < state.sessionCount) {
        return { type: 'join', selectedIndex: idx };
      }
      return { type: 'none' };
    }

    if (str === 'n' || str === 'N') return { type: 'new' };
    if (str === 'q' || str === 'Q') return { type: 'quit' };

    return { type: 'none' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /srv/claude-proxy && npx vitest run tests/lobby.test.ts
```

Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy
git add src/lobby.ts tests/lobby.test.ts
git commit -m "feat: lobby UI with session list, navigation, and ANSI rendering"
```

---

### Task 9: SSH Transport

**Files:**
- Create: `src/transport.ts`
- Create: `src/ssh-transport.ts`
- Create: `scripts/generate-host-keys.sh`

This task is integration-heavy (real SSH server). Tests will be manual for this task; we verify by connecting with an SSH client.

- [ ] **Step 1: Create transport interface**

`src/transport.ts`:

```typescript
// src/transport.ts

// Re-export the Transport interface from types for convenience
export type { Transport, Client } from './types.js';
```

- [ ] **Step 2: Create host key generation script**

`scripts/generate-host-keys.sh`:

```bash
#!/bin/bash
set -e

KEYDIR="$(dirname "$0")/../host-keys"
mkdir -p "$KEYDIR"

if [ ! -f "$KEYDIR/ssh_host_ed25519_key" ]; then
  ssh-keygen -t ed25519 -f "$KEYDIR/ssh_host_ed25519_key" -N "" -q
  echo "Generated ED25519 host key"
else
  echo "ED25519 host key already exists"
fi

if [ ! -f "$KEYDIR/ssh_host_rsa_key" ]; then
  ssh-keygen -t rsa -b 4096 -f "$KEYDIR/ssh_host_rsa_key" -N "" -q
  echo "Generated RSA host key"
else
  echo "RSA host key already exists"
fi
```

- [ ] **Step 3: Generate host keys**

```bash
cd /srv/claude-proxy && chmod +x scripts/generate-host-keys.sh && ./scripts/generate-host-keys.sh
```

Expected: `Generated ED25519 host key` and `Generated RSA host key`

- [ ] **Step 4: Implement ssh-transport.ts**

```typescript
// src/ssh-transport.ts

import { Server, type Connection, type Session as SSHSession } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import type { Transport, Client, Config } from './types.js';

interface SSHTransportOptions {
  port: number;
  host: string;
  hostKeyPath: string;
  authorizedKeysPath: string;
}

type ConnectCallback = (client: Client) => void;
type DataCallback = (data: Buffer) => void;
type ResizeCallback = (size: { cols: number; rows: number }) => void;
type DisconnectCallback = () => void;

export class SSHTransport implements Transport {
  private server: Server;
  private options: SSHTransportOptions;
  private connectCallbacks: ConnectCallback[] = [];
  private dataCallbacks: Map<string, DataCallback> = new Map();
  private resizeCallbacks: Map<string, ResizeCallback> = new Map();
  private disconnectCallbacks: Map<string, DisconnectCallback> = new Map();
  private authorizedKeys: Buffer[] = [];

  constructor(options: SSHTransportOptions) {
    this.options = options;
    this.loadAuthorizedKeys();

    const hostKeyPath = resolve(options.hostKeyPath, 'ssh_host_ed25519_key');
    const hostKey = readFileSync(hostKeyPath);

    this.server = new Server({
      hostKeys: [hostKey],
    }, (conn: Connection) => {
      this.handleConnection(conn);
    });
  }

  private loadAuthorizedKeys(): void {
    const keyPath = this.options.authorizedKeysPath.replace('~', process.env.HOME ?? '/root');
    if (!existsSync(keyPath)) {
      console.warn(`Warning: authorized_keys not found at ${keyPath}`);
      return;
    }

    const content = readFileSync(keyPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split(' ');
        if (parts.length >= 2) {
          try {
            this.authorizedKeys.push(Buffer.from(parts[1], 'base64'));
          } catch {}
        }
      }
    }
  }

  private handleConnection(conn: Connection): void {
    let username = '';

    conn.on('authentication', (ctx) => {
      username = ctx.username;

      if (ctx.method === 'publickey') {
        const keyData = ctx.key.data;
        const isAuthorized = this.authorizedKeys.some(
          (ak) => ak.equals(keyData)
        );
        if (isAuthorized) {
          ctx.accept();
          return;
        }
      }

      // Accept all for now if no keys configured (dev mode)
      if (this.authorizedKeys.length === 0) {
        ctx.accept();
        return;
      }

      ctx.reject(['publickey']);
    });

    conn.on('ready', () => {
      conn.on('session', (accept) => {
        const session: SSHSession = accept();

        session.on('pty', (accept, reject, info) => {
          accept?.();

          const clientId = randomUUID();
          let client: Client;

          session.on('shell', (accept) => {
            const stream = accept();

            client = {
              id: clientId,
              username,
              transport: 'ssh',
              termSize: { cols: info.cols, rows: info.rows },
              write: (data: Buffer | string) => {
                if (stream.writable) {
                  stream.write(data);
                }
              },
              lastKeystroke: Date.now(),
            };

            for (const cb of this.connectCallbacks) {
              cb(client);
            }

            stream.on('data', (data: Buffer) => {
              this.dataCallbacks.get(clientId)?.(data);
            });

            stream.on('close', () => {
              this.disconnectCallbacks.get(clientId)?.();
              this.dataCallbacks.delete(clientId);
              this.resizeCallbacks.delete(clientId);
              this.disconnectCallbacks.delete(clientId);
            });
          });

          session.on('window-change', (accept, reject, info) => {
            accept?.();
            if (client) {
              client.termSize = { cols: info.cols, rows: info.rows };
              this.resizeCallbacks.get(clientId)?.({ cols: info.cols, rows: info.rows });
            }
          });
        });
      });
    });

    conn.on('error', (err) => {
      console.error('SSH connection error:', err.message);
    });
  }

  onConnect(callback: ConnectCallback): void {
    this.connectCallbacks.push(callback);
  }

  onData(client: Client, callback: DataCallback): void {
    this.dataCallbacks.set(client.id, callback);
  }

  onResize(client: Client, callback: ResizeCallback): void {
    this.resizeCallbacks.set(client.id, callback);
  }

  onDisconnect(client: Client, callback: DisconnectCallback): void {
    this.disconnectCallbacks.set(client.id, callback);
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.options.port, this.options.host, () => {
        console.log(`claude-proxy SSH server listening on ${this.options.host}:${this.options.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
```

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy
git add src/transport.ts src/ssh-transport.ts scripts/generate-host-keys.sh
git commit -m "feat: SSH transport with public key auth and PTY/shell handling"
```

---

### Task 10: Main Entry Point — Wire Everything Together

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Implement index.ts**

```typescript
// src/index.ts

import { loadConfig } from './config.js';
import { SSHTransport } from './ssh-transport.js';
import { SessionManager } from './session-manager.js';
import { Lobby } from './lobby.js';
import { setScrollRegion } from './ansi.js';
import type { Client, Session } from './types.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse CLI args
const args = process.argv.slice(2);
let cliPort: number | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    cliPort = parseInt(args[i + 1], 10);
    i++;
  }
}

const config = loadConfig({ port: cliPort });

const sessionManager = new SessionManager({
  defaultUser: config.sessions.default_user,
  scrollbackBytes: config.sessions.scrollback_bytes,
  maxSessions: config.sessions.max_sessions,
});

const lobby = new Lobby({ motd: config.lobby.motd });

// Track which client is in which state
const clientState: Map<string, {
  mode: 'lobby' | 'session';
  sessionId?: string;
  selectedIndex: number;
  client: Client;
}> = new Map();

// New session creation flow state
const creationFlow: Map<string, {
  step: 'name' | 'user';
  name?: string;
  buffer: string;
}> = new Map();

const transport = new SSHTransport({
  port: config.port,
  host: config.host,
  hostKeyPath: resolve(__dirname, '..', 'host-keys'),
  authorizedKeysPath: config.auth.authorized_keys,
});

function showLobby(client: Client): void {
  const state = clientState.get(client.id);
  if (!state) return;

  state.mode = 'lobby';
  state.sessionId = undefined;

  const sessions = sessionManager.listSessions();
  const output = lobby.renderScreen({
    username: client.username,
    sessions,
    selectedIndex: state.selectedIndex,
    cols: client.termSize.cols,
    rows: client.termSize.rows,
  });
  client.write(output);
}

function joinSession(client: Client, sessionId: string): void {
  const state = clientState.get(client.id);
  if (!state) return;

  state.mode = 'session';
  state.sessionId = sessionId;

  // Clear screen before entering session
  client.write('\x1b[2J\x1b[H');

  sessionManager.joinSession(sessionId, client);
  sessionManager.setOnClientDetach(sessionId, (detachedClient) => {
    if (detachedClient.id === client.id) {
      showLobby(client);
    }
  });
}

function startNewSessionFlow(client: Client): void {
  creationFlow.set(client.id, { step: 'name', buffer: '' });
  client.write('\x1b[2J\x1b[H');
  client.write('Session name: ');
}

function handleCreationInput(client: Client, data: Buffer): void {
  const flow = creationFlow.get(client.id);
  if (!flow) return;

  const str = data.toString();

  // Handle backspace
  if (str === '\x7f' || str === '\b') {
    if (flow.buffer.length > 0) {
      flow.buffer = flow.buffer.slice(0, -1);
      client.write('\b \b');
    }
    return;
  }

  // Handle escape — cancel
  if (str === '\x1b') {
    creationFlow.delete(client.id);
    showLobby(client);
    return;
  }

  // Handle enter
  if (str === '\r' || str === '\n') {
    if (flow.step === 'name') {
      if (flow.buffer.trim() === '') {
        client.write('\r\nName cannot be empty. Session name: ');
        return;
      }
      flow.name = flow.buffer.trim();
      flow.buffer = '';
      flow.step = 'user';
      client.write(`\r\nRun as user [${config.sessions.default_user}]: `);
      return;
    }

    if (flow.step === 'user') {
      const runAsUser = flow.buffer.trim() || config.sessions.default_user;
      creationFlow.delete(client.id);

      try {
        const session = sessionManager.createSession(flow.name!, client, runAsUser);
        const state = clientState.get(client.id);
        if (state) {
          state.mode = 'session';
          state.sessionId = session.id;
        }

        sessionManager.setOnClientDetach(session.id, (detachedClient) => {
          if (detachedClient.id === client.id) {
            showLobby(client);
          }
        });

        client.write('\x1b[2J\x1b[H');
      } catch (err: any) {
        client.write(`\r\nError: ${err.message}\r\n`);
        showLobby(client);
      }
      return;
    }
  }

  // Echo character
  flow.buffer += str;
  client.write(str);
}

transport.onConnect((client) => {
  clientState.set(client.id, {
    mode: 'lobby',
    selectedIndex: 0,
    client,
  });

  transport.onData(client, (data) => {
    const state = clientState.get(client.id);
    if (!state) return;

    // In creation flow
    if (creationFlow.has(client.id)) {
      handleCreationInput(client, data);
      return;
    }

    if (state.mode === 'lobby') {
      const sessions = sessionManager.listSessions();
      const result = lobby.handleInput(data, {
        selectedIndex: state.selectedIndex,
        sessionCount: sessions.length,
      });

      switch (result.type) {
        case 'navigate':
          state.selectedIndex = result.selectedIndex;
          showLobby(client);
          break;
        case 'join':
          if (sessions[result.selectedIndex]) {
            joinSession(client, sessions[result.selectedIndex].id);
          }
          break;
        case 'new':
          startNewSessionFlow(client);
          break;
        case 'quit':
          client.write('\r\nGoodbye!\r\n');
          break;
      }
    } else if (state.mode === 'session' && state.sessionId) {
      sessionManager.handleInput(state.sessionId, client, data);
    }
  });

  transport.onResize(client, (size) => {
    const state = clientState.get(client.id);
    if (!state) return;

    if (state.mode === 'lobby') {
      showLobby(client);
    } else if (state.mode === 'session' && state.sessionId) {
      sessionManager.handleResize(state.sessionId, client, size);
    }
  });

  transport.onDisconnect(client, () => {
    const state = clientState.get(client.id);
    if (state?.mode === 'session' && state.sessionId) {
      sessionManager.leaveSession(state.sessionId, client);
    }
    clientState.delete(client.id);
    creationFlow.delete(client.id);
  });

  showLobby(client);
});

// Handle session end — notify clients in lobby
sessionManager.setOnSessionEnd((sessionId) => {
  // Refresh lobby for all clients in lobby mode
  for (const state of clientState.values()) {
    if (state.mode === 'lobby') {
      showLobby(state.client);
    }
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  sessionManager.destroyAll();
  await transport.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  sessionManager.destroyAll();
  await transport.stop();
  process.exit(0);
});

// Start
transport.start();
```

- [ ] **Step 2: Build and verify no compile errors**

```bash
cd /srv/claude-proxy && npx tsc
```

Expected: no errors (or only minor type issues to fix)

- [ ] **Step 3: Commit**

```bash
cd /srv/claude-proxy
git add src/index.ts
git commit -m "feat: main entry point wiring SSH transport, lobby, and session management"
```

---

### Task 11: systemd Service & Startup

**Files:**
- Create: `systemd/claude-proxy.service`

- [ ] **Step 1: Create systemd unit file**

`systemd/claude-proxy.service`:

```ini
[Unit]
Description=claude-proxy SSH multiplexer
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/srv/claude-proxy
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Commit**

```bash
cd /srv/claude-proxy
git add systemd/claude-proxy.service
git commit -m "feat: systemd service unit for claude-proxy"
```

---

### Task 12: Integration Test — Manual Smoke Test

- [ ] **Step 1: Build the project**

```bash
cd /srv/claude-proxy && npx tsc
```

- [ ] **Step 2: Generate host keys if not already done**

```bash
cd /srv/claude-proxy && ./scripts/generate-host-keys.sh
```

- [ ] **Step 3: Start the server in dev mode**

```bash
cd /srv/claude-proxy && npx tsx src/index.ts
```

Expected: `claude-proxy SSH server listening on 0.0.0.0:3100`

- [ ] **Step 4: Connect from another terminal**

```bash
ssh -p 3100 -o StrictHostKeyChecking=no greg@localhost
```

Expected: see the lobby UI with "Connected as: greg", no active sessions, `[n]` and `[q]` options.

- [ ] **Step 5: Create a session**

Press `n`, type a session name, press Enter, accept default user, press Enter.

Expected: Claude Code launches inside the session. Status bar visible at bottom.

- [ ] **Step 6: Connect a second client**

From another terminal:

```bash
ssh -p 3100 -o StrictHostKeyChecking=no sam@localhost
```

Expected: lobby shows the active session with 1 user. Join it. Both clients see the same Claude output. Typing in either client sends to Claude.

- [ ] **Step 7: Test detach**

Press `Ctrl+B` then `d`.

Expected: returns to lobby. Session still listed as active.

- [ ] **Step 8: Rejoin and verify scrollback**

Select the session and press Enter.

Expected: recent Claude output replayed. Session continues where it was.

- [ ] **Step 9: Test size ownership**

Press `Ctrl+B` then `s` from the second client.

Expected: status bar updates to show second client as size owner (bracketed).

- [ ] **Step 10: Commit any fixes from smoke testing**

```bash
cd /srv/claude-proxy && git add -A && git commit -m "fix: adjustments from integration smoke testing"
```

---

### Task 13: Enable systemd Service

- [ ] **Step 1: Build for production**

```bash
cd /srv/claude-proxy && npx tsc
```

- [ ] **Step 2: Symlink and enable the service**

```bash
ln -sf /srv/claude-proxy/systemd/claude-proxy.service /etc/systemd/system/claude-proxy.service
systemctl daemon-reload
systemctl enable claude-proxy
systemctl start claude-proxy
```

- [ ] **Step 3: Verify it's running**

```bash
systemctl status claude-proxy
```

Expected: active (running), listening on port 3100

- [ ] **Step 4: Verify SSH connection to the service**

```bash
ssh -p 3100 -o StrictHostKeyChecking=no greg@localhost
```

Expected: lobby UI appears

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy
git add -A
git commit -m "feat: claude-proxy Phase 1 complete — SSH multiplexer with lobby, status bar, and systemd"
```

---

## Run All Tests

```bash
cd /srv/claude-proxy && npx vitest run
```

Expected: all unit tests pass (ansi, config, hotkey, pty-multiplexer, status-bar, session-manager, lobby).
