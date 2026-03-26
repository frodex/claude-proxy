import { test, expect } from 'vitest';
import { HotkeyHandler } from '../src/hotkey.js';

test('passes through normal input', () => {
  const results: Array<{ type: string; data?: Buffer }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: (data) => results.push({ type: 'passthrough', data }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
    onScrollback: () => results.push({ type: 'scrollback' }),
    onRedraw: () => results.push({ type: 'redraw' }),
    onLessScrollback: () => results.push({ type: 'lessScrollback' }),
    onHelp: () => results.push({ type: 'help' }),
  });

  handler.feed(Buffer.from('hello'));
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('passthrough');
  expect(results[0].data!.toString()).toBe('hello');
});

test('Ctrl+B then d triggers detach', () => {
  const results: Array<{ type: string }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: (data) => results.push({ type: 'passthrough' }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
    onScrollback: () => results.push({ type: 'scrollback' }),
    onRedraw: () => results.push({ type: 'redraw' }),
    onLessScrollback: () => results.push({ type: 'lessScrollback' }),
    onHelp: () => results.push({ type: 'help' }),
  });

  handler.feed(Buffer.from('\x02'));  // Ctrl+B
  expect(results).toHaveLength(0);    // buffered, waiting for next key

  handler.feed(Buffer.from('d'));     // detach command
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('detach');
});

test('Ctrl+B then s triggers claimSize', () => {
  const results: Array<{ type: string }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: (data) => results.push({ type: 'passthrough' }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
    onScrollback: () => results.push({ type: 'scrollback' }),
    onRedraw: () => results.push({ type: 'redraw' }),
    onLessScrollback: () => results.push({ type: 'lessScrollback' }),
    onHelp: () => results.push({ type: 'help' }),
  });

  handler.feed(Buffer.from('\x02'));  // Ctrl+B
  handler.feed(Buffer.from('s'));     // claim size
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('claimSize');
});

test('Ctrl+B then unknown key passes both through', () => {
  const results: Array<{ type: string; data?: Buffer }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: (data) => results.push({ type: 'passthrough', data }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
    onScrollback: () => results.push({ type: 'scrollback' }),
    onRedraw: () => results.push({ type: 'redraw' }),
    onLessScrollback: () => results.push({ type: 'lessScrollback' }),
    onHelp: () => results.push({ type: 'help' }),
  });

  handler.feed(Buffer.from('\x02'));  // Ctrl+B
  handler.feed(Buffer.from('x'));     // unknown
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('passthrough');
  expect(results[0].data!.toString()).toBe('\x02x');
});

test('Ctrl+B Ctrl+B passes single Ctrl+B through', () => {
  const results: Array<{ type: string; data?: Buffer }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: (data) => results.push({ type: 'passthrough', data }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
    onScrollback: () => results.push({ type: 'scrollback' }),
    onRedraw: () => results.push({ type: 'redraw' }),
    onLessScrollback: () => results.push({ type: 'lessScrollback' }),
    onHelp: () => results.push({ type: 'help' }),
  });

  handler.feed(Buffer.from('\x02'));  // Ctrl+B
  handler.feed(Buffer.from('\x02'));  // Ctrl+B again — escape
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('passthrough');
  expect(results[0].data!.toString()).toBe('\x02');
});

test('Ctrl+B timeout passes Ctrl+B through', async () => {
  const results: Array<{ type: string; data?: Buffer }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: (data) => results.push({ type: 'passthrough', data }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
    onScrollback: () => results.push({ type: 'scrollback' }),
    onRedraw: () => results.push({ type: 'redraw' }),
    onLessScrollback: () => results.push({ type: 'lessScrollback' }),
    onHelp: () => results.push({ type: 'help' }),
    timeoutMs: 50,
  });

  handler.feed(Buffer.from('\x02'));  // Ctrl+B
  expect(results).toHaveLength(0);

  await new Promise(r => setTimeout(r, 100));
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('passthrough');
  expect(results[0].data!.toString()).toBe('\x02');
});

test('Ctrl+B then h triggers scrollback', () => {
  const results: Array<{ type: string }> = [];
  const handler = new HotkeyHandler({
    onPassthrough: () => results.push({ type: 'passthrough' }),
    onDetach: () => results.push({ type: 'detach' }),
    onClaimSize: () => results.push({ type: 'claimSize' }),
    onScrollback: () => results.push({ type: 'scrollback' }),
    onRedraw: () => results.push({ type: 'redraw' }),
    onLessScrollback: () => results.push({ type: 'lessScrollback' }),
    onHelp: () => results.push({ type: 'help' }),
  });

  handler.feed(Buffer.from('\x02'));
  handler.feed(Buffer.from('h'));
  expect(results).toHaveLength(1);
  expect(results[0].type).toBe('scrollback');
});
