import { test, expect, afterEach } from 'vitest';
import { PtyMultiplexer } from '../src/pty-multiplexer.js';
import { execSync } from 'child_process';
import type { Client } from '../src/types.js';

function makeClient(id: string, cols = 120, rows = 40): Client & { written: Buffer[] } {
  const written: Buffer[] = [];
  return {
    id,
    username: id,
    transport: 'ssh' as const,
    termSize: { cols, rows },
    write: (data: Buffer | string) => written.push(Buffer.isBuffer(data) ? data : Buffer.from(data)),
    lastKeystroke: Date.now(),
    written,
  };
}

let testCounter = 0;
function uniqueTmuxId(): string {
  return `cp-test-${Date.now()}-${testCounter++}`;
}

function cleanupTmux(id: string): void {
  try { execSync(`tmux kill-session -t ${id} 2>/dev/null`); } catch {}
}

test('broadcasts output to all attached clients', async () => {
  const tmuxId = uniqueTmuxId();
  const mux = new PtyMultiplexer({
    command: 'echo',
    args: ['hello'],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
    tmuxSessionId: tmuxId,
  });

  const c1 = makeClient('c1');
  const c2 = makeClient('c2');
  mux.attach(c1);
  mux.attach(c2);

  await new Promise(r => setTimeout(r, 1000));

  expect(c1.written.length).toBeGreaterThan(0);
  expect(c2.written.length).toBeGreaterThan(0);

  mux.destroy();
});

test('scrollback buffer replays to late joiners', async () => {
  const tmuxId = uniqueTmuxId();
  const mux = new PtyMultiplexer({
    command: 'echo',
    args: ['scrollback-test'],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
    tmuxSessionId: tmuxId,
  });

  await new Promise(r => setTimeout(r, 1000));

  const late = makeClient('late');
  mux.attach(late);

  expect(late.written.length).toBeGreaterThan(0);

  mux.destroy();
});

test('detach stops sending output to client', async () => {
  const tmuxId = uniqueTmuxId();
  const mux = new PtyMultiplexer({
    command: 'bash',
    args: ['-c', 'while true; do echo tick; sleep 0.1; done'],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
    tmuxSessionId: tmuxId,
  });

  const c1 = makeClient('c1');
  mux.attach(c1);

  await new Promise(r => setTimeout(r, 500));
  const countBefore = c1.written.length;
  expect(countBefore).toBeGreaterThan(0);

  mux.detach(c1);
  await new Promise(r => setTimeout(r, 500));

  // Should not have received much more after detach
  expect(c1.written.length).toBe(countBefore);

  mux.destroy();
});

test('launches tmux session with working directory', async () => {
  const tmuxId = uniqueTmuxId();
  const testDir = '/tmp';
  const mux = new PtyMultiplexer({
    command: 'bash',
    args: ['-c', 'pwd && sleep 10'],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
    tmuxSessionId: tmuxId,
    workingDir: testDir,
  });

  const c1 = makeClient('c1');
  mux.attach(c1);

  await new Promise(r => setTimeout(r, 1500));

  const output = Buffer.concat(c1.written).toString();
  expect(output).toContain('/tmp');

  mux.destroy();
});

test('listTmuxSessions finds cp- prefixed sessions', async () => {
  const tmuxId = uniqueTmuxId();
  const mux = new PtyMultiplexer({
    command: 'cat',
    args: [],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
    tmuxSessionId: tmuxId,
  });

  await new Promise(r => setTimeout(r, 1000));

  const sessions = PtyMultiplexer.listTmuxSessions();
  const found = sessions.find(s => s.tmuxId === tmuxId);
  expect(found).toBeDefined();

  mux.destroy();
});
