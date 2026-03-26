import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { PtyMultiplexer } from '../src/pty-multiplexer.js';
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

test('broadcasts output to all attached clients', async () => {
  const mux = new PtyMultiplexer({
    command: 'echo',
    args: ['hello'],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
  });

  const c1 = makeClient('c1');
  const c2 = makeClient('c2');
  mux.attach(c1);
  mux.attach(c2);

  // Wait for echo to produce output and exit
  await new Promise(r => setTimeout(r, 500));

  expect(c1.written.length).toBeGreaterThan(0);
  expect(c2.written.length).toBeGreaterThan(0);
  const c1out = Buffer.concat(c1.written).toString();
  const c2out = Buffer.concat(c2.written).toString();
  expect(c1out).toContain('hello');
  expect(c2out).toContain('hello');

  mux.destroy();
});

test('scrollback buffer replays to late joiners', async () => {
  const mux = new PtyMultiplexer({
    command: 'echo',
    args: ['scrollback-test'],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
  });

  // Wait for echo to produce output
  await new Promise(r => setTimeout(r, 500));

  // Late joiner
  const late = makeClient('late');
  mux.attach(late);

  const output = Buffer.concat(late.written).toString();
  expect(output).toContain('scrollback-test');

  mux.destroy();
});

test('detach stops sending output to client', async () => {
  const mux = new PtyMultiplexer({
    command: 'cat',  // stays open, echoes input
    args: [],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
  });

  const c1 = makeClient('c1');
  mux.attach(c1);

  await new Promise(r => setTimeout(r, 100));
  const countBefore = c1.written.length;

  mux.detach(c1);
  mux.write(Buffer.from('after-detach\n'));

  await new Promise(r => setTimeout(r, 200));
  expect(c1.written.length).toBe(countBefore);

  mux.destroy();
});

test('resize changes PTY dimensions', () => {
  const mux = new PtyMultiplexer({
    command: 'cat',
    args: [],
    cols: 80,
    rows: 24,
    scrollbackBytes: 4096,
  });

  // Should not throw
  mux.resize(120, 40);

  mux.destroy();
});

test('onExit fires when process exits', async () => {
  const exitPromise = new Promise<number>(resolve => {
    const mux = new PtyMultiplexer({
      command: 'true',  // exits immediately with 0
      args: [],
      cols: 80,
      rows: 24,
      scrollbackBytes: 4096,
      onExit: (code) => resolve(code),
    });
  });

  const code = await exitPromise;
  expect(code).toBe(0);
});
