import { test, expect } from 'vitest';
import { TextInput } from '../../src/widgets/text-input.js';
import { parseKey } from '../../src/widgets/keys.js';

test('typing appends to buffer', () => {
  const ti = new TextInput({ prompt: 'Name' });
  ti.handleKey(parseKey(Buffer.from('a')));
  ti.handleKey(parseKey(Buffer.from('b')));
  expect(ti.state.buffer).toBe('ab');
});

test('backspace removes last char', () => {
  const ti = new TextInput({ prompt: 'Name' });
  ti.handleKey(parseKey(Buffer.from('abc')));
  ti.handleKey(parseKey(Buffer.from('\x7f')));
  expect(ti.state.buffer).toBe('ab');
});

test('backspace on empty buffer is noop', () => {
  const ti = new TextInput({ prompt: 'Name' });
  const event = ti.handleKey(parseKey(Buffer.from('\x7f')));
  expect(ti.state.buffer).toBe('');
  expect(event).toEqual({ type: 'none' });
});

test('enter submits with buffer value', () => {
  const ti = new TextInput({ prompt: 'Name' });
  ti.handleKey(parseKey(Buffer.from('hello')));
  const event = ti.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'submit', value: 'hello' });
});

test('enter submits empty string when buffer empty', () => {
  const ti = new TextInput({ prompt: 'Name' });
  const event = ti.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'submit', value: '' });
});

test('escape cancels', () => {
  const ti = new TextInput({ prompt: 'Name' });
  const event = ti.handleKey(parseKey(Buffer.from('\x1b')));
  expect(event).toEqual({ type: 'cancel' });
});

test('tab emits tab event with current buffer', () => {
  const ti = new TextInput({ prompt: 'Path' });
  ti.handleKey(parseKey(Buffer.from('/srv/cl')));
  const event = ti.handleKey(parseKey(Buffer.from('\t')));
  expect(event).toEqual({ type: 'tab', partial: '/srv/cl' });
});

test('setBuffer updates buffer externally', () => {
  const ti = new TextInput({ prompt: 'Path' });
  ti.setBuffer('/srv/claude-proxy/');
  expect(ti.state.buffer).toBe('/srv/claude-proxy/');
});

test('masked mode does not affect buffer', () => {
  const ti = new TextInput({ prompt: 'Password', masked: true });
  ti.handleKey(parseKey(Buffer.from('secret')));
  expect(ti.state.buffer).toBe('secret');
  expect(ti.state.masked).toBe(true);
});

test('paste (multi-char) appends entire string', () => {
  const ti = new TextInput({ prompt: 'ID' });
  ti.handleKey(parseKey(Buffer.from('abc-123-def')));
  expect(ti.state.buffer).toBe('abc-123-def');
});

test('change event emitted on typing', () => {
  const ti = new TextInput({ prompt: 'Name' });
  const event = ti.handleKey(parseKey(Buffer.from('a')));
  expect(event).toEqual({ type: 'change', buffer: 'a' });
});
