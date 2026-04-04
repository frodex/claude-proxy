// Unix domain socket — JSON-RPC requests + streaming terminal events (newline-delimited JSON).

import { createServer, type Socket } from 'net';
import { unlinkSync, chmodSync, chownSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { execFileSync } from 'child_process';
import {
  parseMessage,
  serializeMessage,
  isRequest,
  type SocketRequest,
} from './socket-protocol.js';
import type { ProxyOperations } from './operations.js';
import { composeTitle, parseAnsiLine } from './operations.js';
import { lineToSpans, bufferToScreenState } from './screen-renderer.js';
import type { SessionManager } from './session-manager.js';
import { canUserAccessSession } from './user-utils.js';
import type { CreateSessionRequest } from './operation-types.js';

const SPECIAL_KEYS: Record<string, string> = {
  Enter: '\r', Tab: '\t', Escape: '\x1b', Backspace: '\x7f', Delete: '\x1b[3~',
  Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D',
  Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
  Insert: '\x1b[2~',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
  F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
  F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
};

export interface SocketServerOptions {
  socketPath: string;
  socketMode?: number;
  socketGroup?: string;
  operations: ProxyOperations;
  sessionManager: SessionManager;
}

interface ConnectedClient {
  socket: Socket;
  subscriptions: Set<string>;
  buffer: string;
  /** Per-session streaming (PTY mirror) */
  terminalSubs: Map<string, TerminalMirror>;
}

/** Mirrors api-server WebSocket StreamClient for one session */
class TerminalMirror {
  private pollTimer?: ReturnType<typeof setInterval>;
  private dirtyLines = new Set<number>();
  private dirty = false;
  private title: string;

  constructor(
    _sessionId: string,
    private session: any,
    private emit: (data: Record<string, unknown>) => void,
  ) {
    this.title = session.name;
  }

  start(): void {
    const session = this.session;
    const pty = session.pty;
    if (!pty) return;

    const dims = pty.getScreenDimensions();
    this.title = composeTitle(session);
    const initial = pty.getInitialScreen();

    let fullState: Record<string, unknown>;
    if (initial.source === 'cache' && initial.text) {
      const textLines = initial.text.split('\n');
      const lines: Array<{ spans: unknown[] }> = [];
      for (let i = 0; i < dims.rows; i++) {
        const raw = textLines[i] || '';
        lines.push({ spans: raw ? parseAnsiLine(raw) : [] });
      }
      fullState = {
        type: 'screen' as const,
        width: dims.cols,
        height: dims.rows,
        cursor: { x: 0, y: 0 },
        title: this.title,
        lines,
      };
    } else {
      const buffer = initial.buffer ?? pty.getBuffer();
      const bs = bufferToScreenState(buffer, dims.cols, dims.rows, this.title);
      fullState = { type: 'screen', ...bs };
    }

    this.emit(fullState);

    pty.onScreenChange((startLine: number, endLine: number) => {
      this.dirty = true;
      for (let i = startLine; i < endLine; i++) this.dirtyLines.add(i);
    });

    pty.onCursorChange(() => {
      this.dirty = true;
    });

    pty.onTitleChange((t: string) => {
      this.title = t;
      this.dirty = true;
    });

    this.pollTimer = setInterval(() => {
      if (!this.dirty) return;

      const dims = pty.getScreenDimensions();
      const changed: Record<string, { spans: unknown[] }> = {};

      for (const lineIdx of this.dirtyLines) {
        const absoluteIdx = dims.baseY + lineIdx;
        const line = pty.getScreenLine(absoluteIdx);
        if (line) changed[String(lineIdx)] = { spans: lineToSpans(line, dims.cols) };
      }

      this.title = composeTitle(session);

      const delta: Record<string, unknown> = {
        type: 'delta',
        cursor: { x: dims.cursorX, y: dims.cursorY },
        title: this.title,
      };
      if (Object.keys(changed).length > 0) delta.changed = changed;

      this.emit(delta);

      this.dirtyLines.clear();
      this.dirty = false;
    }, 30);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}

export class SocketServer {
  private server: ReturnType<typeof createServer>;
  private clients = new Set<ConnectedClient>();
  private options: SocketServerOptions;

  constructor(options: SocketServerOptions) {
    this.options = options;
    this.server = createServer((socket) => this.handleConnection(socket));
  }

  /** Push an event to all clients subscribed to this session */
  broadcastSessionEvent(sessionId: string, event: string, data: unknown): void {
    const msg = serializeMessage({ event, sessionId, data });
    for (const c of this.clients) {
      if (c.subscriptions.has(sessionId)) {
        try {
          c.socket.write(msg);
        } catch { /* ignore */ }
      }
    }
  }

  start(): void {
    const { socketPath, socketMode, socketGroup } = this.options;

    try {
      mkdirSync(dirname(socketPath), { recursive: true });
    } catch { /* exists */ }

    try {
      unlinkSync(socketPath);
    } catch { /* none */ }

    this.server.listen(socketPath, () => {
      if (socketMode !== undefined) {
        try {
          chmodSync(socketPath, socketMode);
        } catch (err: unknown) {
          console.error(`[socket] chmod: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (socketGroup) {
        try {
          const gid = parseInt(
            execFileSync('getent', ['group', socketGroup], { encoding: 'utf-8' }).split(':')[2] ?? '',
            10,
          );
          if (!Number.isNaN(gid)) chownSync(socketPath, 0, gid);
        } catch (err: unknown) {
          console.error(`[socket] failed to set group ${socketGroup}: ${err instanceof Error ? err.message : err}`);
        }
      }
      console.log(`[socket] listening on ${socketPath}`);
    });
  }

  stop(): void {
    for (const c of this.clients) {
      for (const m of c.terminalSubs.values()) m.stop();
      c.terminalSubs.clear();
      c.socket.end();
    }
    this.clients.clear();
    this.server.close();
    try {
      unlinkSync(this.options.socketPath);
    } catch { /* ignore */ }
  }

  private handleConnection(socket: Socket): void {
    const client: ConnectedClient = {
      socket,
      subscriptions: new Set(),
      buffer: '',
      terminalSubs: new Map(),
    };
    this.clients.add(client);

    socket.on('data', (chunk) => {
      client.buffer += chunk.toString();
      const lines = client.buffer.split('\n');
      client.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = parseMessage(line);
        if (msg && isRequest(msg)) void this.dispatchRequest(client, msg);
      }
    });

    socket.on('close', () => this.cleanupClient(client));
    socket.on('error', () => this.cleanupClient(client));
  }

  private cleanupClient(client: ConnectedClient): void {
    for (const m of client.terminalSubs.values()) m.stop();
    client.terminalSubs.clear();
    client.subscriptions.clear();
    this.clients.delete(client);
  }

  private async dispatchRequest(client: ConnectedClient, req: SocketRequest): Promise<void> {
    const ops = this.options.operations;
    const sessionManager = this.options.sessionManager;

    const respond = (result?: unknown, error?: { code: string; message: string }): void => {
      try {
        client.socket.write(
          serializeMessage(error ? { id: req.id, error } : { id: req.id, result: result ?? null }),
        );
      } catch { /* closed */ }
    };

    const p = req.params ?? {};

    try {
      switch (req.method) {
        case 'listSessions':
          respond(ops.listSessions(p.user as string | undefined));
          break;
        case 'createSession':
          respond(ops.createSession(p.body as CreateSessionRequest, (p.user as string) || 'root'));
          break;
        case 'listDeadSessions':
          respond(ops.listDeadSessions((p.user as string) || undefined));
          break;
        case 'destroySession':
          ops.destroySession(p.sessionId as string, (p.user as string) || 'root');
          respond({ ok: true });
          break;
        case 'getSessionSettings':
          respond(ops.getSessionSettings(p.sessionId as string, (p.user as string) || 'root'));
          break;
        case 'updateSessionSettings':
          ops.updateSessionSettings(
            p.sessionId as string,
            (p.user as string) || 'root',
            (p.patch as Record<string, unknown>) || {},
          );
          respond({ ok: true });
          break;
        case 'restartSession':
          respond(
            ops.restartSession(
              p.sessionId as string,
              (p.user as string) || 'root',
              p.settings as Record<string, unknown> | undefined,
            ),
          );
          break;
        case 'forkSession':
          respond(
            ops.forkSession(
              p.sessionId as string,
              (p.user as string) || 'root',
              p.settings as Record<string, unknown> | undefined,
            ),
          );
          break;
        case 'getSessionScreen':
          respond(
            ops.getSessionScreen(p.sessionId as string, p.user as string | undefined, {
              start: p.start as number | undefined,
              end: p.end as number | undefined,
            }),
          );
          break;
        case 'getDirectoryHistory':
          respond({ history: ops.getDirectoryHistory() });
          break;
        case 'listUsers':
          respond(ops.listUsers());
          break;
        case 'listGroups':
          respond(ops.listGroups());
          break;
        case 'listRemotes':
          respond(ops.listRemotes());
          break;
        case 'startAuth':
          respond(await ops.startAuth(p.provider as string));
          break;
        case 'handleAuthCallback': {
          const callbackUrl = p.callbackUrl
            ? new URL(p.callbackUrl as string)
            : new URL('http://127.0.0.1/');
          respond(
            await ops.handleAuthCallback(
              p.provider as string,
              p.code as string,
              callbackUrl,
              p.state as string,
            ),
          );
          break;
        }
        case 'subscribe': {
          const sessionId = p.sessionId as string;
          const user = (p.user as string) || 'root';
          ops.getSessionScreen(sessionId, user);
          client.subscriptions.add(sessionId);

          const session = sessionManager.getSession(sessionId) as any;
          if (session?.pty) {
            const mirror = new TerminalMirror(sessionId, session, (data) => {
              try {
                client.socket.write(
                  serializeMessage({ event: 'terminal', sessionId, data }),
                );
              } catch { /* ignore */ }
            });
            mirror.start();
            client.terminalSubs.set(sessionId, mirror);
          }

          respond({ subscribed: sessionId });
          break;
        }
        case 'unsubscribe': {
          const sessionId = p.sessionId as string;
          client.subscriptions.delete(sessionId);
          const m = client.terminalSubs.get(sessionId);
          if (m) {
            m.stop();
            client.terminalSubs.delete(sessionId);
          }
          respond({ unsubscribed: sessionId });
          break;
        }
        case 'input':
          this.sendInput(p.sessionId as string, (p.user as string) || 'root', p.body);
          respond({ ok: true });
          break;
        case 'resize':
          this.handleResize(client, p.sessionId as string, (p.user as string) || 'root', p.cols, p.rows);
          respond({ ok: true });
          break;
        case 'scroll':
          this.handleScroll(client, p.sessionId as string, (p.user as string) || 'root', p.offset);
          respond({ ok: true });
          break;
        default:
          respond(undefined, { code: 'METHOD_NOT_FOUND', message: `Unknown method: ${req.method}` });
      }
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      respond(undefined, { code: e.code || 'INTERNAL', message: e.message || String(err) });
    }
  }

  private handleResize(
    client: ConnectedClient,
    sessionId: string,
    username: string,
    colsRaw: unknown,
    rowsRaw: unknown,
  ): void {
    const session = this.options.sessionManager.getSession(sessionId) as any;
    if (!session?.pty) {
      throw { code: 'NOT_FOUND', message: 'Session not found' };
    }
    if (!canUserAccessSession(username, session.access)) {
      throw { code: 'FORBIDDEN', message: 'Permission denied' };
    }
    const cols = parseInt(String(colsRaw), 10);
    const rows = parseInt(String(rowsRaw), 10);
    if (cols > 0 && rows > 0 && cols <= 500 && rows <= 200) {
      session.pty.resize(cols, rows);
      setTimeout(() => {
        const buffer = session.pty.getBuffer();
        const dims = session.pty.getScreenDimensions();
        const title = composeTitle(session);
        const fullState = bufferToScreenState(buffer, dims.cols, dims.rows, title);
        try {
          client.socket.write(
            serializeMessage({
              event: 'terminal',
              sessionId,
              data: { type: 'screen', ...fullState },
            }),
          );
        } catch { /* closed */ }
      }, 50);
    }
  }

  private handleScroll(
    client: ConnectedClient,
    sessionId: string,
    username: string,
    offsetRaw: unknown,
  ): void {
    const session = this.options.sessionManager.getSession(sessionId) as any;
    if (!session?.pty) {
      throw { code: 'NOT_FOUND', message: 'Session not found' };
    }
    if (!canUserAccessSession(username, session.access)) {
      throw { code: 'FORBIDDEN', message: 'Permission denied' };
    }
    const offset = parseInt(String(offsetRaw), 10) || 0;
    const dims = session.pty.getScreenDimensions();
    const tmuxId = session.pty.getTmuxId();
    const socketPath = session.pty.getSocketPath();

    const startLine = offset > 0 ? -offset : 0;
    const endLine = offset > 0 ? -offset + dims.rows - 1 : dims.rows - 1;

    const tmuxArgs = socketPath
      ? ['-S', socketPath, 'capture-pane', '-p', '-e', '-t', tmuxId, '-S', String(startLine), '-E', String(endLine)]
      : ['capture-pane', '-p', '-e', '-t', tmuxId, '-S', String(startLine), '-E', String(endLine)];

    let capturedLines: string[];
    try {
      const output = execFileSync('tmux', tmuxArgs, { encoding: 'utf-8', timeout: 5000 });
      capturedLines = output.split('\n');
      if (capturedLines.length > 0 && capturedLines[capturedLines.length - 1] === '') {
        capturedLines.pop();
      }
    } catch (err: unknown) {
      console.error(
        `[socket] scroll capture-pane failed: ${err instanceof Error ? err.message : err}`,
      );
      capturedLines = [];
    }

    const lines: Array<{ spans: ReturnType<typeof parseAnsiLine> }> = [];
    for (let i = 0; i < dims.rows; i++) {
      if (i < capturedLines.length) {
        lines.push({ spans: parseAnsiLine(capturedLines[i]!) });
      } else {
        lines.push({ spans: [] });
      }
    }

    const maxScrollback = session.pty.getHistorySize();
    const title = composeTitle(session);

    try {
      client.socket.write(
        serializeMessage({
          event: 'terminal',
          sessionId,
          data: {
            type: 'screen',
            width: dims.cols,
            height: dims.rows,
            cursor: offset > 0 ? { x: 0, y: 0 } : { x: dims.cursorX, y: dims.cursorY },
            title,
            scrollOffset: offset,
            maxScrollback,
            lines,
          },
        }),
      );
    } catch { /* closed */ }
  }

  private sendInput(sessionId: string, username: string, body: unknown): void {
    const session = this.options.sessionManager.getSession(sessionId) as any;
    if (!session?.pty) {
      throw { code: 'NOT_FOUND', message: 'Session not found' };
    }
    if (!canUserAccessSession(username, session.access)) {
      throw { code: 'FORBIDDEN', message: 'Permission denied' };
    }

    const msg = body as Record<string, unknown>;
    let bytes = '';
    if (msg?.specialKey) {
      bytes = SPECIAL_KEYS[msg.specialKey as string] || '';
    } else if (msg?.keys) {
      bytes = String(msg.keys);
      if (msg.ctrl && bytes.length === 1) {
        bytes = String.fromCharCode(bytes.toLowerCase().charCodeAt(0) - 96);
      } else if (msg.alt && bytes.length === 1) {
        bytes = '\x1b' + bytes;
      }
    }
    if (bytes) session.pty.write(Buffer.from(bytes));
  }
}
