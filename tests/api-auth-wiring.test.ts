/**
 * W1 OAuth wiring spec §10.2 — smoke tests for auth-gated HTTP routes.
 * Uses a minimal live server on an ephemeral port.
 */
import { describe, test, expect, beforeAll, vi } from 'vitest';
import http from 'node:http';
import { startApiServer } from '../src/api-server.js';
import { SessionManager } from '../src/session-manager.js';
import { DirScanner } from '../src/dir-scanner.js';
import type { Config } from '../src/types.js';
import { ProxyOperations } from '../src/operations.js';
import { createSessionCookie } from '../src/auth/session-cookie.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function get(path: string, headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = http.get(path, { headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
  });
}

describe('W1 api auth wiring', () => {
  const secret = 'a'.repeat(32);
  let port: number;
  let base: string;

  beforeAll(async () => {
    const sm = {
      listSessions: vi.fn(() => []),
      listSessionsForUser: vi.fn(() => []),
      getSession: vi.fn(),
      createSession: vi.fn(),
      destroySession: vi.fn(),
    } as unknown as SessionManager;

    const config: Config = {
      port: 3100,
      host: '127.0.0.1',
      auth: { authorized_keys: '/dev/null' },
      sessions: { default_user: 'root', scrollback_bytes: 1024, max_sessions: 10 },
      lobby: { motd: '' },
      remotes: [{ name: 'dev', host: 'dev.example.com' }],
    };

    const dirScanner = new DirScanner({
      historyPath: resolve(__dirname, '../data/dir-history.json'),
    });

    const ops = new ProxyOperations(sm, config, dirScanner);

    const staticDir = resolve(__dirname, '../web');
    await new Promise<void>((resolveListen, rejectListen) => {
      const srv = http.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') {
          rejectListen(new Error('no port'));
          return;
        }
        port = addr.port;
        base = `http://127.0.0.1:${port}`;
        srv.close(() => resolveListen());
      });
    });

    startApiServer({
      port,
      host: '127.0.0.1',
      sessionManager: sm,
      config,
      staticDir,
      dirScanner,
      cookieSecret: secret,
      cookieMaxAge: 3600,
      operations: ops,
    });

    await new Promise((r) => setTimeout(r, 50));
  });

  test('GET /api/remotes without cookie returns 401 when cookieSecret is set', async () => {
    const { status, body } = await get(`${base}/api/remotes`);
    expect(status).toBe(401);
    expect(JSON.parse(body).error).toMatch(/Authentication required/i);
  });

  test('GET /api/directories without cookie returns 401', async () => {
    const { status } = await get(`${base}/api/directories`);
    expect(status).toBe(401);
  });

  test('GET /api/remotes with valid session cookie returns 200', async () => {
    const cookie = createSessionCookie(
      { linuxUser: 'root', displayName: 'Root' },
      secret,
      3600,
    );
    const { status } = await get(`${base}/api/remotes`, {
      Cookie: `session=${cookie}`,
    });
    expect(status).toBe(200);
  });
});
