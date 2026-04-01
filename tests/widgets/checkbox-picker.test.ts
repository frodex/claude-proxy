import { test, expect } from 'vitest';
import { CheckboxPicker } from '../../src/widgets/checkbox-picker.js';
import { parseKey } from '../../src/widgets/keys.js';

test('space toggles current item on', () => {
  const cp = new CheckboxPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  const event = cp.handleKey(parseKey(Buffer.from(' ')));
  expect(event).toEqual({ type: 'toggle', index: 0, selected: true });
  expect(cp.state.selected.has(0)).toBe(true);
});

test('space toggles current item off', () => {
  const cp = new CheckboxPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  cp.handleKey(parseKey(Buffer.from(' '))); // toggle on
  const event = cp.handleKey(parseKey(Buffer.from(' '))); // toggle off
  expect(event).toEqual({ type: 'toggle', index: 0, selected: false });
  expect(cp.state.selected.has(0)).toBe(false);
});

test('arrow navigation delegates to ListPicker', () => {
  const cp = new CheckboxPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  cp.handleKey(parseKey(Buffer.from('\x1b[B')));
  expect(cp.state.cursor).toBe(1);
});

test('wraps around', () => {
  const cp = new CheckboxPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  cp.handleKey(parseKey(Buffer.from('\x1b[A')));
  expect(cp.state.cursor).toBe(1);
});

test('enter submits selected indices', () => {
  const cp = new CheckboxPicker({ items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] });
  cp.handleKey(parseKey(Buffer.from(' '))); // select A
  cp.handleKey(parseKey(Buffer.from('\x1b[B'))); // move to B
  cp.handleKey(parseKey(Buffer.from('\x1b[B'))); // move to C
  cp.handleKey(parseKey(Buffer.from(' '))); // select C
  const event = cp.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'submit', selectedIndices: [0, 2] });
});

test('escape cancels', () => {
  const cp = new CheckboxPicker({ items: [{ label: 'A' }] });
  const event = cp.handleKey(parseKey(Buffer.from('\x1b')));
  expect(event).toEqual({ type: 'cancel' });
});

test('manual entry mode — typing at bottom item', () => {
  const cp = new CheckboxPicker({
    items: [{ label: 'A' }, { label: 'B' }],
    allowManualEntry: true,
  });
  // Navigate to the "type to add" slot (last position = items.length)
  cp.handleKey(parseKey(Buffer.from('\x1b[B'))); // B
  cp.handleKey(parseKey(Buffer.from('\x1b[B'))); // type-to-add slot
  cp.handleKey(parseKey(Buffer.from('newuser')));
  const event = cp.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'addEntry', value: 'newuser' });
});
