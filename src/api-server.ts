// src/api-server.ts
// HTTP + WebSocket API server for browser clients (port 3101)
// Thin HTTP adapter — business logic lives in operations.ts

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, existsSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, extname, resolve } from 'path';
import { SessionManager } from './session-manager.js';
import { lineToSpans, bufferToScreenState } from './screen-renderer.js';
import type { Config } from './types.js';
import { DirScanner } from './dir-scanner.js';
import type { OAuthManager } from './auth/oauth.js';
import type { GitHubAdapter } from './auth/github-adapter.js';
import type { UserStore, Provisioner } from './auth/types.js';
import { ProxyOperations, composeTitle, parseAnsiLine } from './operations.js';
import { validateSessionCookie } from './auth/session-cookie.js';

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

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  header.split(';').forEach(pair => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}

interface ApiServerOptions {
  port: number;
  host: string;
  sessionManager: SessionManager;
  config: Config;
  staticDir: string;
  dirScanner: DirScanner;
  oauthManager?: OAuthManager;
  githubAdapter?: GitHubAdapter;
  userStore?: UserStore;
  provisioner?: Provisioner;
  cookieSecret?: string;
  cookieMaxAge?: number;
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

interface CookiePayload {
  linuxUser: string;
  displayName: string;
}

function json(res: ServerResponse, status: number, body: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function errorResponse(res: ServerResponse, err: any): void {
  const code = err.code;
  const status = code === 'NOT_FOUND' ? 404
    : code === 'FORBIDDEN' ? 403
    : code === 'BAD_REQUEST' ? 400
    : code === 'UNAUTHORIZED' ? 401
    : code === 'CONFLICT' ? 409
    : 500;
  json(res, status, { error: err.message || 'Internal error' });
}

export function startApiServer(options: ApiServerOptions): void {
  const { port, host, sessionManager, config, staticDir, dirScanner,
    oauthManager, githubAdapter, userStore, provisioner,
    cookieSecret, cookieMaxAge } = options;
  const streamClients: Map<WebSocket, StreamClient> = new Map();
  const pendingOAuthStates: Map<string, { provider: string; createdAt: number }> = new Map();
  const apiAuthRequired = !!cookieSecret;

  const ops = new ProxyOperations(
    sessionManager, config, dirScanner,
    oauthManager, githubAdapter, userStore, provisioner,
  );

  function requireAuth(req: IncomingMessage, res: ServerResponse): CookiePayload | null {
    if (!apiAuthRequired) return { linuxUser: 'root', displayName: 'root' };
    const cookies = parseCookies(req.headers.cookie || '');
    const session = cookies['session'];
    if (!session || !cookieSecret) {
      json(res, 401, { error: 'Authentication required' });
      return null;
    }
    const payload = validateSessionCookie(session, cookieSecret);
    if (!payload) {
      json(res, 401, { error: 'Invalid or expired session' });
      return null;
    }
    return payload;
  }

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

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // CORS — use configured origin or fall back to wildcard for dev
    const allowedOrigin = (config as any).api?.cors_origin || (config as any).api?.public_base_url || '';
    if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // --- Auth routes (stay in api-server — cookie/redirect concerns) ---

    if (url.pathname === '/api/auth/providers' && req.method === 'GET') {
      json(res, 200, { providers: ops.getAuthProviders() });
      return;
    }

    if (url.pathname === '/api/auth/login' && req.method === 'GET') {
      const provider = url.searchParams.get('provider');
      if (!provider) {
        json(res, 400, { error: 'provider parameter required' });
        return;
      }

      try {
        const result = await ops.startAuth(provider);
        pendingOAuthStates.set(result.state, { provider, createdAt: Date.now() });

        // Clean up old states (> 10 min)
        const cutoff = Date.now() - 600000;
        for (const [s, v] of pendingOAuthStates) {
          if (v.createdAt < cutoff) pendingOAuthStates.delete(s);
        }

        res.writeHead(302, { Location: result.authUrl });
        res.end();
      } catch (err: any) {
        errorResponse(res, err);
      }
      return;
    }

    if (url.pathname === '/api/auth/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (!code || !state) {
        json(res, 400, { error: 'Missing code or state' });
        return;
      }

      const pending = pendingOAuthStates.get(state);
      if (!pending) {
        json(res, 400, { error: 'Invalid or expired state' });
        return;
      }
      pendingOAuthStates.delete(state);

      try {
        const result = await ops.handleAuthCallback(pending.provider, code, url, state);

        const { createSessionCookie } = await import('./auth/session-cookie.js');
        const secret = cookieSecret!;
        const maxAge = cookieMaxAge || 86400;
        const cookie = createSessionCookie(
          { linuxUser: result.identity.linuxUser, displayName: result.identity.displayName },
          secret,
          maxAge,
        );

        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `session=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
        });
        res.end();
      } catch (err: any) {
        console.error('[auth] callback error:', err.message);
        json(res, 500, { error: 'Authentication failed' });
      }
      return;
    }

    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      const { validateSessionCookie } = await import('./auth/session-cookie.js');
      const cookieHeader = req.headers.cookie || '';
      const cookies = parseCookies(cookieHeader);
      const sessionCookie = cookies['session'];

      if (!sessionCookie || !cookieSecret) {
        json(res, 401, { error: 'Not authenticated' });
        return;
      }

      const payload = validateSessionCookie(sessionCookie, cookieSecret);
      if (!payload) {
        json(res, 401, { error: 'Invalid or expired session' });
        return;
      }

      json(res, 200, { user: payload });
      return;
    }

    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0',
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // --- Session CRUD routes — thin delegation to operations ---

    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      const user = requireAuth(req, res); if (!user) return;
      try {
        const body = JSON.parse(await readBody(req));
        const result = ops.createSession(body, user.linuxUser);
        json(res, 201, result);
      } catch (err: any) {
        errorResponse(res, err);
      }
      return;
    }

    if (url.pathname === '/api/sessions/dead' && req.method === 'GET') {
      const user = requireAuth(req, res); if (!user) return;
      try {
        json(res, 200, ops.listDeadSessions());
      } catch (err: any) {
        errorResponse(res, err);
      }
      return;
    }

    if (url.pathname.match(/^\/api\/sessions\/[^/]+$/) && req.method === 'DELETE') {
      const user = requireAuth(req, res); if (!user) return;
      const id = url.pathname.split('/')[3];
      try {
        ops.destroySession(id, user.linuxUser);
        json(res, 200, { ok: true });
      } catch (err: any) {
        errorResponse(res, err);
      }
      return;
    }

    if (url.pathname.match(/^\/api\/sessions\/[^/]+\/settings$/) && req.method === 'GET') {
      const user = requireAuth(req, res); if (!user) return;
      const id = url.pathname.split('/')[3];
      try {
        json(res, 200, ops.getSessionSettings(id, user.linuxUser));
      } catch (err: any) {
        errorResponse(res, err);
      }
      return;
    }

    if (url.pathname.match(/^\/api\/sessions\/[^/]+\/settings$/) && req.method === 'PATCH') {
      const user = requireAuth(req, res); if (!user) return;
      const id = url.pathname.split('/')[3];
      try {
        const body = JSON.parse(await readBody(req));
        ops.updateSessionSettings(id, user.linuxUser, body);
        json(res, 200, { ok: true });
      } catch (err: any) {
        errorResponse(res, err);
      }
      return;
    }

    if (url.pathname.match(/^\/api\/sessions\/[^/]+\/restart$/) && req.method === 'POST') {
      const user = requireAuth(req, res); if (!user) return;
      const id = url.pathname.split('/')[3];
      try {
        const body = JSON.parse(await readBody(req));
        const result = ops.restartSession(id, user.linuxUser, body.settings);
        json(res, 201, result);
      } catch (err: any) {
        errorResponse(res, err);
      }
      return;
    }

    if (url.pathname.match(/^\/api\/sessions\/[^/]+\/fork$/) && req.method === 'POST') {
      const user = requireAuth(req, res); if (!user) return;
      const id = url.pathname.split('/')[3];
      try {
        const body = JSON.parse(await readBody(req));
        const result = ops.forkSession(id, user.linuxUser, body.settings);
        json(res, 201, result);
      } catch (err: any) {
        errorResponse(res, err);
      }
      return;
    }

    // --- Supporting endpoints ---

    if (url.pathname === '/api/remotes' && req.method === 'GET') {
      json(res, 200, ops.listRemotes());
      return;
    }

    if (url.pathname === '/api/users' && req.method === 'GET') {
      try {
        json(res, 200, ops.listUsers());
      } catch (err: any) {
        errorResponse(res, err);
      }
      return;
    }

    if (url.pathname === '/api/groups' && req.method === 'GET') {
      try {
        json(res, 200, ops.listGroups());
      } catch (err: any) {
        errorResponse(res, err);
      }
      return;
    }

    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const user = requireAuth(req, res); if (!user) return;
      try {
        json(res, 200, ops.listSessions(user.linuxUser));
      } catch (err: any) {
        errorResponse(res, err);
      }
      return;
    }

    if (url.pathname === '/api/directories' && req.method === 'GET') {
      json(res, 200, { history: ops.getDirectoryHistory() });
      return;
    }

    // API: screen state (HTTP)
    const screenMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/screen$/);
    if (screenMatch && req.method === 'GET') {
      const user = requireAuth(req, res); if (!user) return;
      const sessionId = screenMatch[1];
      try {
        const start = url.searchParams.has('start') ? parseInt(url.searchParams.get('start')!) : undefined;
        const end = url.searchParams.has('end') ? parseInt(url.searchParams.get('end')!) : undefined;
        const state = ops.getSessionScreen(sessionId, user.linuxUser, { start, end });
        json(res, 200, state);
      } catch (err: any) {
        errorResponse(res, err);
      }
      return;
    }

    // Static file serving from web/ directory
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const fullPath = resolve(staticDir, '.' + filePath);

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
    const dims = session.pty.getScreenDimensions();
    client.title = composeTitle(session);
    const initial = session.pty.getInitialScreen();

    let fullState: any;
    if (initial.source === 'cache' && initial.text) {
      const textLines = initial.text.split('\n');
      const lines: Array<{ spans: any[] }> = [];
      for (let i = 0; i < dims.rows; i++) {
        const raw = textLines[i] || '';
        lines.push({ spans: raw ? parseAnsiLine(raw) : [] });
      }
      fullState = {
        width: dims.cols,
        height: dims.rows,
        cursor: { x: 0, y: 0 },
        title: client.title,
        lines,
      };
    } else {
      const buffer = initial.buffer ?? session.pty.getBuffer();
      fullState = bufferToScreenState(buffer, dims.cols, dims.rows, client.title);
    }

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
              bytes = String.fromCharCode(bytes.toLowerCase().charCodeAt(0) - 96);
            } else if (msg.alt && bytes.length === 1) {
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
          const offset = parseInt(msg.offset) || 0;
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
          } catch (err: any) {
            console.error(`[api] scroll capture-pane failed: ${err.message}`);
            capturedLines = [];
          }

          const lines: any[] = [];
          for (let i = 0; i < dims.rows; i++) {
            if (i < capturedLines.length) {
              lines.push({ spans: parseAnsiLine(capturedLines[i]) });
            } else {
              lines.push({ spans: [] });
            }
          }

          const maxScrollback = session.pty.getHistorySize();

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'screen',
              width: dims.cols,
              height: dims.rows,
              cursor: offset > 0
                ? { x: 0, y: 0 }
                : { x: dims.cursorX, y: dims.cursorY },
              title: client.title,
              scrollOffset: offset,
              maxScrollback,
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
