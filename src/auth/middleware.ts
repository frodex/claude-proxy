import type { IncomingMessage, ServerResponse } from 'http';
import { validateSessionCookie, type CookiePayload } from './session-cookie.js';

export interface AuthenticatedRequest extends IncomingMessage {
  user?: CookiePayload;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  header.split(';').forEach(pair => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  });
  return cookies;
}

export function createAuthMiddleware(secret: string) {
  return function authMiddleware(
    req: AuthenticatedRequest,
    res: ServerResponse,
    next: () => void,
  ): void {
    const cookieHeader = req.headers.cookie || '';
    const cookies = parseCookies(cookieHeader);
    const sessionCookie = cookies['session'];

    if (!sessionCookie) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }

    const payload = validateSessionCookie(sessionCookie, secret);
    if (!payload) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired session' }));
      return;
    }

    req.user = payload;
    next();
  };
}
