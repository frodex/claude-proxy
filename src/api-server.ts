// src/api-server.ts
// HTTP + WebSocket API server for browser clients (port 3101)
// Serves: session list, bidirectional terminal stream, static files

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join, extname, resolve } from 'path';
import { randomBytes } from 'crypto';
import { SessionManager } from './session-manager.js';
import { lineToSpans, bufferToScreenState, PALETTE_256, type ScreenLine } from './screen-renderer.js';
import type { Config, Session } from './types.js';
import { DirScanner } from './dir-scanner.js';
import type { OAuthManager } from './auth/oauth.js';
import type { GitHubAdapter } from './auth/github-adapter.js';
import type { UserStore, Provisioner } from './auth/types.js';

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
  // Auth fields (all optional for backward compatibility)
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

/**
 * Parse a line of tmux capture-pane -e output (ANSI escape codes) into spans.
 */
function parseAnsiLine(raw: string): Array<{ text: string; fg?: string; bg?: string; bold?: boolean; italic?: boolean; underline?: boolean; dim?: boolean; strikethrough?: boolean }> {
  const spans: Array<any> = [];
  let current: any = { text: '' };
  let i = 0;

  while (i < raw.length) {
    if (raw[i] === '\x1b' && raw[i + 1] === '[') {
      if (current.text) {
        spans.push(current);
        current = { ...current, text: '' };
      }
      const end = raw.indexOf('m', i + 2);
      if (end === -1) { i++; continue; }
      const codes = raw.slice(i + 2, end).split(';').map(Number);
      i = end + 1;

      for (let c = 0; c < codes.length; c++) {
        const code = codes[c];
        if (code === 0) { current = { text: '' }; }
        else if (code === 1) { current.bold = true; }
        else if (code === 2) { current.dim = true; }
        else if (code === 3) { current.italic = true; }
        else if (code === 4) { current.underline = true; }
        else if (code === 9) { current.strikethrough = true; }
        else if (code === 22) { delete current.bold; delete current.dim; }
        else if (code === 23) { delete current.italic; }
        else if (code === 24) { delete current.underline; }
        else if (code === 29) { delete current.strikethrough; }
        else if (code >= 30 && code <= 37) { current.fg = PALETTE_256[code - 30]; }
        else if (code === 38 && codes[c + 1] === 5) { current.fg = PALETTE_256[codes[c + 2]] ?? undefined; c += 2; }
        else if (code === 38 && codes[c + 1] === 2) {
          current.fg = `#${codes[c+2].toString(16).padStart(2,'0')}${codes[c+3].toString(16).padStart(2,'0')}${codes[c+4].toString(16).padStart(2,'0')}`;
          c += 4;
        }
        else if (code >= 40 && code <= 47) { current.bg = PALETTE_256[code - 40]; }
        else if (code === 48 && codes[c + 1] === 5) { current.bg = PALETTE_256[codes[c + 2]] ?? undefined; c += 2; }
        else if (code === 48 && codes[c + 1] === 2) {
          current.bg = `#${codes[c+2].toString(16).padStart(2,'0')}${codes[c+3].toString(16).padStart(2,'0')}${codes[c+4].toString(16).padStart(2,'0')}`;
          c += 4;
        }
        else if (code >= 90 && code <= 97) { current.fg = PALETTE_256[code - 90 + 8]; }
        else if (code >= 100 && code <= 107) { current.bg = PALETTE_256[code - 100 + 8]; }
        else if (code === 39) { delete current.fg; }
        else if (code === 49) { delete current.bg; }
      }
    } else {
      current.text += raw[i];
      i++;
    }
  }

  if (current.text) spans.push(current);
  return spans;
}

