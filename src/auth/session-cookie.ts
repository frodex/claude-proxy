import { createHmac, timingSafeEqual } from 'crypto';

export interface CookiePayload {
  linuxUser: string;
  displayName: string;
  exp?: number;
}

export function createSessionCookie(
  payload: { linuxUser: string; displayName: string },
  secret: string,
  maxAgeSeconds: number,
): string {
  const data: CookiePayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + maxAgeSeconds,
  };
  const json = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = createHmac('sha256', secret).update(json).digest('base64url');
  return `${json}.${sig}`;
}

export function validateSessionCookie(
  cookie: string,
  secret: string,
): CookiePayload | null {
  const parts = cookie.split('.');
  if (parts.length !== 2) return null;

  const [json, sig] = parts;
  const expectedSig = createHmac('sha256', secret).update(json).digest('base64url');

  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  } catch {
    return null;
  }

  try {
    const payload: CookiePayload = JSON.parse(Buffer.from(json, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
