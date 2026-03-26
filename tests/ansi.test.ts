import { test, expect } from 'vitest';
import { moveTo, setScrollRegion, clearLine, color, saveCursor, restoreCursor, hideCursor, showCursor } from '../src/ansi.js';

test('moveTo generates correct escape sequence', () => {
  expect(moveTo(1, 1)).toBe('\x1b[1;1H');
  expect(moveTo(10, 5)).toBe('\x1b[10;5H');
});

test('setScrollRegion sets top and bottom rows', () => {
  expect(setScrollRegion(1, 40)).toBe('\x1b[1;40r');
});

test('clearLine clears the current line', () => {
  expect(clearLine()).toBe('\x1b[2K');
});

test('color wraps text in ANSI color codes', () => {
  expect(color('hello', 33)).toBe('\x1b[33mhello\x1b[0m');
  expect(color('bold', 1)).toBe('\x1b[1mbold\x1b[0m');
});

test('saveCursor and restoreCursor', () => {
  expect(saveCursor()).toBe('\x1b7');
  expect(restoreCursor()).toBe('\x1b8');
});

test('hideCursor and showCursor', () => {
  expect(hideCursor()).toBe('\x1b[?25l');
  expect(showCursor()).toBe('\x1b[?25h');
});
