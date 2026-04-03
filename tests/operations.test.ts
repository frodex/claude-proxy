import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ProxyOperations, composeTitle, parseAnsiLine } from '../src/operations.js';
import type { Session, SessionAccess, Config } from '../src/types.js';
import type { OperationError } from '../src/operation-types.js';

vi.mock('../src/user-utils.js', () => ({
  canUserEditSession: vi.fn(() => true),
  canUserAccessSession: vi.fn(() => true),
  isUserInGroup: vi.fn(() => false),
  getClaudeUsers: vi.fn(() => ['root', 'alice', 'bob']),
  getClaudeGroups: vi.fn(() => [{ name: 'admins', systemName: 'cp-admins', members: ['root'] }]),
}));

vi.mock('../src/session-store.js', () => ({
  listDeadSessions: vi.fn(() => []),
  loadSessionMeta: vi.fn(() => null),
}));

vi.mock('../src/screen-renderer.js', () => ({
  bufferToScreenState: vi.fn(() => ({
    width: 80,
    height: 24,
    cursor: { x: 0, y: 0 },
    title: 'test',
    lines: [],
  })),
  PALETTE_256: Array.from({ length: 256 }, (_, i) => `#${i.toString(16).padStart(6, '0')}`),
}));

import { canUserEditSession, canUserAccessSession, isUserInGroup } from '../src/user-utils.js';
import { listDeadSessions, loadSessionMeta } from '../src/session-store.js';
import { bufferToScreenState } from '../src/screen-renderer.js';

function mockSessionManager() {
  return {
    listSessions: vi.fn(() => []),
    listSessionsForUser: vi.fn(() => []),
    getSession: vi.fn(),
    createSession: vi.fn(),
    destroySession: vi.fn(),
  };
}

