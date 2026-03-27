import { test, expect, vi, afterEach } from 'vitest';
import { SessionManager } from '../src/session-manager.js';
import type { Client } from '../src/types.js';

let testCounter = 0;
function uniqueName(base: string): string {
  return `${base}-${Date.now()}-${testCounter++}`;
}

function makeClient(id: string): Client {
  return {
    id,
    username: id,
    transport: 'ssh' as const,
    termSize: { cols: 120, rows: 40 },
    write: vi.fn(),
    lastKeystroke: Date.now(),
  };
}

let manager: SessionManager;

afterEach(() => {
  manager?.destroyAll();
});

test('creates a session and lists it', () => {
  manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 10,
  });

  const name = uniqueName('test-session');
  const client = makeClient('greg');
  const session = manager.createSession(name, client, undefined, 'cat');

  expect(session.name).toBe(name);
  expect(session.id).toBeTruthy();

  const list = manager.listSessions();
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe(name);
  expect(list[0].clients.size).toBe(1);
});

test('join adds client to existing session', () => {
  manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 10,
  });

  const greg = makeClient('greg');
  const session = manager.createSession(uniqueName('shared'), greg, undefined, 'cat');

  const sam = makeClient('sam');
  manager.joinSession(session.id, sam);

  const updated = manager.getSession(session.id);
  expect(updated?.clients.size).toBe(2);
});

test('leave removes client but keeps session alive', () => {
  manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 10,
  });

  const greg = makeClient('greg');
  const sam = makeClient('sam');
  const session = manager.createSession(uniqueName('shared'), greg, undefined, 'cat');
  manager.joinSession(session.id, sam);

  manager.leaveSession(session.id, greg);

  const updated = manager.getSession(session.id);
  expect(updated?.clients.size).toBe(1);
  expect(updated?.clients.has('sam')).toBe(true);
});

test('size owner defaults to session creator', () => {
  manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 10,
  });

  const greg = makeClient('greg');
  const session = manager.createSession(uniqueName('test'), greg, undefined, 'cat');

  expect(session.sizeOwner).toBe('greg');
});

test('claimSizeOwner transfers ownership', () => {
  manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 10,
  });

  const greg = makeClient('greg');
  const sam = makeClient('sam');
  const session = manager.createSession(uniqueName('test'), greg, undefined, 'cat');
  manager.joinSession(session.id, sam);

  manager.claimSizeOwner(session.id, sam);

  const updated = manager.getSession(session.id);
  expect(updated?.sizeOwner).toBe('sam');
});

test('respects max sessions limit', () => {
  manager = new SessionManager({
    defaultUser: 'root',
    scrollbackBytes: 4096,
    maxSessions: 2,
  });

  const c1 = makeClient('c1');
  const c2 = makeClient('c2');
  const c3 = makeClient('c3');

  manager.createSession(uniqueName('s1'), c1, undefined, 'cat');
  manager.createSession(uniqueName('s2'), c2, undefined, 'cat');

  expect(() => manager.createSession(uniqueName('s3'), c3, undefined, 'cat')).toThrow('max sessions');
});
