import { test, expect } from 'vitest';
import { renderListPicker, renderTextInput, renderYesNo, renderCheckboxPicker, renderFlowForm } from '../../src/widgets/renderers.js';
import type { FlowStepSummary } from '../../src/widgets/flow-engine.js';

test('renderListPicker shows cursor arrow on current item', () => {
  const output = renderListPicker({
    items: [{ label: 'Apple' }, { label: 'Banana' }],
    cursor: 1,
    title: 'Pick fruit',
  });
  expect(output).toContain('Pick fruit');
  expect(output).toContain('Banana');
  // cursor arrow on Banana (index 1), not on Apple
  const lines = output.split('\r\n');
  const bananaLine = lines.find(l => l.includes('Banana'));
  expect(bananaLine).toContain('>');
});

test('renderListPicker grays out disabled items', () => {
  const output = renderListPicker({
    items: [{ label: 'Active' }, { label: 'Disabled', disabled: true }],
    cursor: 0,
  });
  // Disabled item should have gray escape code
  expect(output).toContain('Disabled');
  expect(output).toContain('\x1b[38;5;245m');
});

test('renderTextInput shows prompt and buffer', () => {
  const output = renderTextInput({ buffer: 'hello', prompt: 'Name' });
  expect(output).toContain('Name');
  expect(output).toContain('hello');
});

test('renderTextInput masks buffer when masked', () => {
  const output = renderTextInput({ buffer: 'secret', prompt: 'Password', masked: true });
  expect(output).toContain('******');
  expect(output).not.toContain('secret');
});

test('renderYesNo shows prompt with default highlighted', () => {
  const output = renderYesNo({ prompt: 'Hidden?', defaultValue: false });
  expect(output).toContain('Hidden?');
  expect(output).toContain('N');
});

test('renderCheckboxPicker shows checked and unchecked items', () => {
  const output = renderCheckboxPicker({
    items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    cursor: 1,
    selected: new Set([0, 2]),
    entryBuffer: '',
  });
  expect(output).toContain('[x]');
  expect(output).toContain('[ ]');
});

test('renderFlowForm shows all steps with correct state indicators', () => {
  const summary: FlowStepSummary[] = [
    { id: 'name', label: 'Session name', fieldState: 'completed', value: 'my-project' },
    { id: 'hidden', label: 'Hidden', fieldState: 'editing' },
    { id: 'public', label: 'Public', fieldState: 'pending' },
    { id: 'users', label: 'Users', fieldState: 'grayed' },
    { id: 'server', label: 'Server', fieldState: 'locked', value: 'bigserver' },
  ];
  const mockWidget = { state: { defaultValue: false, prompt: 'Hidden?' } };
  const output = renderFlowForm('New session', summary, mockWidget, 'hidden');

  expect(output).toContain('my-project');     // completed value
  expect(output).toContain('\u2713');          // checkmark for completed
  expect(output).toContain('>');               // cursor on active/editing
  expect(output).toContain('---');             // grayed placeholder
  expect(output).toContain('\uD83D\uDD12');    // lock emoji for locked
});

test('renderFlowForm highlights missing required fields in red', () => {
  const summary: FlowStepSummary[] = [
    { id: 'name', label: 'Session name', fieldState: 'active' },
  ];
  const output = renderFlowForm('New session', summary, null, '', [0]);
  expect(output).toContain('\x1b[31m'); // red
  expect(output).toContain('Session name');
});
