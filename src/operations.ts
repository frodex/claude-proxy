// src/operations.ts
// Business logic extracted from HTTP handlers.
// Each method validates input, checks authorization, and returns typed output
// or throws an OperationError.

import { randomBytes } from 'crypto';
import { saveSessionMeta } from './session-store.js';
import type { SessionManager } from './session-manager.js';
import type { Config, Session, SessionAccess } from './types.js';
import type { DirScanner } from './dir-scanner.js';
import type { OAuthManager } from './auth/oauth.js';
import type { GitHubAdapter } from './auth/github-adapter.js';
import type { UserStore, Provisioner } from './auth/types.js';
import type {
  CreateSessionRequest,
  SessionInfo,
  DeadSessionInfo,
  ScreenState,
  OperationError,
  AuthStartResult,
} from './operation-types.js';
import {
  canUserEditSession,
  canUserAccessSession,
  isUserInGroup,
  getClaudeUsers,
  getClaudeGroups,
} from './user-utils.js';
import { listDeadSessions, loadSessionMeta, deleteSessionMeta } from './session-store.js';
import { getProfile, resolveCommand, buildCommandArgs } from './launch-profiles.js';
import { bufferToScreenState, PALETTE_256 } from './screen-renderer.js';

export function composeTitle(session: any): string {
  // SSH/direct PTY clients
  const sshUsers = Array.from(session.clients.values()).map((c: any) => {
    const prefix = c.id === session.sizeOwner ? '*' : '';
    return `${prefix}${c.username}`;
  });

  const owner = (session.access?.owner || 'root').replace(/^cp-/, '');

  const ms = Date.now() - new Date(session.createdAt).getTime();
  const seconds = Math.floor(ms / 1000);
  let uptime: string;
  if (seconds < 60) uptime = `${seconds}s`;
  else if (seconds < 3600) uptime = `${Math.floor(seconds / 60)}m`;
  else {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    uptime = `${h}h${m > 0 ? m + 'm' : ''}`;
  }

  // Show owner, then any SSH clients (deduplicated, owner not repeated)
  const viewers = sshUsers.filter(u => u !== owner && u !== `*${owner}`);
  const viewerStr = viewers.length > 0 ? ' + ' + viewers.join(', ') : '';
  return `${session.name} | ${owner}${viewerStr} | ${uptime}`;
}

