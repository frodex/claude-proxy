# Phase C: Unix Socket Adapter + svg-terminal Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude-proxy's API listens on a Unix domain socket as primary transport. svg-terminal connects via that socket using JSON messages (not HTTP). TCP port becomes optional for dev/debug. Terminal streaming uses multiplexed subscriptions on a persistent socket connection.

**Architecture:** New `src/socket-server.ts` dispatches JSON-RPC messages to the operations module (from Phase A). svg-terminal gets a socket client module replacing 9 `fetch()`/`WebSocket()` call sites. HTTP adapter stays for browsers and OAuth redirects.

**Tech Stack:** TypeScript (claude-proxy), ESM JavaScript (svg-terminal), Node.js `net` module, `ws` library v8.20.0

**Depends on:** Phase A (`src/operations.ts` must exist — this adapter calls it)

**Research:** `docs/research/2026-04-03-v0.2-unix-socket-transport-journal.v03.md`

**IMPORTANT:** Read `sessions.md` and the Phase A plan before starting. The operations module is the foundation this adapter calls.

---

## File Structure

| File | Repo | Responsibility |
|------|------|---------------|
| `src/socket-server.ts` | claude-proxy | **New.** Unix socket listener, JSON-RPC dispatcher, stream subscriptions |
| `src/socket-protocol.ts` | claude-proxy | **New.** Message types, serialization, method registry |
| `src/api-server.ts` | claude-proxy | **Modify.** `server.listen()` optionally on TCP (config-driven) |
| `src/index.ts` | claude-proxy | **Modify.** Start socket server; TCP optional |
| `src/types.ts` | claude-proxy | **Modify.** Add `api.socket`, `api.socket_mode`, `api.socket_group` |
| `src/config.ts` | claude-proxy | **Modify.** Validate socket config |
| `claude-proxy.yaml` | claude-proxy | **Modify.** Add `api.socket` fields |
| `tests/socket-server.test.ts` | claude-proxy | **New.** Socket protocol tests |
| `server.mjs` | svg-terminal | **Modify.** Replace 9 HTTP/WS call sites with socket client |
| (inline in server.mjs or new file) | svg-terminal | **New.** Socket client utility (~50 lines) |

---

## Task 1: Define socket protocol types

**Files:**
- Create: `src/socket-protocol.ts`

- [ ] **Step 1: Write protocol types**

```typescript
// src/socket-protocol.ts

export interface SocketRequest {
  id: number;
  method: string;
  params?: Record<string, any>;
}

export interface SocketResponse {
  id: number;
  result?: any;
  error?: { code: string; message: string };
}

export interface SocketEvent {
  event: string;
  sessionId?: string;
  data: any;
}

export type SocketMessage = SocketRequest | SocketResponse | SocketEvent;

export function isRequest(msg: any): msg is SocketRequest {
  return typeof msg === 'object' && 'method' in msg && 'id' in msg;
}

export function isEvent(msg: any): msg is SocketEvent {
  return typeof msg === 'object' && 'event' in msg;
}

export function serializeMessage(msg: SocketMessage): string {
  return JSON.stringify(msg) + '\n';
}

export function parseMessage(line: string): SocketMessage | null {
  try { return JSON.parse(line.trim()); }
  catch { return null; }
}

export const METHODS = [
  'listSessions',
  'createSession',
  'getDeadSessions',
  'destroySession',
  'getSessionSettings',
  'updateSessionSettings',
  'restartSession',
  'forkSession',
  'getScreen',
  'listDirectories',
  'listUsers',
  'listGroups',
  'listRemotes',
  'authStart',
  'authExchange',
  'authMe',
  'subscribe',
  'unsubscribe',
  'input',
] as const;

export type MethodName = typeof METHODS[number];
```

- [ ] **Step 2: Build**

Run: `cd /srv/claude-proxy && npm run build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
cd /srv/claude-proxy && git add src/socket-protocol.ts && git commit -m "feat: socket protocol types — JSON-RPC message format for Unix socket"
```

---

## Task 2: Implement socket server

