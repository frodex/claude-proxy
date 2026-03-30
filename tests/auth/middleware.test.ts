import { test, expect, vi } from 'vitest';
import { createAuthMiddleware } from '../../src/auth/middleware.js';
import { createSessionCookie } from '../../src/auth/session-cookie.js';
import type { IncomingMessage, ServerResponse } from 'http';

const SECRET = 'test-secret-key-at-least-32-bytes!!';

function mockReq(cookie?: string): IncomingMessage {
  return {
    headers: cookie ? { cookie: `session=${cookie}` } : {},
  } as any;
}

function mockRes(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 200,
    body: '',
    writeHead: vi.fn((code: number) => { res.statusCode = code; }),
    end: vi.fn((body: string) => { res.body = body; }),
  } as any;
  return res;
}

test('middleware passes valid cookie', () => {
  const middleware = createAuthMiddleware(SECRET);
  const cookie = createSessionCookie({ linuxUser: 'greg', displayName: 'Greg' }, SECRET, 3600);
  const req = mockReq(cookie);
  const res = mockRes();
  const next = vi.fn();

  middleware(req, res, next);

  expect(next).toHaveBeenCalled();
  expect((req as any).user.linuxUser).toBe('greg');
});

test('middleware rejects missing cookie', () => {
  const middleware = createAuthMiddleware(SECRET);
  const req = mockReq();
  const res = mockRes();
  const next = vi.fn();

  middleware(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
});

test('middleware rejects expired cookie', () => {
  const middleware = createAuthMiddleware(SECRET);
  const cookie = createSessionCookie({ linuxUser: 'greg', displayName: 'Greg' }, SECRET, -1);
  const req = mockReq(cookie);
  const res = mockRes();
  const next = vi.fn();

  middleware(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
});
