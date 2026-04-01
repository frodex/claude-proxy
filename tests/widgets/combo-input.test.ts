import { test, expect } from 'vitest';
import { ComboInput } from '../../src/widgets/combo-input.js';
import { parseKey } from '../../src/widgets/keys.js';

test('starts in picker mode', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }, { label: '/srv/b' }] });
  expect(ci.state.mode).toBe('picker');
});

test('arrows navigate in picker mode', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }, { label: '/srv/b' }] });
  ci.handleKey(parseKey(Buffer.from('\x1b[B')));
  expect(ci.state.picker.cursor).toBe(1);
});

test('enter on picker item switches to text mode with pre-fill', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }, { label: '/srv/b' }] });
  ci.handleKey(parseKey(Buffer.from('\x1b[B'))); // cursor on /srv/b
  const event = ci.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'select', path: '/srv/b' });
  expect(ci.state.mode).toBe('text');
  expect(ci.state.text.buffer).toBe('/srv/b');
});

test('typing in picker mode switches to text mode', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }] });
  ci.handleKey(parseKey(Buffer.from('/')));
  expect(ci.state.mode).toBe('text');
  expect(ci.state.text.buffer).toBe('/');
});

test('tab in picker mode switches to text mode', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }] });
  ci.handleKey(parseKey(Buffer.from('\t')));
  expect(ci.state.mode).toBe('text');
});

test('enter in text mode submits', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }] });
  ci.handleKey(parseKey(Buffer.from('/srv/custom')));
  const event = ci.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'submit', value: '/srv/custom' });
});

test('escape in text mode returns to picker', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }] });
  ci.handleKey(parseKey(Buffer.from('x'))); // switch to text
  ci.handleKey(parseKey(Buffer.from('\x1b'))); // escape
  expect(ci.state.mode).toBe('picker');
});

test('escape in picker mode cancels', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }] });
  const event = ci.handleKey(parseKey(Buffer.from('\x1b')));
  expect(event).toEqual({ type: 'cancel' });
});

test('tab in text mode emits tab event', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }] });
  ci.handleKey(parseKey(Buffer.from('/srv/cl')));
  const event = ci.handleKey(parseKey(Buffer.from('\t')));
  expect(event).toEqual({ type: 'tab', partial: '/srv/cl' });
});

test('space in picker mode selects immediately', () => {
  const ci = new ComboInput({ items: [{ label: '~ (home)' }, { label: '/srv/a' }] });
  const event = ci.handleKey(parseKey(Buffer.from(' ')));
  expect(event).toEqual({ type: 'submit', value: '~ (home)' });
});
