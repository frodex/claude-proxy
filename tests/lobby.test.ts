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

test('renderScreen shows compact main menu (sessions not listed here)', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const sessions = [makeSession('1', 'bugfix', ['greg', 'sam']), makeSession('2', 'feature', ['alice'])];
  const output = lobby.renderScreen({ username: 'greg', sessions, cursor: 0, cols: 80, rows: 24 });
  expect(output).not.toContain('bugfix');
  expect(output).not.toContain('feature');
  expect(output).toContain('Join a running session');
  expect(output).toContain('New session');
});

test('renderScreen empty sessions still shows main menu', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const output = lobby.renderScreen({ username: 'greg', sessions: [], cursor: 0, cols: 80, rows: 24 });
  expect(output).toContain('Join a running session');
  expect(output).toContain('[n]');
});

test('arrow down navigates main menu', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const sessions = [makeSession('1', 's1', ['greg'])];
  const result = lobby.handleInput(Buffer.from('\x1b[B'), sessions, 0);
  expect(result.type).toBe('navigate');
  if (result.type === 'navigate') expect(result.cursor).toBe(1);
});

test('enter on first row selects join_menu', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const sessions = [makeSession('1', 's1', ['greg'])];
  const result = lobby.handleInput(Buffer.from('\r'), sessions, 0);
  expect(result.type).toBe('select');
  if (result.type === 'select') {
    expect(result.action).toBe('join_menu');
  }
});

test('n shortcut selects new_menu', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const result = lobby.handleInput(Buffer.from('n'), [], 0);
  expect(result.type).toBe('select');
  if (result.type === 'select') expect(result.action).toBe('new_menu');
});

test('j shortcut selects join_menu', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const result = lobby.handleInput(Buffer.from('j'), [], 2);
  expect(result.type).toBe('select');
  if (result.type === 'select') expect(result.action).toBe('join_menu');
});

test('q triggers quit', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const result = lobby.handleInput(Buffer.from('q'), [], 0);
  expect(result.type).toBe('select');
  if (result.type === 'select') expect(result.action).toBe('quit');
});
