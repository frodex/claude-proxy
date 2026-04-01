import { test, expect } from 'vitest';
import { loadSessionFormConfig, _resetConfigCache, type SessionFormMode } from '../src/session-form.js';

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
