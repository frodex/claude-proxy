import { test, expect, vi } from 'vitest';
import { Lobby } from '../src/lobby.js';
import type { Session, SessionAccess } from '../src/types.js';

const defaultAccess: SessionAccess = {
  owner: 'greg',
  hidden: false,
  public: true,
  allowedUsers: [],
  allowedGroups: [],
  passwordHash: null,
  viewOnly: false,
};

function makeSession(id: string, name: string, users: string[]): Session {
  const clients = new Map(users.map(u => [u, {
    id: u, username: u, transport: 'ssh' as const,
    termSize: { cols: 80, rows: 24 }, write: vi.fn(), lastKeystroke: Date.now(),
  }]));
  return { id, name, runAsUser: 'root', createdAt: new Date(), sizeOwner: users[0] || '', clients, access: defaultAccess };
}

test('renderScreen shows sessions and commands', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const sessions = [makeSession('1', 'bugfix', ['greg', 'sam']), makeSession('2', 'feature', ['alice'])];
  const output = lobby.renderScreen({ username: 'greg', sessions, cursor: 0, cols: 80, rows: 24 });
  expect(output).toContain('bugfix');
  expect(output).toContain('feature');
  expect(output).toContain('New session');
});

test('renderScreen shows empty state', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const output = lobby.renderScreen({ username: 'greg', sessions: [], cursor: 0, cols: 80, rows: 24 });
  expect(output).toContain('No active sessions');
  expect(output).toContain('New session');
});

test('arrow down navigates', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const sessions = [makeSession('1', 's1', ['greg']), makeSession('2', 's2', ['sam'])];
  const result = lobby.handleInput(Buffer.from('\x1b[B'), sessions, 0);
  expect(result.type).toBe('navigate');
  if (result.type === 'navigate') expect(result.cursor).toBe(1);
});

test('enter selects current item', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const sessions = [makeSession('1', 's1', ['greg'])];
  const result = lobby.handleInput(Buffer.from('\r'), sessions, 0);
  expect(result.type).toBe('select');
  if (result.type === 'select') {
    expect(result.action).toBe('join');
    expect(result.sessionIndex).toBe(0);
  }
});

test('n triggers new', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const result = lobby.handleInput(Buffer.from('n'), [], 0);
  expect(result.type).toBe('select');
  if (result.type === 'select') expect(result.action).toBe('new');
});

test('q triggers quit', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const result = lobby.handleInput(Buffer.from('q'), [], 0);
  expect(result.type).toBe('select');
  if (result.type === 'select') expect(result.action).toBe('quit');
});