export function startApiServer(options: ApiServerOptions): void {
  const { port, host, sessionManager, staticDir, dirScanner,
    oauthManager, githubAdapter, userStore, provisioner,
    cookieSecret, cookieMaxAge } = options;
  const streamClients: Map<WebSocket, StreamClient> = new Map();
  const pendingOAuthStates: Map<string, { provider: string; createdAt: number }> = new Map();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

    // --- Auth routes ---

    // GET /api/auth/providers
    if (url.pathname === '/api/auth/providers' && req.method === 'GET') {
      const providers: string[] = [];
      if (oauthManager) providers.push(...oauthManager.getSupportedProviders());
      if (githubAdapter) providers.push('github');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ providers }));
      return;
    }

    // GET /api/auth/login
    if (url.pathname === '/api/auth/login' && req.method === 'GET') {
      const provider = url.searchParams.get('provider');
      if (!provider) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'provider parameter required' }));
        return;
      }

      // Generate random state
      const state = randomBytes(16).toString('hex');
      pendingOAuthStates.set(state, { provider, createdAt: Date.now() });

      // Clean up old states (> 10 min)
      const cutoff = Date.now() - 600000;
      for (const [s, v] of pendingOAuthStates) {
        if (v.createdAt < cutoff) pendingOAuthStates.delete(s);
      }

      try {
        let authUrl: string;
        if (provider === 'github' && githubAdapter) {
          authUrl = githubAdapter.getAuthUrl(state);
        } else if (oauthManager) {
          authUrl = await oauthManager.getAuthUrl(provider, state);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Provider "${provider}" not configured` }));
          return;
        }
        res.writeHead(302, { Location: authUrl });
        res.end();
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // GET /api/auth/callback
    if (url.pathname === '/api/auth/callback' && req.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing code or state' }));
        return;
      }

      const pending = pendingOAuthStates.get(state);
      if (!pending) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired state' }));
        return;
      }
      pendingOAuthStates.delete(state);

      try {
        let profile: { email: string; displayName: string; providerId: string };
        if (pending.provider === 'github' && githubAdapter) {
          profile = await githubAdapter.handleCallback(code);
        } else if (oauthManager) {
          profile = await oauthManager.handleCallback(pending.provider, url, state);
        } else {
          throw new Error('Provider not configured');
        }

        // Resolve user identity
        const { resolveUser } = await import('./auth/resolve-user.js');
        const result = resolveUser(
          {
            type: 'oauth',
            provider: pending.provider,
            providerId: profile.providerId,
            email: profile.email,
            displayName: profile.displayName,
          },
          userStore!,
          provisioner!,
        );

        // Create session cookie
        const { createSessionCookie } = await import('./auth/session-cookie.js');
        const secret = cookieSecret || 'default-insecure-secret';
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
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authentication failed' }));
      }
      return;
    }

    // GET /api/auth/me
    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      const { validateSessionCookie } = await import('./auth/session-cookie.js');
      const cookieHeader = req.headers.cookie || '';
      const cookies = parseCookies(cookieHeader);
      const sessionCookie = cookies['session'];

      if (!sessionCookie || !cookieSecret) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not authenticated' }));
        return;
      }

      const payload = validateSessionCookie(sessionCookie, cookieSecret);
      if (!payload) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired session' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user: payload }));
      return;
    }

    // POST /api/auth/logout
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0',
      });
      res.end(JSON.stringify({ ok: true }));
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
          workingDir: (s as any).workingDir || null,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
      return;
    }

    // API: directory history for browser picker
    if (url.pathname === '/api/directories' && req.method === 'GET') {
      const history = dirScanner.getHistory();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ history }));
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
          const offset = parseInt(msg.offset) || 0;
          const dims = session.pty.getScreenDimensions();
          const tmuxId = session.pty.getTmuxId();
          const socketPath = session.pty.getSocketPath();
          const tmuxPrefix = socketPath ? `tmux -S ${socketPath}` : 'tmux';

          // Use tmux capture-pane for scroll — works with alternate screen
          // -p = stdout, -e = include escapes, -S = start line, -E = end line
          // Negative line numbers read from scrollback history
          const startLine = offset > 0 ? -offset : 0;
          const endLine = offset > 0 ? -offset + dims.rows - 1 : dims.rows - 1;
          const captureCmd = `${tmuxPrefix} capture-pane -p -e -t ${tmuxId} -S ${startLine} -E ${endLine}`;

          let capturedLines: string[];
          try {
            const output = execSync(captureCmd, { encoding: 'utf-8', timeout: 5000 });
            capturedLines = output.split('\n');
            // capture-pane adds trailing newline
            if (capturedLines.length > 0 && capturedLines[capturedLines.length - 1] === '') {
              capturedLines.pop();
            }
          } catch (err: any) {
            console.error(`[api] scroll capture-pane failed: ${err.message}`);
            capturedLines = [];
          }

          // Parse ANSI lines into span format
          const lines: any[] = [];
          for (let i = 0; i < dims.rows; i++) {
            if (i < capturedLines.length) {
              lines.push({ spans: parseAnsiLine(capturedLines[i]) });
            } else {
              lines.push({ spans: [] });
            }
          }

          // Get max scrollback for client bounds
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