export function parseAnsiLine(
  raw: string,
): Array<{
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
}> {
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
          current.fg = `#${codes[c + 2].toString(16).padStart(2, '0')}${codes[c + 3].toString(16).padStart(2, '0')}${codes[c + 4].toString(16).padStart(2, '0')}`;
          c += 4;
        }
        else if (code >= 40 && code <= 47) { current.bg = PALETTE_256[code - 40]; }
        else if (code === 48 && codes[c + 1] === 5) { current.bg = PALETTE_256[codes[c + 2]] ?? undefined; c += 2; }
        else if (code === 48 && codes[c + 1] === 2) {
          current.bg = `#${codes[c + 2].toString(16).padStart(2, '0')}${codes[c + 3].toString(16).padStart(2, '0')}${codes[c + 4].toString(16).padStart(2, '0')}`;
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

export class ProxyOperations {
  constructor(
    private sessionManager: SessionManager,
    private config: Config,
    private dirScanner: DirScanner,
    private oauthManager?: OAuthManager,
    private githubAdapter?: GitHubAdapter,
    private userStore?: UserStore,
    private provisioner?: Provisioner,
  ) {}

  listSessions(username?: string): SessionInfo[] {
    const sessions = username
      ? this.sessionManager.listSessionsForUser(username)
      : this.sessionManager.listSessions();

    return sessions.map(s => this.sessionToInfo(s));
  }

  createSession(req: CreateSessionRequest, username: string): SessionInfo {
    if (!req.name) {
      throw { code: 'BAD_REQUEST', message: 'name is required' } as OperationError;
    }

    if (req.runAsUser && req.runAsUser !== username) {
      const isAdmin = username === 'root' || isUserInGroup(username, 'admins');
      if (!isAdmin) {
        throw { code: 'FORBIDDEN', message: 'Only admins can run sessions as a different user' } as OperationError;
      }
    }

    if (req.dangerousSkipPermissions) {
      const isAdmin = username === 'root' || isUserInGroup(username, 'admins');
      if (!isAdmin) {
        throw { code: 'FORBIDDEN', message: 'Only admins can use dangerousSkipPermissions' } as OperationError;
      }
    }

    const access: Partial<SessionAccess> = {
      hidden: req.hidden ?? false,
      viewOnly: req.viewOnly ?? false,
      viewOnlyAllowScroll: req.viewOnlyAllowScroll ?? true,
      viewOnlyAllowResize: req.viewOnlyAllowResize ?? true,
      public: req.public ?? true,
      allowedUsers: req.allowedUsers ?? [],
      allowedGroups: req.allowedGroups ?? [],
      passwordHash: req.password ?? null,
    };

    const fakeClient = {
      id: 'api-' + Date.now(),
      username,
      transport: 'websocket' as const,
      termSize: { cols: 80, rows: 24 },
      write: () => {},
      lastKeystroke: Date.now(),
    };

    const launchProfile = req.launchProfile ?? 'claude';
    if (!getProfile(launchProfile)) {
      throw { code: 'BAD_REQUEST', message: `Unknown launch profile: ${launchProfile}` } as OperationError;
    }

    const { command } = resolveCommand(launchProfile);
    const commandArgs = buildCommandArgs(launchProfile, {
      isResume: req.isResume,
      claudeSessionId: req.claudeSessionId,
      dangerousSkipPermissions: req.dangerousSkipPermissions,
    });

    const session = this.sessionManager.createSession(
      req.name, fakeClient, req.runAsUser, command, access, commandArgs, req.remoteHost, req.workingDir, launchProfile,
    );

    return this.sessionToInfo(session);
  }

  /**
   * Dead sessions visible to `username`. When `username` is omitted (e.g. internal callers),
   * returns all dead sessions (legacy).
   */
  listDeadSessions(username?: string): DeadSessionInfo[] {
    let dead = listDeadSessions();
    if (username !== undefined) {
      dead = dead.filter(
        d => d.access && canUserAccessSession(username, d.access),
      );
    }
    return dead.map(d => ({
      id: d.tmuxId,
      name: d.name,
      claudeSessionId: d.claudeSessionId ?? null,
      workingDir: d.workingDir ?? null,
      remoteHost: d.remoteHost ?? null,
      launchProfile: d.launchProfile,
    }));
  }

  destroySession(id: string, username: string): void {
    const session = this.sessionManager.getSession(id);
    if (!session) {
      throw { code: 'NOT_FOUND', message: 'Session not found' } as OperationError;
    }
    if (!canUserEditSession(username, session.access)) {
      throw { code: 'FORBIDDEN', message: 'Permission denied' } as OperationError;
    }
    this.sessionManager.destroySession(id);
  }

  getSessionSettings(
    id: string,
    username: string,
  ): { name: string; runAsUser: string; workingDir: string | null; access: SessionAccess } {
    const session = this.sessionManager.getSession(id);
    if (!session) {
      throw { code: 'NOT_FOUND', message: 'Session not found' } as OperationError;
    }
    if (!canUserAccessSession(username, session.access)) {
      throw { code: 'FORBIDDEN', message: 'Permission denied' } as OperationError;
    }
    return {
      name: session.name,
      runAsUser: session.runAsUser,
      workingDir: (session as any).workingDir || null,
      access: session.access,
    };
  }

  updateSessionSettings(id: string, username: string, updates: Record<string, any>): void {
    const session = this.sessionManager.getSession(id);
    if (!session) {
      throw { code: 'NOT_FOUND', message: 'Session not found' } as OperationError;
    }
    if (!canUserEditSession(username, session.access)) {
      throw { code: 'FORBIDDEN', message: 'Permission denied' } as OperationError;
    }
    if (updates.name !== undefined) (session as any).name = updates.name;
    if (updates.hidden !== undefined) session.access.hidden = updates.hidden;
    if (updates.viewOnly !== undefined) session.access.viewOnly = updates.viewOnly;
    if (updates.public !== undefined) session.access.public = updates.public;
    if (updates.allowedUsers !== undefined) session.access.allowedUsers = updates.allowedUsers;
    if (updates.allowedGroups !== undefined) session.access.allowedGroups = updates.allowedGroups;
    if (updates.password !== undefined) session.access.passwordHash = updates.password;
    if (updates.viewOnlyAllowScroll !== undefined) session.access.viewOnlyAllowScroll = updates.viewOnlyAllowScroll;
    if (updates.viewOnlyAllowResize !== undefined) session.access.viewOnlyAllowResize = updates.viewOnlyAllowResize;

    // Persist and notify subscribers of the change
    saveSessionMeta(id, session as any);
    this.sessionManager.emit('session-settings-changed', id, session.access);
  }

  restartSession(id: string, username: string, settings?: Record<string, any>): SessionInfo {
    const dead = listDeadSessions();
    const deadSession = dead.find(d => d.tmuxId === id);
    if (!deadSession) {
      throw { code: 'NOT_FOUND', message: 'Dead session not found' } as OperationError;
    }

    const s = settings || {};
    const access: Partial<SessionAccess> = {
      hidden: s.hidden ?? deadSession.access.hidden,
      viewOnly: s.viewOnly ?? deadSession.access.viewOnly,
      public: s.public ?? deadSession.access.public,
      allowedUsers: s.allowedUsers ?? deadSession.access.allowedUsers,
      allowedGroups: s.allowedGroups ?? deadSession.access.allowedGroups,
      passwordHash: s.password ?? deadSession.access.passwordHash,
    };

    const fakeClient = {
      id: 'api-' + Date.now(),
      username: deadSession.access.owner,
      transport: 'websocket' as const,
      termSize: { cols: 80, rows: 24 },
      write: () => {},
      lastKeystroke: Date.now(),
    };

    const launchProfile = deadSession.launchProfile ?? 'claude';
    if (!getProfile(launchProfile)) {
      throw { code: 'BAD_REQUEST', message: `Unknown launch profile: ${launchProfile}` } as OperationError;
    }

    const { command } = resolveCommand(launchProfile);
    const commandArgs = buildCommandArgs(launchProfile, {
      isResume: true,
      claudeSessionId: deadSession.claudeSessionId ?? undefined,
      dangerousSkipPermissions: s.dangerousSkipPermissions,
    });

    const session = this.sessionManager.createSession(
      s.name ?? deadSession.name,
      fakeClient,
      deadSession.runAsUser,
      command,
      access,
      commandArgs,
      deadSession.remoteHost,
      deadSession.workingDir,
      launchProfile,
    );

    // Same sanitized name reuses tmux id — createSession already overwrote the JSON.
    if (session.id !== id) {
      deleteSessionMeta(id);
    }

    return this.sessionToInfo(session);
  }

  forkSession(id: string, username: string, settings?: Record<string, any>): SessionInfo {
    const sourceSession = this.sessionManager.getSession(id) as any;
    if (!sourceSession) {
      throw { code: 'NOT_FOUND', message: 'Source session not found' } as OperationError;
    }
    if (!canUserAccessSession(username, sourceSession.access)) {
      throw { code: 'FORBIDDEN', message: 'Permission denied' } as OperationError;
    }

    const meta = loadSessionMeta(id);
    const claudeId = meta?.claudeSessionId;
    if (!claudeId) {
      throw { code: 'BAD_REQUEST', message: 'Source session has no Claude session ID to fork from' } as OperationError;
    }

    const s = settings || {};
    const access: Partial<SessionAccess> = {
      hidden: s.hidden ?? sourceSession.access.hidden,
      viewOnly: s.viewOnly ?? sourceSession.access.viewOnly,
      public: s.public ?? sourceSession.access.public,
      allowedUsers: s.allowedUsers ?? sourceSession.access.allowedUsers,
      allowedGroups: s.allowedGroups ?? sourceSession.access.allowedGroups,
      passwordHash: s.password ?? sourceSession.access.passwordHash,
    };

    const fakeClient = {
      id: 'api-' + Date.now(),
      username: sourceSession.access.owner,
      transport: 'websocket' as const,
      termSize: { cols: 80, rows: 24 },
      write: () => {},
      lastKeystroke: Date.now(),
    };

    const args = ['--resume', claudeId, '--fork-session'];

    const forkedSession = this.sessionManager.createSession(
      s.name ?? `${sourceSession.name}-fork`,
      fakeClient,
      sourceSession.runAsUser,
      'claude',
      access,
      args,
      sourceSession.remoteHost,
      sourceSession.workingDir,
      'claude',
    );

    return this.sessionToInfo(forkedSession);
  }

  getSessionScreen(
    id: string,
    username?: string,
    options?: { start?: number; end?: number },
  ): ScreenState {
    const session = this.sessionManager.getSession(id) as any;
    if (!session || !session.pty) {
      throw { code: 'NOT_FOUND', message: 'Session not found' } as OperationError;
    }
    if (username && !canUserAccessSession(username, session.access)) {
      throw { code: 'FORBIDDEN', message: 'Permission denied' } as OperationError;
    }

    const dims = session.pty.getScreenDimensions();
    const title = composeTitle(session);
    const initial = session.pty.getInitialScreen();

    if (initial.source === 'cache' && initial.text) {
      const textLines = initial.text.split('\n');
      const lines: Array<{ spans: any[] }> = [];
      for (let i = 0; i < dims.rows; i++) {
        const raw = textLines[i] || '';
        lines.push({ spans: raw ? parseAnsiLine(raw) : [] });
      }
      return { width: dims.cols, height: dims.rows, cursor: { x: 0, y: 0 }, title, lines };
    }

    const buffer = initial.buffer ?? session.pty.getBuffer();
    const start = options?.start ?? dims.baseY;
    const end = options?.end ?? (dims.baseY + dims.rows);
    return bufferToScreenState(buffer, dims.cols, end - start, title);
  }

  listRemotes(): object[] {
    return this.config.remotes || [];
  }

  listUsers(): string[] {
    return getClaudeUsers();
  }

  listGroups(): Array<{ name: string; systemName: string; members: string[] }> {
    return getClaudeGroups();
  }

  getDirectoryHistory(): string[] {
    return this.dirScanner.getHistory();
  }

  getAuthProviders(): string[] {
    const providers: string[] = [];
    if (this.oauthManager) providers.push(...(this.oauthManager as any).getSupportedProviders());
    if (this.githubAdapter) providers.push('github');
    return providers;
  }

  async startAuth(provider: string): Promise<AuthStartResult> {
    const state = randomBytes(16).toString('hex');

    if (provider === 'github' && this.githubAdapter) {
      const authUrl = this.githubAdapter.getAuthUrl(state);
      return { authUrl, state };
    }
    if (this.oauthManager) {
      const authUrl = await this.oauthManager.getAuthUrl(provider, state);
      return { authUrl, state };
    }

    throw { code: 'BAD_REQUEST', message: `Provider "${provider}" not configured` } as OperationError;
  }

  async handleAuthCallback(
    provider: string,
    code: string,
    callbackUrl: URL,
    state: string,
  ): Promise<{ identity: { linuxUser: string; displayName: string }; isNew: boolean }> {
    let profile: { email: string; displayName: string; providerId: string };

    if (provider === 'github' && this.githubAdapter) {
      profile = await this.githubAdapter.handleCallback(code);
    } else if (this.oauthManager) {
      profile = await this.oauthManager.handleCallback(provider, callbackUrl, state);
    } else {
      throw { code: 'BAD_REQUEST', message: 'Provider not configured' } as OperationError;
    }

    const { resolveUser } = await import('./auth/resolve-user.js');
    const result = resolveUser(
      {
        type: 'oauth' as const,
        provider,
        providerId: profile.providerId,
        email: profile.email,
        displayName: profile.displayName,
      },
      this.userStore!,
      this.provisioner!,
    );

    return {
      identity: {
        linuxUser: result.identity.linuxUser,
        displayName: result.identity.displayName,
      },
      isNew: (result as any).isNew ?? false,
    };
  }

  private sessionToInfo(session: Session): SessionInfo {
    const pty = (session as any).pty;
    const dims = pty?.getScreenDimensions?.() ?? { cols: 80, rows: 24 };
    const meta = loadSessionMeta(session.id);
    return {
      id: session.id,
      name: session.name,
      title: composeTitle(session),
      cols: dims.cols,
      rows: dims.rows,
      clients: session.clients.size,
      owner: session.access?.owner,
      createdAt: session.createdAt.toISOString(),
      workingDir: (session as any).workingDir || null,
      launchProfile: meta?.launchProfile,
      access: {
        owner: session.access.owner,
        hidden: session.access.hidden,
        public: session.access.public,
        viewOnly: session.access.viewOnly,
        viewOnlyAllowScroll: session.access.viewOnlyAllowScroll ?? true,
        viewOnlyAllowResize: session.access.viewOnlyAllowResize ?? true,
        allowedUsers: session.access.allowedUsers,
        allowedGroups: session.access.allowedGroups,
        admins: session.access.admins || [],
        passwordHash: null, // Do NOT expose passwordHash
      },
    };
  }
}
