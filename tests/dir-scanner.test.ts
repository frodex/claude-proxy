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
