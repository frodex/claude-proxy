// src/api-server.ts
// HTTP + WebSocket API server for browser clients (port 3101)
// Serves: session list, bidirectional terminal stream, static files

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname, resolve } from 'path';
import { SessionManager } from './session-manager.js';
import { lineToSpans, bufferToScreenState, type ScreenLine } from './screen-renderer.js';
import type { Config, Session } from './types.js';

function composeTitle(session: any): string {
  const users = Array.from(session.clients.values()).map((c: any) => {
    const prefix = c.id === session.sizeOwner ? '*' : '';
    return `${prefix}${c.username}`;
  });

  const ms = Date.now() - new Date(session.createdAt).getTime();
  const seconds = Math.floor(ms / 1000);
  let uptime: string;
  if (seconds < 60) uptime = `${seconds}s`;
  else if (seconds < 3600) uptime = `${Math.floor(seconds / 60)}m`;
  else { const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); uptime = `${h}h${m > 0 ? m + 'm' : ''}`; }

  const userStr = users.length > 0 ? users.join(', ') : 'no users';
  return `${session.name} | ${userStr} | ${uptime}`;
}

// Key translation: structured browser input → PTY escape sequences
const SPECIAL_KEYS: Record<string, string> = {
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
  Delete: '\x1b[3~',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Insert: '\x1b[2~',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
  F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
  F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
};

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

interface ApiServerOptions {
  port: number;
  host: string;
  sessionManager: SessionManager;
  config: Config;
  staticDir: string;
}

interface StreamClient {
  ws: WebSocket;
  sessionId: string;
  dirtyLines: Set<number>;
  dirty: boolean;
  cursorDirty: boolean;
  title: string;
  pollTimer?: ReturnType<typeof setInterval>;
}

