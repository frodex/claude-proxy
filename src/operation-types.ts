// src/operation-types.ts
import type { SessionAccess } from './types.js';

export interface CreateSessionRequest {
  name: string;
  launchProfile?: string;
  runAsUser?: string;
  workingDir?: string;
  remoteHost?: string;
  hidden?: boolean;
  viewOnly?: boolean;
  viewOnlyAllowScroll?: boolean;
  viewOnlyAllowResize?: boolean;
  public?: boolean;
  allowedUsers?: string[];
  allowedGroups?: string[];
  password?: string;
  dangerousSkipPermissions?: boolean;
  claudeSessionId?: string;
  isResume?: boolean;
}

export interface SessionInfo {
  id: string;
  name: string;
  title: string;
  cols: number;
  rows: number;
  clients: number;
  owner: string;
  createdAt: string;
  workingDir: string | null;
  launchProfile?: string;
  access?: SessionAccess;
}

export interface DeadSessionInfo {
  id: string;
  name: string;
  claudeSessionId: string | null;
  workingDir: string | null;
  remoteHost: string | null;
  launchProfile?: string;
}

export interface ScreenState {
  width: number;
  height: number;
  cursor: { x: number; y: number };
  title: string;
  lines: Array<{ spans: any[] }>;
}

export interface AuthStartResult {
  authUrl: string;
  state: string;
}

export interface AuthExchangeResult {
  identity: { linuxUser: string; displayName: string; email?: string };
  token: string;
  isNew: boolean;
}

export interface OperationError {
  code: 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_REQUEST' | 'UNAUTHORIZED' | 'CONFLICT' | 'INTERNAL';
  message: string;
}
