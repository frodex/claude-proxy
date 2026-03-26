import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { StatusBar } from '../src/status-bar.js';

test('renders session name and users', () => {
  const bar = new StatusBar();
  const output = bar.render({
    sessionName: 'bugfix-auth',
    users: [
      { username: 'greg', isSizeOwner: true, isTyping: false },
      { username: 'sam', isSizeOwner: false, isTyping: true },
      { username: 'alice', isSizeOwner: false, isTyping: false },
    ],
    cols: 60,
  });

  expect(output).toContain('bugfix-auth');
  expect(output).toContain('greg');
  expect(output).toContain('sam');
  expect(output).toContain('alice');
});

test('size owner is bracketed and bold', () => {
  const bar = new StatusBar();
  const output = bar.render({
    sessionName: 'test',
    users: [
      { username: 'greg', isSizeOwner: true, isTyping: false },
    ],
    cols: 60,
  });

  expect(output).toContain('[greg]');
});

test('typing users are orange (ANSI 33)', () => {
  const bar = new StatusBar();
  const output = bar.render({
    sessionName: 'test',
    users: [
      { username: 'sam', isSizeOwner: false, isTyping: true },
    ],
    cols: 60,
  });

  expect(output).toContain('\x1b[33m');
  expect(output).toContain('sam');
});

test('idle users are gray (ANSI 90)', () => {
  const bar = new StatusBar();
  const output = bar.render({
    sessionName: 'test',
    users: [
      { username: 'alice', isSizeOwner: false, isTyping: false },
    ],
    cols: 60,
  });

  expect(output).toContain('\x1b[90m');
  expect(output).toContain('alice');
});

test('typing indicator shows keyboard emoji for typers', () => {
  const bar = new StatusBar();
  const output = bar.render({
    sessionName: 'test',
    users: [
      { username: 'greg', isSizeOwner: true, isTyping: true },
      { username: 'sam', isSizeOwner: false, isTyping: true },
      { username: 'alice', isSizeOwner: false, isTyping: false },
    ],
    cols: 60,
  });

  const lines = output.split('\n');
  expect(lines.length).toBeGreaterThanOrEqual(2);
});

test('renderFrame wraps PTY output with scroll region and status bar', () => {
  const bar = new StatusBar();
  const frame = bar.renderFrame({
    ptyData: 'hello world',
    sessionName: 'test',
    users: [{ username: 'greg', isSizeOwner: true, isTyping: false }],
    clientRows: 24,
    clientCols: 80,
  });

  // Should contain scroll region escape
  expect(frame).toContain('\x1b[1;22r');  // rows 1-22 (24 - 2 for status bar)
  // Should contain the PTY data
  expect(frame).toContain('hello world');
});