export function startApiServer(options: ApiServerOptions): void {
  const { port, host, sessionManager, staticDir } = options;
  const streamClients: Map<WebSocket, StreamClient> = new Map();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // CORS for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // API: session list
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const sessions = sessionManager.listSessions().map(s => {
        const pty = (s as any).pty;
        const dims = pty?.getScreenDimensions?.() ?? { cols: 80, rows: 24 };
        return {
          id: s.id,
          name: s.name,
          title: composeTitle(s),
          cols: dims.cols,
          rows: dims.rows,
          clients: s.clients.size,
          owner: s.access?.owner,
          createdAt: s.createdAt.toISOString(),
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
      return;
    }

    // API: screen state (HTTP)
    const screenMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/screen$/);
    if (screenMatch && req.method === 'GET') {
      const sessionId = screenMatch[1];
      const session = sessionManager.getSession(sessionId) as any;
      if (!session || !session.pty) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      const buffer = session.pty.getBuffer();
      const dims = session.pty.getScreenDimensions();
      const title = session.currentTitle || session.name;

      // Support line range query: ?start=N&end=M
      const start = parseInt(url.searchParams.get('start') || String(dims.baseY));
      const end = parseInt(url.searchParams.get('end') || String(dims.baseY + dims.rows));

      const state = bufferToScreenState(buffer, dims.cols, end - start, title);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }

    // Static file serving from web/ directory
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const fullPath = resolve(staticDir, '.' + filePath);

    // Security: prevent directory traversal
    if (!fullPath.startsWith(resolve(staticDir))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (existsSync(fullPath) && statSync(fullPath).isFile()) {
      const ext = extname(fullPath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(readFileSync(fullPath));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const streamMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/stream$/);

    if (!streamMatch) {
      ws.close(4000, 'Invalid endpoint');
      return;
    }

    const sessionId = streamMatch[1];
    const session = sessionManager.getSession(sessionId) as any;

    if (!session || !session.pty) {
      ws.close(4004, 'Session not found');
      return;
    }

    console.log(`[api] WebSocket connected to session ${sessionId}`);

    const client: StreamClient = {
      ws,
      sessionId,
      dirtyLines: new Set(),
      dirty: false,
      cursorDirty: false,
      title: session.name,
    };
    streamClients.set(ws, client);

    // Send full screen state on connect
    const buffer = session.pty.getBuffer();
    const dims = session.pty.getScreenDimensions();
    client.title = composeTitle(session);
    const fullState = bufferToScreenState(buffer, dims.cols, dims.rows, client.title);
    ws.send(JSON.stringify({ type: 'screen', ...fullState }));

    // Register for screen changes
    session.pty.onScreenChange((startLine: number, endLine: number) => {
      client.dirty = true;
      for (let i = startLine; i < endLine; i++) {
        client.dirtyLines.add(i);
      }
    });

    session.pty.onCursorChange(() => {
      client.cursorDirty = true;
      client.dirty = true;
    });

    session.pty.onTitleChange((title: string) => {
      client.title = title;
      client.dirty = true;
    });

    // 30ms batched delta push
    client.pollTimer = setInterval(() => {
      if (!client.dirty) return;
      if (ws.readyState !== WebSocket.OPEN) return;

      const dims = session.pty.getScreenDimensions();
      const changed: Record<string, { spans: any[] }> = {};

      for (const lineIdx of client.dirtyLines) {
        const absoluteIdx = dims.baseY + lineIdx;
        const line = session.pty.getScreenLine(absoluteIdx);
        if (line) {
          changed[String(lineIdx)] = { spans: lineToSpans(line, dims.cols) };
        }
      }

      // Recompose title on every delta (users/uptime change)
      client.title = composeTitle(session);

      const delta: any = {
        type: 'delta',
        cursor: { x: dims.cursorX, y: dims.cursorY },
        title: client.title,
      };

      if (Object.keys(changed).length > 0) {
        delta.changed = changed;
      }

      ws.send(JSON.stringify(delta));

      client.dirtyLines.clear();
      client.dirty = false;
      client.cursorDirty = false;
    }, 30);

    // Handle incoming messages (input, resize, scroll)
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'input') {
          let bytes: string;
          if (msg.specialKey) {
            bytes = SPECIAL_KEYS[msg.specialKey] || '';
          } else if (msg.keys) {
            bytes = msg.keys;
            if (msg.ctrl && bytes.length === 1) {
              // Ctrl+key: convert to control character
              bytes = String.fromCharCode(bytes.toLowerCase().charCodeAt(0) - 96);
            } else if (msg.alt && bytes.length === 1) {
              // Alt+key: ESC prefix
              bytes = '\x1b' + bytes;
            }
          } else {
            return;
          }
          if (bytes) {
            session.pty.write(Buffer.from(bytes));
          }
        }

        if (msg.type === 'resize') {
          const cols = parseInt(msg.cols);
          const rows = parseInt(msg.rows);
          if (cols > 0 && rows > 0 && cols <= 500 && rows <= 200) {
            session.pty.resize(cols, rows);
            // Send full screen after resize
            setTimeout(() => {
              const buffer = session.pty.getBuffer();
              const dims = session.pty.getScreenDimensions();
              const fullState = bufferToScreenState(buffer, dims.cols, dims.rows, client.title);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'screen', ...fullState }));
              }
            }, 50);
          }
        }

        if (msg.type === 'scroll') {
          const offset = parseInt(msg.offset);
          const dims = session.pty.getScreenDimensions();
          const maxOffset = Math.max(0, dims.baseY);
          const clampedOffset = Math.max(0, Math.min(offset, maxOffset));

          // Read lines at the scrolled position
          const lines: any[] = [];
          const startLine = dims.baseY - clampedOffset;
          for (let i = 0; i < dims.rows; i++) {
            const line = session.pty.getScreenLine(startLine + i);
            if (line) {
              lines.push({ spans: lineToSpans(line, dims.cols) });
            } else {
              lines.push({ spans: [] });
            }
          }

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'screen',
              width: dims.cols,
              height: dims.rows,
              cursor: { x: dims.cursorX, y: dims.cursorY },
              title: client.title,
              scrollOffset: clampedOffset,
              lines,
            }));
          }
        }
      } catch (err: any) {
        console.error(`[api] message parse error: ${err.message}`);
      }
    });

    ws.on('close', () => {
      console.log(`[api] WebSocket disconnected from session ${sessionId}`);
      if (client.pollTimer) clearInterval(client.pollTimer);
      streamClients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error(`[api] WebSocket error: ${err.message}`);
    });
  });

  server.listen(port, host, () => {
    console.log(`[api] HTTP+WS server listening on ${host}:${port}`);
  });
}
