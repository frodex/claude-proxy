import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createConnection } from 'net';
import { mkdtempSync, unlinkSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SocketServer } from '../src/socket-server.js';
import { ProxyOperations } from '../src/operations.js';
import { DirScanner } from '../src/dir-scanner.js';
import { serializeMessage, parseMessage } from '../src/socket-protocol.js';
import type { Config } from '../src/types.js';

const TEST_SOCKET = join(tmpdir(), `claude-proxy-test-${process.pid}.sock`);

function request(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ id: number; result?: unknown; error?: { code: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const client = createConnection(TEST_SOCKET, () => {
      const id = Date.now() % 1_000_000_000;
      client.write(serializeMessage({ id, method, params }));
      let buf = '';
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = parseMessage(line) as any;
          if (msg && msg.id === id && ('result' in msg || 'error' in msg)) {
            client.removeListener('data', onData);
            client.end();
            resolve(msg);
            return;
          }
        }
      };
      client.on('data', onData);
    });
    client.on('error', reject);
    setTimeout(() => {
      try {
        client.end();
      } catch { /* ignore */ }
      reject(new Error('timeout'));
    }, 5000);
  });
}

describe('socket-protocol', () => {
  test('serialize + parse roundtrip', () => {
    const msg = { id: 1, method: 'listSessions', params: { user: 'root' } };
    const line = serializeMessage(msg as any).trim();
    expect(parseMessage(line)).toEqual(msg);
  });
});

describe('SocketServer', () => {
  let server: SocketServer;

  beforeAll(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'cp-sock-test-'));
    const historyPath = join(tmp, 'dir-history.json');
    writeFileSync(historyPath, '[]');

    const fakeSessionManager = {
      listSessionsForUser: () => [],
      listSessions: () => [],
      getSession: () => undefined,
      destroySession: () => {},
      createSession: () => {
        throw new Error('not used');
      },
    };

    const config: Config = {
      port: 3100,
      host: '127.0.0.1',
      auth: { authorized_keys: '/dev/null' },
      sessions: { default_user: 'root', scrollback_bytes: 1024, max_sessions: 10 },
      lobby: { motd: '' },
    };

    const dirScanner = new DirScanner({ historyPath });

    const ops = new ProxyOperations(
      fakeSessionManager as any,
      config,
      dirScanner,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    server = new SocketServer({
      socketPath: TEST_SOCKET,
      operations: ops,
      sessionManager: fakeSessionManager as any,
    });
    server.start();
  });

  afterAll(() => {
    try {
      server.stop();
    } catch { /* ignore */ }
    if (existsSync(TEST_SOCKET)) {
      try {
        unlinkSync(TEST_SOCKET);
      } catch { /* ignore */ }
    }
  });

  test('unknown method returns error', async () => {
    const res = await request('nonexistent', {});
    expect(res.error?.code).toBe('METHOD_NOT_FOUND');
  });

  test('listSessions returns array', async () => {
    const res = await request('listSessions', { user: 'root' });
    expect(res.error).toBeUndefined();
    expect(Array.isArray(res.result)).toBe(true);
  });
});
