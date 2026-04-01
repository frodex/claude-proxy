import { test, expect } from 'vitest';
import { loadSessionFormConfig, _resetConfigCache, type SessionFormMode, getConditionPredicate, buildSessionFormSteps } from '../src/session-form.js';

test('loadSessionFormConfig returns all 12 fields', () => {
  _resetConfigCache();
  const config = loadSessionFormConfig();
  expect(config.fields).toHaveLength(12);
  expect(config.fields.map(f => f.id)).toEqual([
    'name', 'runas', 'server', 'workdir', 'hidden', 'viewonly',
    'public', 'users', 'groups', 'password', 'dangermode', 'claudeSessionId',
  ]);
});

test('each field has all four modes defined', () => {
  const config = loadSessionFormConfig();
  const modes: SessionFormMode[] = ['create', 'edit', 'restart', 'fork'];
  for (const field of config.fields) {
    for (const mode of modes) {
      expect(field.modes[mode]).toBeDefined();
      expect(typeof field.modes[mode].visible).toBe('boolean');
    }
  }
});

test('name field is required', () => {
  const config = loadSessionFormConfig();
  const name = config.fields.find(f => f.id === 'name');
  expect(name?.required).toBe(true);
});

test('runas is locked on edit, restart, and fork', () => {
  const config = loadSessionFormConfig();
  const runas = config.fields.find(f => f.id === 'runas');
  expect(runas?.modes.edit.locked).toBe(true);
  expect(runas?.modes.restart.locked).toBe(true);
  expect(runas?.modes.fork.locked).toBe(true);
  expect(runas?.modes.create.locked).toBe(false);
});

test('claudeSessionId hidden on create, locked on fork', () => {
  const config = loadSessionFormConfig();
  const cid = config.fields.find(f => f.id === 'claudeSessionId');
  expect(cid?.modes.create.visible).toBe(false);
  expect(cid?.modes.fork.locked).toBe(true);
});

test('fork password is not prefilled', () => {
  const config = loadSessionFormConfig();
  const pw = config.fields.find(f => f.id === 'password');
  expect(pw?.modes.fork.prefill).toBeUndefined();
});

test('admin-only predicate checks _isAdmin', () => {
  const pred = getConditionPredicate('admin-only');
  expect(pred!({ _isAdmin: true })).toBe(true);
  expect(pred!({ _isAdmin: false })).toBe(false);
});

test('not-hidden predicate checks accumulated hidden flag', () => {
  const pred = getConditionPredicate('not-hidden');
  expect(pred!({ hidden: true })).toBe(false);
  expect(pred!({ hidden: false })).toBe(true);
});

test('not-hidden-and-not-public predicate', () => {
  const pred = getConditionPredicate('not-hidden-and-not-public');
  expect(pred!({ hidden: false, public: false })).toBe(true);
  expect(pred!({ hidden: false, public: true })).toBe(false);
  expect(pred!({ hidden: true, public: false })).toBe(false);
});

test('admin-with-remotes predicate', () => {
  const pred = getConditionPredicate('admin-with-remotes');
  expect(pred!({ _isAdmin: true, _hasRemotes: true })).toBe(true);
  expect(pred!({ _isAdmin: true, _hasRemotes: false })).toBe(false);
  expect(pred!({ _isAdmin: false, _hasRemotes: true })).toBe(false);
});

test('undefined condition returns undefined', () => {
  const pred = getConditionPredicate(undefined);
  expect(pred).toBeUndefined();
});

test('buildSessionFormSteps create mode returns visible fields without claudeSessionId', () => {
  const mockClient = { username: 'root', id: 'test', transport: 'ssh' as const, termSize: { cols: 80, rows: 24 }, write: () => {}, lastKeystroke: 0 };
  const steps = buildSessionFormSteps('create', mockClient, {});
  const ids = steps.map(s => s.id);
  expect(ids).toContain('name');
  expect(ids).toContain('hidden');
  expect(ids).toContain('password');
  expect(ids).not.toContain('claudeSessionId');
});

test('buildSessionFormSteps edit mode creates locked widgets for workdir', () => {
  const mockClient = { username: 'root', id: 'test', transport: 'ssh' as const, termSize: { cols: 80, rows: 24 }, write: () => {}, lastKeystroke: 0 };
  const prefill = { name: 'test-session', workingDir: '/tmp/project' };
  const steps = buildSessionFormSteps('edit', mockClient, prefill);
  const workdir = steps.find(s => s.id === 'workdir');
  expect(workdir).toBeDefined();
  const widget = workdir!.createWidget({ _isAdmin: true, _hasRemotes: true });
  expect(widget.state.locked).toBe(true);
});

test('buildSessionFormSteps fork mode prefills name with fork suffix', () => {
  const mockClient = { username: 'root', id: 'test', transport: 'ssh' as const, termSize: { cols: 80, rows: 24 }, write: () => {}, lastKeystroke: 0 };
  const prefill = { name: 'my-session' };
  const steps = buildSessionFormSteps('fork', mockClient, prefill);
  const nameStep = steps.find(s => s.id === 'name');
  const widget = nameStep!.createWidget({});
  expect(widget.state.buffer).toContain('my-session-fork_');
});
