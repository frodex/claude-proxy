import { test, expect } from 'vitest';
import { FlowEngine, type FlowStep } from '../../src/widgets/flow-engine.js';
import { TextInput } from '../../src/widgets/text-input.js';
import { YesNoPrompt } from '../../src/widgets/yes-no.js';
import { parseKey } from '../../src/widgets/keys.js';

const twoStepFlow: FlowStep[] = [
  {
    id: 'name',
    label: 'Session name',
    createWidget: () => new TextInput({ prompt: 'Name' }),
    onResult: (e, acc) => { acc.name = e.value; },
  },
  {
    id: 'hidden',
    label: 'Hidden?',
    createWidget: () => new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false }),
    onResult: (e, acc) => { acc.hidden = e.value; },
  },
];

test('starts on first step', () => {
  const flow = new FlowEngine(twoStepFlow);
  expect(flow.getCurrentState().stepId).toBe('name');
});

test('completing first step advances to second', () => {
  const flow = new FlowEngine(twoStepFlow);
  flow.handleKey(parseKey(Buffer.from('test')));
  const event = flow.handleKey(parseKey(Buffer.from('\r')));
  expect(event.type).toBe('step-complete');
  expect(flow.getCurrentState().stepId).toBe('hidden');
});

test('completing all steps returns flow-complete', () => {
  const flow = new FlowEngine(twoStepFlow);
  flow.handleKey(parseKey(Buffer.from('test')));
  flow.handleKey(parseKey(Buffer.from('\r'))); // submit name
  const event = flow.handleKey(parseKey(Buffer.from('n'))); // answer hidden
  expect(event.type).toBe('flow-complete');
  const results = flow.getResults();
  expect(results.name).toBe('test');
  expect(results.hidden).toBe(false);
});

test('escape on first step cancels flow', () => {
  const flow = new FlowEngine(twoStepFlow);
  const event = flow.handleKey(parseKey(Buffer.from('\x1b')));
  expect(event.type).toBe('flow-cancelled');
});

test('conditional steps are skipped when condition is false', () => {
  const conditionalFlow: FlowStep[] = [
    {
      id: 'name',
      label: 'Name',
      createWidget: () => new TextInput({ prompt: 'Name' }),
      onResult: (e, acc) => { acc.name = e.value; },
    },
    {
      id: 'admin-only',
      label: 'Admin',
      createWidget: () => new YesNoPrompt({ prompt: 'Admin?', defaultValue: false }),
      condition: (acc) => acc.isAdmin === true,
      onResult: (e, acc) => { acc.adminChoice = e.value; },
    },
    {
      id: 'final',
      label: 'Final',
      createWidget: () => new YesNoPrompt({ prompt: 'Done?', defaultValue: true }),
      onResult: (e, acc) => { acc.done = e.value; },
    },
  ];

  const flow = new FlowEngine(conditionalFlow);
  // isAdmin not set, so admin-only step should be skipped
  flow.handleKey(parseKey(Buffer.from('test')));
  flow.handleKey(parseKey(Buffer.from('\r'))); // submit name → skip admin → land on final
  expect(flow.getCurrentState().stepId).toBe('final');
});

test('accumulated results available to conditions', () => {
  const flow: FlowStep[] = [
    {
      id: 'flag',
      label: 'Flag',
      createWidget: () => new YesNoPrompt({ prompt: 'Enable?', defaultValue: false }),
      onResult: (e, acc) => { acc.enabled = e.value; },
    },
    {
      id: 'details',
      label: 'Details',
      createWidget: () => new TextInput({ prompt: 'Details' }),
      condition: (acc) => acc.enabled === true,
      onResult: (e, acc) => { acc.details = e.value; },
    },
  ];

  const engine = new FlowEngine(flow);
  const event = engine.handleKey(parseKey(Buffer.from('n'))); // enabled = false
  // details step skipped → flow complete
  expect(event.type).toBe('flow-complete');
  expect(engine.getResults().enabled).toBe(false);
  expect(engine.getResults().details).toBeUndefined();
});

test('getFlowSummary uses displayValue callback for completed steps', () => {
  const flow: FlowStep[] = [
    {
      id: 'name',
      label: 'Session name',
      createWidget: () => new TextInput({ prompt: 'Name' }),
      onResult: (e, acc) => { acc.name = e.value; },
      displayValue: (acc) => acc.name || '',
    },
    {
      id: 'hidden',
      label: 'Hidden?',
      createWidget: () => new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false }),
      onResult: (e, acc) => { acc.hidden = e.value; },
      displayValue: (acc) => acc.hidden ? 'Yes' : 'No',
    },
  ];

  const engine = new FlowEngine(flow);
  engine.handleKey(parseKey(Buffer.from('my-project')));
  engine.handleKey(parseKey(Buffer.from('\r'))); // submit name

  const summary = engine.getFlowSummary();
  expect(summary[0].fieldState).toBe('completed');
  expect(summary[0].value).toBe('my-project');
  expect(summary[1].fieldState).toBe('active');
  expect(summary[1].value).toBeUndefined();
});

test('getFlowSummary marks skipped conditional steps as grayed', () => {
  const flow: FlowStep[] = [
    {
      id: 'name',
      label: 'Name',
      createWidget: () => new TextInput({ prompt: 'Name' }),
      onResult: (e, acc) => { acc.name = e.value; },
    },
    {
      id: 'admin-only',
      label: 'Admin setting',
      createWidget: () => new YesNoPrompt({ prompt: 'Admin?', defaultValue: false }),
      condition: () => false,
      onResult: (e, acc) => { acc.admin = e.value; },
    },
    {
      id: 'final',
      label: 'Done',
      createWidget: () => new YesNoPrompt({ prompt: 'Done?', defaultValue: true }),
      onResult: (e, acc) => { acc.done = e.value; },
    },
  ];

  const engine = new FlowEngine(flow);
  const summary = engine.getFlowSummary();
  expect(summary[0].fieldState).toBe('active');
  expect(summary[1].fieldState).toBe('grayed');
  expect(summary[2].fieldState).toBe('pending');
});

test('isComplete returns true after all steps', () => {
  const flow = new FlowEngine(twoStepFlow);
  expect(flow.isComplete()).toBe(false);
  flow.handleKey(parseKey(Buffer.from('test')));
  flow.handleKey(parseKey(Buffer.from('\r')));
  flow.handleKey(parseKey(Buffer.from('n')));
  expect(flow.isComplete()).toBe(true);
});
