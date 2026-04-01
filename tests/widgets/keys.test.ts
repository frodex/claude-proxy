import { test, expect } from 'vitest';
import { parseKey } from '../../src/widgets/keys.js';

test('CSI arrow up', () => {
  expect(parseKey(Buffer.from('\x1b[A')).key).toBe('Up');
});
test('SS3 arrow up', () => {
  expect(parseKey(Buffer.from('\x1bOA')).key).toBe('Up');
});
test('CSI arrow down', () => {
  expect(parseKey(Buffer.from('\x1b[B')).key).toBe('Down');
});
test('SS3 arrow down', () => {
  expect(parseKey(Buffer.from('\x1bOB')).key).toBe('Down');
});
test('CSI arrow right', () => {
  expect(parseKey(Buffer.from('\x1b[C')).key).toBe('Right');
});
test('SS3 arrow right', () => {
  expect(parseKey(Buffer.from('\x1bOC')).key).toBe('Right');
});
test('CSI arrow left', () => {
  expect(parseKey(Buffer.from('\x1b[D')).key).toBe('Left');
});
test('SS3 arrow left', () => {
  expect(parseKey(Buffer.from('\x1bOD')).key).toBe('Left');
});
test('enter (\\r)', () => {
  expect(parseKey(Buffer.from('\r')).key).toBe('Enter');
});
test('enter (\\n)', () => {
  expect(parseKey(Buffer.from('\n')).key).toBe('Enter');
});
test('space', () => {
  expect(parseKey(Buffer.from(' ')).key).toBe('Space');
});
test('escape (single byte)', () => {
  expect(parseKey(Buffer.from('\x1b')).key).toBe('Escape');
});
test('escape sequence is not Escape', () => {
  expect(parseKey(Buffer.from('\x1b[A')).key).not.toBe('Escape');
});
test('backspace (0x7f)', () => {
  expect(parseKey(Buffer.from('\x7f')).key).toBe('Backspace');
});
test('backspace (0x08)', () => {
  expect(parseKey(Buffer.from('\b')).key).toBe('Backspace');
});
test('tab', () => {
  expect(parseKey(Buffer.from('\t')).key).toBe('Tab');
});
test('printable character', () => {
  expect(parseKey(Buffer.from('a')).key).toBe('a');
});
test('printable multi-char (paste)', () => {
  expect(parseKey(Buffer.from('hello')).key).toBe('hello');
});
test('raw is preserved', () => {
  expect(parseKey(Buffer.from('\x1b[A')).raw).toBe('\x1b[A');
});
