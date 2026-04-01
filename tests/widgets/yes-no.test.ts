// tests/widgets/yes-no.test.ts
import { test, expect } from 'vitest';
import { YesNoPrompt } from '../../src/widgets/yes-no.js';
import { parseKey } from '../../src/widgets/keys.js';

test('y answers true', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false });
  const event = yn.handleKey(parseKey(Buffer.from('y')));
  expect(event).toEqual({ type: 'answer', value: true });
});

test('Y answers true', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false });
  const event = yn.handleKey(parseKey(Buffer.from('Y')));
  expect(event).toEqual({ type: 'answer', value: true });
});

test('n answers false', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: true });
  const event = yn.handleKey(parseKey(Buffer.from('n')));
  expect(event).toEqual({ type: 'answer', value: false });
});

test('N answers false', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: true });
  const event = yn.handleKey(parseKey(Buffer.from('N')));
  expect(event).toEqual({ type: 'answer', value: false });
});

test('Enter uses default (false)', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false });
  const event = yn.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'answer', value: false });
});

test('Enter uses default (true)', () => {
  const yn = new YesNoPrompt({ prompt: 'Public?', defaultValue: true });
  const event = yn.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'answer', value: true });
});

test('Escape cancels', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false });
  const event = yn.handleKey(parseKey(Buffer.from('\x1b')));
  expect(event).toEqual({ type: 'cancel' });
});

test('other keys return none', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false });
  const event = yn.handleKey(parseKey(Buffer.from('x')));
  expect(event).toEqual({ type: 'none' });
});

test('locked prompt ignores y/n/enter but allows cancel', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false, locked: true });
  expect(yn.handleKey(parseKey(Buffer.from('y'))).type).toBe('none');
  expect(yn.handleKey(parseKey(Buffer.from('n'))).type).toBe('none');
  expect(yn.handleKey(parseKey(Buffer.from('\r'))).type).toBe('none');
  expect(yn.handleKey(parseKey(Buffer.from('\x1b'))).type).toBe('cancel');
});
