import { test, expect, beforeEach, afterEach } from 'vitest';
import { DirScanner } from '../src/dir-scanner.js';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const TEST_DATA_DIR = '/tmp/dir-scanner-test-data';
const TEST_HISTORY = join(TEST_DATA_DIR, 'dir-history.json');

beforeEach(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test('addToHistory writes path to history file', () => {
  const scanner = new DirScanner({ historyPath: TEST_HISTORY });
  scanner.addToHistory('/srv/project-a');
  const history = scanner.getHistory();
  expect(history).toEqual(['/srv/project-a']);
});

test('addToHistory puts most recent first', () => {
  const scanner = new DirScanner({ historyPath: TEST_HISTORY });
  scanner.addToHistory('/srv/project-a');
  scanner.addToHistory('/srv/project-b');
  const history = scanner.getHistory();
  expect(history).toEqual(['/srv/project-b', '/srv/project-a']);
});

test('addToHistory deduplicates — moves existing to front', () => {
  const scanner = new DirScanner({ historyPath: TEST_HISTORY });
  scanner.addToHistory('/srv/project-a');
  scanner.addToHistory('/srv/project-b');
  scanner.addToHistory('/srv/project-a');
  const history = scanner.getHistory();
  expect(history).toEqual(['/srv/project-a', '/srv/project-b']);
});

test('addToHistory caps at 50 entries', () => {
  const scanner = new DirScanner({ historyPath: TEST_HISTORY });
  for (let i = 0; i < 60; i++) {
    scanner.addToHistory(`/srv/project-${i}`);
  }
  const history = scanner.getHistory();
  expect(history.length).toBe(50);
  expect(history[0]).toBe('/srv/project-59');
});

test('getHistory returns empty array when no history file', () => {
  const scanner = new DirScanner({ historyPath: TEST_HISTORY });
  expect(scanner.getHistory()).toEqual([]);
});

const TEST_SCAN_DIR = '/tmp/dir-scanner-test-scan';

test('scan finds git repos under scan roots', () => {
  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_SCAN_DIR, 'repo-a', '.git'), { recursive: true });
  mkdirSync(join(TEST_SCAN_DIR, 'repo-b', '.git'), { recursive: true });
  mkdirSync(join(TEST_SCAN_DIR, 'not-a-repo'), { recursive: true });

  const scanner = new DirScanner({
    historyPath: TEST_HISTORY,
    scanRoots: [TEST_SCAN_DIR],
  });
  const results = scanner.scan();
  expect(results).toContain(join(TEST_SCAN_DIR, 'repo-a'));
  expect(results).toContain(join(TEST_SCAN_DIR, 'repo-b'));
  expect(results).not.toContain(join(TEST_SCAN_DIR, 'not-a-repo'));

  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
});

test('scan respects maxDepth', () => {
  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_SCAN_DIR, 'a', 'b', 'c', 'deep-repo', '.git'), { recursive: true });
  mkdirSync(join(TEST_SCAN_DIR, 'shallow-repo', '.git'), { recursive: true });

  const scanner = new DirScanner({
    historyPath: TEST_HISTORY,
    scanRoots: [TEST_SCAN_DIR],
    maxDepth: 2,
  });
  const results = scanner.scan();
  expect(results).toContain(join(TEST_SCAN_DIR, 'shallow-repo'));
  expect(results).not.toContain(join(TEST_SCAN_DIR, 'a', 'b', 'c', 'deep-repo'));

  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
});

test('scan skips node_modules and hidden dirs', () => {
  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_SCAN_DIR, 'node_modules', 'pkg', '.git'), { recursive: true });
  mkdirSync(join(TEST_SCAN_DIR, '.hidden', 'secret-repo', '.git'), { recursive: true });
  mkdirSync(join(TEST_SCAN_DIR, 'real-repo', '.git'), { recursive: true });

  const scanner = new DirScanner({
    historyPath: TEST_HISTORY,
    scanRoots: [TEST_SCAN_DIR],
  });
  const results = scanner.scan();
  expect(results).toContain(join(TEST_SCAN_DIR, 'real-repo'));
  expect(results).not.toContain(join(TEST_SCAN_DIR, 'node_modules', 'pkg'));
  expect(results).not.toContain(join(TEST_SCAN_DIR, '.hidden', 'secret-repo'));

  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
});

test('scan caches results — rescan clears cache', () => {
  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_SCAN_DIR, 'repo-a', '.git'), { recursive: true });

  const scanner = new DirScanner({
    historyPath: TEST_HISTORY,
    scanRoots: [TEST_SCAN_DIR],
  });
  const first = scanner.scan();
  expect(first).toContain(join(TEST_SCAN_DIR, 'repo-a'));

  // Add new repo after cache
  mkdirSync(join(TEST_SCAN_DIR, 'repo-b', '.git'), { recursive: true });
  const cached = scanner.scan();
  expect(cached).not.toContain(join(TEST_SCAN_DIR, 'repo-b'));

  const refreshed = scanner.rescan();
  expect(refreshed).toContain(join(TEST_SCAN_DIR, 'repo-b'));

  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
});

test('getDirectories merges history and scan, history first', () => {
  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_SCAN_DIR, 'repo-a', '.git'), { recursive: true });
  mkdirSync(join(TEST_SCAN_DIR, 'repo-b', '.git'), { recursive: true });

  const scanner = new DirScanner({
    historyPath: TEST_HISTORY,
    scanRoots: [TEST_SCAN_DIR],
  });
  scanner.addToHistory(join(TEST_SCAN_DIR, 'repo-b'));

  const dirs = scanner.getDirectories();
  const idxB = dirs.indexOf(join(TEST_SCAN_DIR, 'repo-b'));
  const idxA = dirs.indexOf(join(TEST_SCAN_DIR, 'repo-a'));
  expect(idxB).toBeLessThan(idxA);
  // repo-b should not appear twice
  expect(dirs.filter(d => d === join(TEST_SCAN_DIR, 'repo-b')).length).toBe(1);

  rmSync(TEST_SCAN_DIR, { recursive: true, force: true });
});
