import { test, expect, vi } from 'vitest';
import { ScrollbackViewer } from '../src/scrollback-viewer.js';

test('renders content and starts at bottom', () => {
  const written: string[] = [];
  const viewer = new ScrollbackViewer({
    content: Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n'),
    cols: 80,
    rows: 24,
    write: (data) => written.push(data),
    onExit: () => {},
  });

  // Should have rendered once on construction
  expect(written.length).toBe(1);
  // Should show last lines (scrolled to bottom)
  expect(written[0]).toContain('Line 100');
  // Should show status bar
  expect(written[0]).toContain('SCROLLBACK');
});

test('arrow up scrolls up', () => {
  const written: string[] = [];
  const viewer = new ScrollbackViewer({
    content: Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n'),
    cols: 80,
    rows: 24,
    write: (data) => written.push(data),
    onExit: () => {},
  });

  viewer.handleInput(Buffer.from('\x1b[A'));  // arrow up
  expect(written.length).toBe(2);  // initial + scroll
});

test('q exits', () => {
  const exited = vi.fn();
  const viewer = new ScrollbackViewer({
    content: 'test content',
    cols: 80,
    rows: 24,
    write: () => {},
    onExit: exited,
  });

  viewer.handleInput(Buffer.from('q'));
  expect(exited).toHaveBeenCalledOnce();
});

test('g goes to top, G goes to bottom', () => {
  const written: string[] = [];
  const viewer = new ScrollbackViewer({
    content: Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n'),
    cols: 80,
    rows: 24,
    write: (data) => written.push(data),
    onExit: () => {},
  });

  viewer.handleInput(Buffer.from('g'));  // go to top
  expect(written.length).toBe(2);
  expect(written[1]).toContain('Line 1');

  viewer.handleInput(Buffer.from('G'));  // go to bottom
  expect(written.length).toBe(3);
  expect(written[2]).toContain('Line 100');
});