function makeAccess(overrides: Partial<SessionAccess> = {}): SessionAccess {
  return {
    owner: 'root',
    hidden: false,
    public: true,
    allowedUsers: [],
    allowedGroups: [],
    passwordHash: null,
    viewOnly: false,
    admins: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> & { pty?: any } = {}): Session & { pty: any } {
  return {
    id: 'cp-test',
    name: 'test',
    runAsUser: 'root',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    sizeOwner: 'client-1',
    clients: new Map(),
    access: makeAccess(),
    pty: {
      getScreenDimensions: vi.fn(() => ({ cols: 80, rows: 24, baseY: 0, cursorX: 0, cursorY: 0 })),
      getBuffer: vi.fn(() => ({})),
      getInitialScreen: vi.fn(() => ({ source: 'vterm', buffer: {} })),
    },
    ...overrides,
  } as any;
}

function makeConfig(): Config {
  return {
    port: 2222,
    host: '0.0.0.0',
    auth: { authorized_keys: '' },
    sessions: { default_user: 'root', scrollback_bytes: 4096, max_sessions: 10 },
    lobby: { motd: '' },
    remotes: [{ name: 'dev', host: 'dev.example.com' }],
  };
}

function makeDirScanner() {
  return { getHistory: vi.fn(() => ['/home/user/project', '/srv/app']) };
}

describe('composeTitle', () => {
  test('formats title with session name, users, and uptime', () => {
    const session = makeSession({ name: 'my-session' });
    const title = composeTitle(session);
    expect(title).toContain('my-session');
    expect(title).toContain('no users');
  });

  test('includes connected user names', () => {
    const clients = new Map([
      ['c1', { id: 'c1', username: 'alice' }],
      ['c2', { id: 'c2', username: 'bob' }],
    ]);
    const session = makeSession({ name: 'shared', clients: clients as any, sizeOwner: 'c1' });
    const title = composeTitle(session);
    expect(title).toContain('*alice');
    expect(title).toContain('bob');
  });
});

describe('parseAnsiLine', () => {
  test('parses plain text', () => {
    const spans = parseAnsiLine('hello world');
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('hello world');
  });

  test('parses bold ANSI', () => {
    const spans = parseAnsiLine('\x1b[1mBOLD\x1b[0m normal');
    expect(spans.length).toBeGreaterThanOrEqual(1);
    const boldSpan = spans.find((s: any) => s.bold);
    expect(boldSpan?.text).toBe('BOLD');
  });

  test('returns empty array for empty string', () => {
    expect(parseAnsiLine('')).toEqual([]);
  });
});

describe('ProxyOperations', () => {
  let sm: ReturnType<typeof mockSessionManager>;
  let ops: ProxyOperations;

  beforeEach(() => {
    sm = mockSessionManager();
    ops = new ProxyOperations(sm as any, makeConfig(), makeDirScanner() as any);
    vi.clearAllMocks();

    vi.mocked(canUserEditSession).mockReturnValue(true);
    vi.mocked(canUserAccessSession).mockReturnValue(true);
    vi.mocked(isUserInGroup).mockReturnValue(false);
  });

  describe('listSessions', () => {
    test('maps session data to SessionInfo[]', () => {
      const session = makeSession({ id: 'cp-demo', name: 'demo' });
      sm.listSessions.mockReturnValue([session]);

      const result = ops.listSessions();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('cp-demo');
      expect(result[0].name).toBe('demo');
      expect(result[0].cols).toBe(80);
      expect(result[0].rows).toBe(24);
      expect(result[0].clients).toBe(0);
      expect(result[0].owner).toBe('root');
      expect(result[0].createdAt).toBe('2025-01-01T00:00:00.000Z');
      expect(result[0].workingDir).toBeNull();
    });

    test('filters by user when username provided', () => {
      sm.listSessionsForUser.mockReturnValue([]);
      ops.listSessions('alice');
      expect(sm.listSessionsForUser).toHaveBeenCalledWith('alice');
      expect(sm.listSessions).not.toHaveBeenCalled();
    });
  });

  describe('createSession', () => {
    test('creates session with valid input', () => {
      const created = makeSession({ id: 'cp-new', name: 'new' });
      sm.createSession.mockReturnValue(created);

      const result = ops.createSession({ name: 'new' }, 'root');
      expect(result.id).toBe('cp-new');
      expect(result.name).toBe('new');
      expect(sm.createSession).toHaveBeenCalledTimes(1);
    });

    test('rejects missing name', () => {
      try {
        ops.createSession({ name: '' }, 'root');
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('BAD_REQUEST');
      }
    });

    test('rejects non-admin setting runAsUser to different user', () => {
      vi.mocked(isUserInGroup).mockReturnValue(false);

      try {
        ops.createSession({ name: 'test', runAsUser: 'bob' }, 'alice');
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('FORBIDDEN');
        expect(err.message).toContain('admins');
      }
    });

    test('allows root to set runAsUser', () => {
      const created = makeSession({ id: 'cp-root', name: 'root-session' });
      sm.createSession.mockReturnValue(created);

      const result = ops.createSession({ name: 'root-session', runAsUser: 'bob' }, 'root');
      expect(result.id).toBe('cp-root');
    });

    test('allows admin group member to set runAsUser', () => {
      vi.mocked(isUserInGroup).mockReturnValue(true);
      const created = makeSession({ id: 'cp-admin', name: 'admin-session' });
      sm.createSession.mockReturnValue(created);

      const result = ops.createSession({ name: 'admin-session', runAsUser: 'bob' }, 'alice');
      expect(result.id).toBe('cp-admin');
    });

    test('rejects dangerousSkipPermissions from non-admin', () => {
      vi.mocked(isUserInGroup).mockReturnValue(false);

      try {
        ops.createSession({ name: 'test', dangerousSkipPermissions: true }, 'alice');
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('FORBIDDEN');
        expect(err.message).toContain('dangerousSkipPermissions');
      }
    });

    test('passes dangerousSkipPermissions flag as CLI arg', () => {
      const created = makeSession({ id: 'cp-danger', name: 'danger' });
      sm.createSession.mockReturnValue(created);

      ops.createSession({ name: 'danger', dangerousSkipPermissions: true }, 'root');
      const callArgs = sm.createSession.mock.calls[0];
      expect(callArgs[5]).toContain('--dangerously-skip-permissions');
    });

    test('sets fakeClient username to authenticated user', () => {
      const created = makeSession({ id: 'cp-test', name: 'test' });
      sm.createSession.mockReturnValue(created);

      ops.createSession({ name: 'test' }, 'alice');
      const fakeClient = sm.createSession.mock.calls[0][1];
      expect(fakeClient.username).toBe('alice');
    });
  });

  describe('destroySession', () => {
    test('destroys existing session when user has permission', () => {
      const session = makeSession({ id: 'cp-kill', access: makeAccess({ owner: 'alice' }) });
      sm.getSession.mockReturnValue(session);
      vi.mocked(canUserEditSession).mockReturnValue(true);

      ops.destroySession('cp-kill', 'alice');
      expect(sm.destroySession).toHaveBeenCalledWith('cp-kill');
    });

    test('throws NOT_FOUND for missing session', () => {
      sm.getSession.mockReturnValue(undefined);

      try {
        ops.destroySession('cp-missing', 'root');
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('NOT_FOUND');
      }
    });

    test('requires edit permission', () => {
      const session = makeSession({ id: 'cp-owned', access: makeAccess({ owner: 'alice' }) });
      sm.getSession.mockReturnValue(session);
      vi.mocked(canUserEditSession).mockReturnValue(false);

      try {
        ops.destroySession('cp-owned', 'bob');
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('FORBIDDEN');
      }
    });
  });

  describe('getSessionSettings', () => {
    test('returns session settings', () => {
      const session = makeSession({
        name: 'configured',
        runAsUser: 'deploy',
        workingDir: '/srv/app',
        access: makeAccess({ owner: 'alice', hidden: true }),
      });
      sm.getSession.mockReturnValue(session);

      const result = ops.getSessionSettings('cp-test', 'alice');
      expect(result.name).toBe('configured');
      expect(result.runAsUser).toBe('deploy');
      expect(result.workingDir).toBe('/srv/app');
      expect(result.access.hidden).toBe(true);
    });

    test('throws NOT_FOUND for missing session', () => {
      sm.getSession.mockReturnValue(undefined);
      try {
        ops.getSessionSettings('missing', 'root');
        expect.fail('should throw');
      } catch (err: any) {
        expect(err.code).toBe('NOT_FOUND');
      }
    });

    test('requires access permission', () => {
      sm.getSession.mockReturnValue(makeSession());
      vi.mocked(canUserAccessSession).mockReturnValue(false);

      try {
        ops.getSessionSettings('cp-test', 'eve');
        expect.fail('should throw');
      } catch (err: any) {
        expect(err.code).toBe('FORBIDDEN');
      }
    });
  });

  describe('updateSessionSettings', () => {
    test('updates allowed fields', () => {
      const session = makeSession({ name: 'original' });
      sm.getSession.mockReturnValue(session);

      ops.updateSessionSettings('cp-test', 'root', { name: 'renamed', hidden: true });
      expect(session.name).toBe('renamed');
      expect(session.access.hidden).toBe(true);
    });

    test('requires edit permission', () => {
      sm.getSession.mockReturnValue(makeSession());
      vi.mocked(canUserEditSession).mockReturnValue(false);

      try {
        ops.updateSessionSettings('cp-test', 'eve', { name: 'hacked' });
        expect.fail('should throw');
      } catch (err: any) {
        expect(err.code).toBe('FORBIDDEN');
      }
    });
  });

  describe('getSessionScreen', () => {
    test('returns screen state from vterm path', () => {
      const session = makeSession();
      sm.getSession.mockReturnValue(session);

      const result = ops.getSessionScreen('cp-test');
      expect(result).toHaveProperty('width');
      expect(result).toHaveProperty('height');
      expect(result).toHaveProperty('cursor');
      expect(result).toHaveProperty('title');
      expect(vi.mocked(bufferToScreenState)).toHaveBeenCalled();
    });

    test('returns screen state from cache path', () => {
      const session = makeSession();
      session.pty.getInitialScreen.mockReturnValue({
        source: 'cache',
        text: 'line 1\nline 2\nline 3',
      });
      sm.getSession.mockReturnValue(session);

      const result = ops.getSessionScreen('cp-test');
      expect(result.width).toBe(80);
      expect(result.height).toBe(24);
      expect(result.lines).toHaveLength(24);
    });

    test('throws NOT_FOUND for missing session', () => {
      sm.getSession.mockReturnValue(undefined);

      try {
        ops.getSessionScreen('missing');
        expect.fail('should throw');
      } catch (err: any) {
        expect(err.code).toBe('NOT_FOUND');
      }
    });

    test('checks access when username provided', () => {
      sm.getSession.mockReturnValue(makeSession());
      vi.mocked(canUserAccessSession).mockReturnValue(false);

      try {
        ops.getSessionScreen('cp-test', 'eve');
        expect.fail('should throw');
      } catch (err: any) {
        expect(err.code).toBe('FORBIDDEN');
      }
    });

    test('skips access check when no username', () => {
      sm.getSession.mockReturnValue(makeSession());
      vi.mocked(canUserAccessSession).mockReturnValue(false);

      const result = ops.getSessionScreen('cp-test');
      expect(result).toBeDefined();
      expect(vi.mocked(canUserAccessSession)).not.toHaveBeenCalled();
    });
  });

  describe('listDeadSessions', () => {
    test('maps dead session data to DeadSessionInfo[]', () => {
      vi.mocked(listDeadSessions).mockReturnValue([
        {
          tmuxId: 'cp-old',
          name: 'old',
          runAsUser: 'root',
          createdAt: '2025-01-01T00:00:00Z',
          access: makeAccess(),
          claudeSessionId: 'abc-123',
          workingDir: '/srv/app',
          remoteHost: undefined,
        },
      ] as any);

      const result = ops.listDeadSessions();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('cp-old');
      expect(result[0].name).toBe('old');
      expect(result[0].claudeSessionId).toBe('abc-123');
      expect(result[0].workingDir).toBe('/srv/app');
      expect(result[0].remoteHost).toBeNull();
    });
  });

  describe('forkSession', () => {
    test('throws NOT_FOUND when source session missing', () => {
      sm.getSession.mockReturnValue(undefined);
      try {
        ops.forkSession('missing', 'root');
        expect.fail('should throw');
      } catch (err: any) {
        expect(err.code).toBe('NOT_FOUND');
      }
    });

    test('throws FORBIDDEN when user lacks access', () => {
      sm.getSession.mockReturnValue(makeSession());
      vi.mocked(canUserAccessSession).mockReturnValue(false);

      try {
        ops.forkSession('cp-test', 'eve');
        expect.fail('should throw');
      } catch (err: any) {
        expect(err.code).toBe('FORBIDDEN');
      }
    });

    test('throws BAD_REQUEST when no claude session ID', () => {
      sm.getSession.mockReturnValue(makeSession());
      vi.mocked(loadSessionMeta).mockReturnValue(null);

      try {
        ops.forkSession('cp-test', 'root');
        expect.fail('should throw');
      } catch (err: any) {
        expect(err.code).toBe('BAD_REQUEST');
        expect(err.message).toContain('Claude session ID');
      }
    });

    test('creates forked session with resume args', () => {
      sm.getSession.mockReturnValue(makeSession({ name: 'source' }));
      vi.mocked(loadSessionMeta).mockReturnValue({
        tmuxId: 'cp-test', name: 'source', runAsUser: 'root',
        createdAt: '2025-01-01', access: makeAccess(),
        claudeSessionId: 'claude-uuid-123',
      } as any);
      const forked = makeSession({ id: 'cp-source-fork', name: 'source-fork' });
      sm.createSession.mockReturnValue(forked);

      const result = ops.forkSession('cp-test', 'root');
      expect(result.id).toBe('cp-source-fork');
      const callArgs = sm.createSession.mock.calls[0];
      expect(callArgs[5]).toEqual(['--resume', 'claude-uuid-123', '--fork-session']);
    });
  });

  describe('simple getters', () => {
    test('listRemotes returns configured remotes', () => {
      expect(ops.listRemotes()).toEqual([{ name: 'dev', host: 'dev.example.com' }]);
    });

    test('listUsers returns claude users', () => {
      const result = ops.listUsers();
      expect(result).toEqual(['root', 'alice', 'bob']);
    });

    test('listGroups returns claude groups', () => {
      const result = ops.listGroups();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('admins');
    });

    test('getDirectoryHistory returns scanner history', () => {
      const result = ops.getDirectoryHistory();
      expect(result).toEqual(['/home/user/project', '/srv/app']);
    });

    test('getAuthProviders returns empty when no auth configured', () => {
      expect(ops.getAuthProviders()).toEqual([]);
    });

    test('getAuthProviders includes github when adapter present', () => {
      const opsWithGh = new ProxyOperations(
        sm as any, makeConfig(), makeDirScanner() as any,
        undefined, { getAuthUrl: vi.fn() } as any,
      );
      expect(opsWithGh.getAuthProviders()).toEqual(['github']);
    });
  });
});