**Files:**
- Create: `src/socket-server.ts`
- Create: `tests/socket-server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/socket-server.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createConnection } from 'net';
import { resolve } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { serializeMessage, parseMessage } from '../src/socket-protocol.js';

const TEST_SOCKET = '/tmp/claude-proxy-test-api.sock';

// Helper: send request, read response
function socketRequest(method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = createConnection(TEST_SOCKET, () => {
      const id = Date.now();
      client.write(serializeMessage({ id, method, params: params || {} }));
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = parseMessage(line);
          if (msg && 'id' in msg && (msg as any).id === id) {
            client.end();
            resolve(msg);
          }
        }
      });
    });
    client.on('error', reject);
    setTimeout(() => { client.end(); reject(new Error('timeout')); }, 3000);
  });
}

describe('socket-server', () => {
  // These tests require starting the socket server with a mock operations module.
  // The implementing agent should set up beforeAll/afterAll with a test server.

  test('unknown method returns error', async () => {
    // Send { method: "nonexistent" } → expect error response
  });

  test('listSessions returns sessions array', async () => {
    // Send { method: "listSessions", params: { user: "root" } }
    // → expect result array
  });

  test('subscribe sends streaming events', async () => {
    // Send { method: "subscribe", params: { sessionId: "cp-test" } }
    // → expect event messages until unsubscribe
  });
});
```

- [ ] **Step 2: Implement socket server**

```typescript
// src/socket-server.ts
import { createServer, type Socket } from 'net';
import { unlinkSync, chmodSync, chownSync } from 'fs';
import { execFileSync } from 'child_process';
import { parseMessage, serializeMessage, isRequest, type SocketRequest, type MethodName } from './socket-protocol.js';
import type { ProxyOperations } from './operations.js';

interface SocketServerOptions {
  socketPath: string;
  socketMode?: number;
  socketGroup?: string;
  operations: ProxyOperations;
  sessionManager: any;  // for stream subscriptions
}

interface ConnectedClient {
  socket: Socket;
  subscriptions: Set<string>;  // session IDs
  buffer: string;
}

export class SocketServer {
  private server: ReturnType<typeof createServer>;
  private clients: Set<ConnectedClient> = new Set();
  private options: SocketServerOptions;

  constructor(options: SocketServerOptions) {
    this.options = options;
    this.server = createServer((socket) => this.handleConnection(socket));
  }

  start(): void {
    const { socketPath, socketMode, socketGroup } = this.options;

    // Clean up stale socket
    try { unlinkSync(socketPath); } catch {}

    this.server.listen(socketPath, () => {
      // Set permissions
      if (socketMode) chmodSync(socketPath, socketMode);
      if (socketGroup) {
        try {
          const gid = parseInt(execFileSync('getent', ['group', socketGroup], { encoding: 'utf-8' }).split(':')[2]);
          chownSync(socketPath, 0, gid);
        } catch (err: any) {
          console.error(`[socket] failed to set group ${socketGroup}: ${err.message}`);
        }
      }
      console.log(`[socket] listening on ${socketPath}`);
    });
  }

  stop(): void {
    for (const client of this.clients) {
      client.socket.end();
    }
    this.server.close();
    try { unlinkSync(this.options.socketPath); } catch {}
  }

  // Broadcast event to all clients subscribed to a session
  broadcastSessionEvent(sessionId: string, event: string, data: any): void {
    const msg = serializeMessage({ event, sessionId, data });
    for (const client of this.clients) {
      if (client.subscriptions.has(sessionId)) {
        client.socket.write(msg);
      }
    }
  }

  private handleConnection(socket: Socket): void {
    const client: ConnectedClient = { socket, subscriptions: new Set(), buffer: '' };
    this.clients.add(client);

    socket.on('data', (chunk) => {
      client.buffer += chunk.toString();
      const lines = client.buffer.split('\n');
      client.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = parseMessage(line);
        if (msg && isRequest(msg)) {
          this.handleRequest(client, msg);
        }
      }
    });

    socket.on('close', () => {
      client.subscriptions.clear();
      this.clients.delete(client);
    });

    socket.on('error', () => {
      client.subscriptions.clear();
      this.clients.delete(client);
    });
  }

  private async handleRequest(client: ConnectedClient, req: SocketRequest): Promise<void> {
    const ops = this.options.operations;
    const respond = (result?: any, error?: { code: string; message: string }) => {
      client.socket.write(serializeMessage(
        error ? { id: req.id, error } : { id: req.id, result: result ?? null }
      ));
    };

    try {
      const p = req.params || {};

      switch (req.method as MethodName) {
        case 'listSessions':
          respond(ops.listSessions(p.user)); break;
        case 'createSession':
          respond(ops.createSession(p, p.user)); break;
        case 'getDeadSessions':
          respond(ops.getDeadSessions(p.user)); break;
        case 'destroySession':
          ops.destroySession(p.sessionId, p.user); respond({ ok: true }); break;
        case 'getSessionSettings':
          respond(ops.getSessionSettings(p.sessionId, p.user)); break;
        case 'updateSessionSettings':
          ops.updateSessionSettings(p.sessionId, p.user, p.patch); respond({ ok: true }); break;
        case 'restartSession':
          respond(ops.restartSession(p.sessionId, p.user, p.settings)); break;
        case 'forkSession':
          respond(ops.forkSession(p.sessionId, p.user, p.settings)); break;
        case 'getScreen':
          respond(ops.getScreen(p.sessionId, p.user)); break;
        case 'listDirectories':
          respond(ops.listDirectories()); break;
        case 'listUsers':
          respond(ops.listUsers()); break;
        case 'listGroups':
          respond(ops.listGroups()); break;
        case 'listRemotes':
          respond(ops.listRemotes()); break;
        case 'authStart':
          respond(await ops.authStart(p.provider, p.callbackUrl)); break;
        case 'authExchange':
          respond(await ops.authExchange(p.provider, p.code, p.state)); break;
        case 'authMe':
          respond(ops.authMe(p.token)); break;
        case 'subscribe':
          client.subscriptions.add(p.sessionId);
          respond({ subscribed: p.sessionId });
          break;
        case 'unsubscribe':
          client.subscriptions.delete(p.sessionId);
          respond({ unsubscribed: p.sessionId });
          break;
        case 'input':
          ops.sendInput(p.sessionId, p.data, p.user);
          respond({ ok: true });
          break;
        default:
          respond(undefined, { code: 'METHOD_NOT_FOUND', message: `Unknown method: ${req.method}` });
      }
    } catch (err: any) {
      respond(undefined, { code: err.code || 'INTERNAL', message: err.message });
    }
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/socket-server.test.ts`

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/socket-server.ts tests/socket-server.test.ts && git commit -m "feat: Unix socket server — JSON-RPC dispatcher over /run/claude-proxy/api.sock"
```

---

## Task 3: Extend config and start socket server from `index.ts`

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `claude-proxy.yaml`

- [ ] **Step 1: Add socket config fields to `Config`**

In `src/types.ts`, in the `api?` block:

```typescript
  api?: {
    port?: number;
    host?: string;
    socket?: string;
    socket_mode?: number;
    socket_group?: string;
    public_base_url?: string;
    cors_origin?: string;
    auth?: { required?: boolean };
  };
