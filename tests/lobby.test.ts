import { test, expect, vi } from 'vitest';
import { Lobby } from '../src/lobby.js';
import type { Session } from '../src/types.js';

test('renderScreen shows MOTD and session list', () => {
  const lobby = new Lobby({ motd: 'Welcome to droidware' });

  const sessions: Session[] = [
    {
      id: '1',
      name: 'bugfix-auth',
      runAsUser: 'root',
      createdAt: new Date(),
      sizeOwner: 'greg',
      clients: new Map([['greg', { id: 'greg', username: 'greg', transport: 'ssh' as const, termSize: { cols: 80, rows: 24 }, write: vi.fn(), lastKeystroke: Date.now() }], ['sam', { id: 'sam', username: 'sam', transport: 'ssh' as const, termSize: { cols: 80, rows: 24 }, write: vi.fn(), lastKeystroke: Date.now() }]]),
    },
    {
      id: '2',
      name: 'feature-api',
      runAsUser: 'root',
      createdAt: new Date(),
      sizeOwner: 'alice',
      clients: new Map([['alice', { id: 'alice', username: 'alice', transport: 'ssh' as const, termSize: { cols: 80, rows: 24 }, write: vi.fn(), lastKeystroke: Date.now() }]]),
    },
  ];

  const output = lobby.renderScreen({
    username: 'greg',
    sessions,
    selectedIndex: 0,
    cols: 60,
    rows: 24,
  });

  expect(output).toContain('Welcome to droidware');
  expect(output).toContain('greg');
  expect(output).toContain('bugfix-auth');
  expect(output).toContain('feature-api');
  expect(output).toContain('2 users');
  expect(output).toContain('1 user');
});

test('renderScreen shows empty state when no sessions', () => {
  const lobby = new Lobby({ motd: 'Welcome' });

  const output = lobby.renderScreen({
    username: 'greg',
    sessions: [],
    selectedIndex: 0,
    cols: 60,
    rows: 24,
  });

  expect(output).toContain('No active sessions');
  expect(output).toContain('[n]');
});

test('handleInput moves selection down', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const state = { selectedIndex: 0, sessionCount: 3 };

  const result = lobby.handleInput(Buffer.from('\x1b[B'), state);
  expect(result.type).toBe('navigate');
  expect(result.selectedIndex).toBe(1);
});

test('handleInput moves selection up', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const state = { selectedIndex: 2, sessionCount: 3 };

  const result = lobby.handleInput(Buffer.from('\x1b[A'), state);
  expect(result.type).toBe('navigate');
  expect(result.selectedIndex).toBe(1);
});

test('handleInput enter selects session', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const state = { selectedIndex: 1, sessionCount: 3 };

  const result = lobby.handleInput(Buffer.from('\r'), state);
  expect(result.type).toBe('join');
  expect(result.selectedIndex).toBe(1);
});

test('handleInput n triggers new session', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const state = { selectedIndex: 0, sessionCount: 2 };

  const result = lobby.handleInput(Buffer.from('n'), state);
  expect(result.type).toBe('new');
});

test('handleInput q triggers quit', () => {
  const lobby = new Lobby({ motd: 'Welcome' });
  const state = { selectedIndex: 0, sessionCount: 2 };

  const result = lobby.handleInput(Buffer.from('q'), state);
  expect(result.type).toBe('quit');
});

test('handleInput wraps selection at boundaries', () => {
  const lobby = new Lobby({ motd: 'Welcome' });

  const down = lobby.handleInput(Buffer.from('\x1b[B'), { selectedIndex: 2, sessionCount: 3 });
  expect(down.selectedIndex).toBe(0);

  const up = lobby.handleInput(Buffer.from('\x1b[A'), { selectedIndex: 0, sessionCount: 3 });
  expect(up.selectedIndex).toBe(2);
});
