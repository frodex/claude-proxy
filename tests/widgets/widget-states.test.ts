import { test, expect } from 'vitest';
import { STATE_COLORS, RESET, type WidgetFieldState } from '../../src/widgets/keys.js';

test('all six states have ANSI color codes', () => {
  const states: WidgetFieldState[] = ['active', 'editing', 'completed', 'locked', 'grayed', 'pending'];
  for (const s of states) {
    expect(STATE_COLORS[s]).toBeTruthy();
    expect(STATE_COLORS[s].startsWith('\x1b[')).toBe(true);
  }
});

test('RESET is ESC[0m', () => {
  expect(RESET).toBe('\x1b[0m');
});

test('editing and active have different colors', () => {
  expect(STATE_COLORS.editing).not.toBe(STATE_COLORS.active);
});