```

- [ ] **Step 2: Update `claude-proxy.yaml`**

```yaml
api:
  socket: /run/claude-proxy/api.sock
  socket_mode: 0660
  socket_group: cp-services
  # port: 3101        # uncomment for dev/debug (TCP)
  # host: 127.0.0.1
```

- [ ] **Step 3: Start socket server in `index.ts`**

After the `startApiServer()` call:

```typescript
import { SocketServer } from './socket-server.js';

const socketPath = config.api?.socket;
let socketServer: SocketServer | undefined;

if (socketPath) {
  socketServer = new SocketServer({
    socketPath,
    socketMode: config.api?.socket_mode,
    socketGroup: config.api?.socket_group,
    operations: ops,  // ProxyOperations instance created earlier
    sessionManager,
  });
  socketServer.start();
}

// If no socket AND no port, warn
if (!socketPath && !apiPort) {
  console.warn('[api] no socket or port configured — API is not reachable');
}
```

Update shutdown handlers to stop socket server:

```typescript
process.on('SIGINT', async () => {
  socketServer?.stop();
  // ... existing shutdown
});
```

- [ ] **Step 4: Wire stream events into socket server**

In `index.ts`, after session manager events, broadcast to socket subscribers:

```typescript
sessionManager.on('session-end', (sessionId: string) => {
  socketServer?.broadcastSessionEvent(sessionId, 'session-end', {});
  // ... existing handler
});
```

And in the operations module or session-manager PTY data handler, broadcast screen/delta events:

```typescript
// The implementing agent should hook pty.onData or the vterm write handler
// to call socketServer.broadcastSessionEvent(sessionId, 'screen'|'delta', data)
// mirroring what api-server.ts WebSocket stream does today.
```

- [ ] **Step 5: Make HTTP adapter optional**

In `index.ts`, only start the HTTP API server if `api.port` is configured:

```typescript
if (apiPort) {
  startApiServer({ port: apiPort, host: apiHost, ... });
} else {
  console.log('[api] TCP port not configured — HTTP API disabled (socket only)');
}
```

- [ ] **Step 6: Build and verify**

Run: `cd /srv/claude-proxy && npm run build`
Expected: Clean build

- [ ] **Step 7: Commit**

```bash
cd /srv/claude-proxy && git add src/types.ts src/config.ts src/index.ts claude-proxy.yaml && git commit -m "feat: start socket server from index.ts; TCP becomes optional"
```

---

## Task 4: svg-terminal socket client

**Files:**
- Modify: `server.mjs` (svg-terminal)

- [ ] **Step 1: Create socket client utility**

Add a socket client at the top of `server.mjs` (or as a separate `cp-client.mjs`):

```javascript
// Claude-proxy socket client
import { createConnection } from 'net';

