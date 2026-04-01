import { test, expect } from 'vitest';
import { ListPicker } from '../../src/widgets/list-picker.js';
import { parseKey } from '../../src/widgets/keys.js';

test('initial cursor is 0', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  expect(lp.state.cursor).toBe(0);
});

test('Down moves cursor forward', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  lp.handleKey(parseKey(Buffer.from('\x1b[B')));
  expect(lp.state.cursor).toBe(1);
});

test('Up wraps to last item from first', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] });
  lp.handleKey(parseKey(Buffer.from('\x1b[A')));
  expect(lp.state.cursor).toBe(2);
});

test('Down wraps to first item from last', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  lp.handleKey(parseKey(Buffer.from('\x1b[B')));
  lp.handleKey(parseKey(Buffer.from('\x1b[B')));
  expect(lp.state.cursor).toBe(0);
});

test('Down skips disabled items', () => {
  const lp = new ListPicker({ items: [
    { label: 'A' },
    { label: 'B', disabled: true },
    { label: 'C' },
  ]});
  lp.handleKey(parseKey(Buffer.from('\x1b[B')));
  expect(lp.state.cursor).toBe(2);
});

test('Enter returns select event', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  lp.handleKey(parseKey(Buffer.from('\x1b[B')));
  const event = lp.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'select', index: 1 });
});

test('Escape returns cancel event', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }] });
  const event = lp.handleKey(parseKey(Buffer.from('\x1b')));
  expect(event).toEqual({ type: 'cancel' });
});

test('Space returns select event', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }] });
  const event = lp.handleKey(parseKey(Buffer.from(' ')));
  expect(event).toEqual({ type: 'select', index: 0 });
});

test('SS3 arrow keys work', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  lp.handleKey(parseKey(Buffer.from('\x1bOB')));
  expect(lp.state.cursor).toBe(1);
  lp.handleKey(parseKey(Buffer.from('\x1bOA')));
  expect(lp.state.cursor).toBe(0);
});

test('navigate event includes new cursor position', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  const event = lp.handleKey(parseKey(Buffer.from('\x1b[B')));
  expect(event).toEqual({ type: 'navigate', cursor: 1 });
});

test('unrecognized key returns none', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }] });
  const event = lp.handleKey(parseKey(Buffer.from('x')));
  expect(event).toEqual({ type: 'none' });
});
