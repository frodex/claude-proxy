// JSON-RPC–style messages over newline-delimited JSON on a Unix socket.

export interface SocketRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface SocketResponse {
  id: number;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface SocketEvent {
  event: string;
  sessionId?: string;
  data?: unknown;
}

export type SocketMessage = SocketRequest | SocketResponse | SocketEvent;

export function isRequest(msg: unknown): msg is SocketRequest {
  return typeof msg === 'object' && msg !== null && 'method' in msg && 'id' in msg;
}

export function isResponse(msg: unknown): msg is SocketResponse {
  return typeof msg === 'object' && msg !== null && 'id' in msg && !('method' in msg);
}

export function isEvent(msg: unknown): msg is SocketEvent {
  return typeof msg === 'object' && msg !== null && 'event' in msg && !('method' in msg);
}

export function serializeMessage(msg: SocketMessage): string {
  return JSON.stringify(msg) + '\n';
}

export function parseMessage(line: string): SocketMessage | null {
  try {
    return JSON.parse(line.trim()) as SocketMessage;
  } catch {
    return null;
  }
}

/** Methods implemented by SocketServer — aligned with ProxyOperations where applicable */
export const METHODS = [
  'listSessions',
  'createSession',
  'listDeadSessions',
  'destroySession',
  'getSessionSettings',
  'updateSessionSettings',
  'restartSession',
  'forkSession',
  'getSessionScreen',
  'getDirectoryHistory',
  'listUsers',
  'listGroups',
  'listRemotes',
  'startAuth',
  'handleAuthCallback',
  'subscribe',
  'unsubscribe',
  'input',
  'resize',
  'scroll',
] as const;

export type MethodName = (typeof METHODS)[number];