const CP_SOCKET = process.env.CLAUDE_PROXY_SOCKET || '/run/claude-proxy/api.sock';
let cpConnection = null;
let cpRequestId = 0;
const cpPendingRequests = new Map(); // id → { resolve, reject, timer }
const cpEventHandlers = new Map();  // sessionId → [callback, ...]

function ensureCpConnection() {
  if (cpConnection && !cpConnection.destroyed) return cpConnection;

  cpConnection = createConnection(CP_SOCKET);
  let buffer = '';

  cpConnection.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if ('id' in msg && cpPendingRequests.has(msg.id)) {
          const pending = cpPendingRequests.get(msg.id);
          cpPendingRequests.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) pending.reject(new Error(msg.error.message));
          else pending.resolve(msg.result);
        } else if ('event' in msg && msg.sessionId) {
          const handlers = cpEventHandlers.get(msg.sessionId);
          if (handlers) handlers.forEach(h => h(msg));
        }
      } catch {}
    }
  });

  cpConnection.on('close', () => { cpConnection = null; });
  cpConnection.on('error', () => { cpConnection = null; });

  return cpConnection;
}

function cpRequest(method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const conn = ensureCpConnection();
    const id = ++cpRequestId;
    const timer = setTimeout(() => {
      cpPendingRequests.delete(id);
      reject(new Error(`cpRequest ${method} timed out`));
    }, timeoutMs);
    cpPendingRequests.set(id, { resolve, reject, timer });
    conn.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

function cpSubscribe(sessionId, callback) {
  if (!cpEventHandlers.has(sessionId)) cpEventHandlers.set(sessionId, []);
  cpEventHandlers.get(sessionId).push(callback);
  cpRequest('subscribe', { sessionId }).catch(() => {});
}

function cpUnsubscribe(sessionId) {
  cpEventHandlers.delete(sessionId);
  cpRequest('unsubscribe', { sessionId }).catch(() => {});
}
```

- [ ] **Step 2: Replace `fetch()` call sites**

Replace each `fetch(CLAUDE_PROXY_API + '/api/sessions')` with `cpRequest('listSessions', { user })`:

| Old (line) | New |
|-----------|-----|
| `fetch(CLAUDE_PROXY_API + '/api/sessions')` (357, 613) | `await cpRequest('listSessions', { user: 'root' })` |
| `fetch(CLAUDE_PROXY_API + '/api/session/' + id + '/screen')` (231, 668) | `await cpRequest('getScreen', { sessionId: id, user: 'root' })` |

- [ ] **Step 3: Replace WebSocket bridge call sites**

Replace `new WebSocket('ws://127.0.0.1:3101/api/session/' + id + '/stream')` (lines 544, 1477) with socket subscription:

```javascript
// Before:
const upstream = new WebSocket(cpUrl);
upstream.on('message', (data) => { /* forward to browser */ });

// After:
cpSubscribe(sessionId, (msg) => {
  // msg is { event: 'screen'|'delta', sessionId, data }
  // Forward to browser WebSocket
  for (const ws of dashboardClients) {
    ws.send(JSON.stringify({ type: msg.event, session: sessionId, pane: '0', ...msg.data }));
  }
});
```

- [ ] **Step 4: Replace input forwarding**

Where svg-terminal forwards keystrokes to claude-proxy via WebSocket, replace with:

```javascript
cpRequest('input', { sessionId, data: keystrokes, user: displayName });
```

- [ ] **Step 5: Remove `CLAUDE_PROXY_API` constant and unused imports**

Delete `const CLAUDE_PROXY_API = 'http://127.0.0.1:3101';` (line 328) and any `WebSocket` import only used for claude-proxy connections.

- [ ] **Step 6: Test manually**

Start claude-proxy with socket config. Start svg-terminal. Verify:
1. Dashboard shows claude-proxy sessions
2. Terminal cards render with content
3. Keystrokes in focused terminal work
4. New sessions created from dashboard appear

- [ ] **Step 7: Commit**

```bash
cd /srv/svg-terminal && git add server.mjs && git commit -m "feat: replace HTTP/WS claude-proxy calls with Unix socket JSON-RPC client"
```

---

## Task 5: Stream broadcasting (PTY → socket subscribers)

**Files:**
- Modify: `src/socket-server.ts` or `src/operations.ts` (claude-proxy)

- [ ] **Step 1: Hook PTY output to socket broadcast**

The operations module needs a way to push terminal data to socket subscribers. In the `subscribe` handling, register a listener on the session's PTY:

```typescript
// In socket-server.ts handleRequest 'subscribe' case:
case 'subscribe': {
  client.subscriptions.add(p.sessionId);
  const session = this.options.sessionManager.getSession(p.sessionId);
  if (session) {
    // Send initial screen
    const screen = ops.getScreen(p.sessionId, p.user || 'root');
    client.socket.write(serializeMessage({ event: 'screen', sessionId: p.sessionId, data: screen }));
  }
  respond({ subscribed: p.sessionId });
  break;
}
```

For ongoing deltas, the implementing agent should hook into the same PTY data path that `api-server.ts` WebSocket streaming uses (the `StreamClient` poll loop that diffs screen state). Mirror that logic: when a screen change is detected for a session, call `socketServer.broadcastSessionEvent(sessionId, 'delta', changedData)`.

- [ ] **Step 2: Verify streaming works end-to-end**

1. Subscribe to a session via socket
2. Type in the session via SSH
3. Verify socket client receives `delta` events

- [ ] **Step 3: Commit**

```bash
cd /srv/claude-proxy && git add src/socket-server.ts && git commit -m "feat: broadcast PTY screen/delta events to socket subscribers"
```

---

## Task 6: End-to-end verification

- [ ] **Step 1: Build both projects**

```bash
cd /srv/claude-proxy && npm run build && npx vitest run
cd /srv/svg-terminal && node --test test-server.mjs
```

- [ ] **Step 2: Start with socket-only config**

Ensure `claude-proxy.yaml` has `api.socket` set and `api.port` commented out.

```bash
systemctl restart claude-proxy
journalctl -u claude-proxy --no-pager -n 10 | grep socket
```

Expected: `[socket] listening on /run/claude-proxy/api.sock`
Expected: No `[api] HTTP server listening` message

- [ ] **Step 3: Verify SSH still works**

```bash
ssh -p 3100 localhost
```
Expected: Lobby renders normally

- [ ] **Step 4: Verify svg-terminal connects via socket**

Start svg-terminal, open dashboard in browser.
Expected: Claude-proxy sessions appear, terminals render, input works.

- [ ] **Step 5: Verify TCP dev mode**

Uncomment `api.port: 3101` in YAML, restart.
Expected: Both socket AND TCP listening.

```bash
curl --unix-socket /run/claude-proxy/api.sock http://localhost/api/sessions
curl http://127.0.0.1:3101/api/sessions
```
Both should return session list.

- [ ] **Step 6: Verify socket permissions**

```bash
ls -la /run/claude-proxy/api.sock
```
Expected: `srw-rw---- root cp-services`

- [ ] **Step 7: Commit any fixes**

```bash
cd /srv/claude-proxy && git add -A && git commit -m "fix: Phase C integration verification adjustments"
cd /srv/svg-terminal && git add -A && git commit -m "fix: Phase C integration verification adjustments"
```

---

## Scope boundaries

- **OAuth callback via socket** (internal auth endpoints `authStart`/`authExchange`) → Phase D (login HTML + svg-terminal auth routes)
- **Cookie/CSRF hardening** → Phase D
- **Launch profiles** → independent plan (already written)
- **Out-of-scope security findings** → separate remediation
- **Remove `api-server.ts` entirely** → not in scope; HTTP adapter stays for browsers/OAuth/dev
