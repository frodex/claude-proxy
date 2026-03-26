import { test, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmpDir = join(tmpdir(), 'claude-proxy-test-' + Date.now());
const tmpConfig = join(tmpDir, 'test-config.yaml');

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try { unlinkSync(tmpConfig); } catch {}
});

test('loads defaults when no config file exists', () => {
  const config = loadConfig({ configPath: '/nonexistent/path.yaml' });
  expect(config.port).toBe(3100);
  expect(config.host).toBe('0.0.0.0');
  expect(config.sessions.default_user).toBe('root');
  expect(config.sessions.scrollback_bytes).toBe(1048576);
  expect(config.sessions.max_sessions).toBe(10);
});

test('loads and merges config from YAML file', () => {
  writeFileSync(tmpConfig, 'port: 4000\nlobby:\n  motd: "Hello test"');
  const config = loadConfig({ configPath: tmpConfig });
  expect(config.port).toBe(4000);
  expect(config.lobby.motd).toBe('Hello test');
  expect(config.host).toBe('0.0.0.0');  // default preserved
});

test('CLI flags override config file', () => {
  writeFileSync(tmpConfig, 'port: 4000');
  const config = loadConfig({ configPath: tmpConfig, port: 5000 });
  expect(config.port).toBe(5000);
});

test('env var PORT overrides config file', () => {
  writeFileSync(tmpConfig, 'port: 4000');
  process.env.PORT = '6000';
  const config = loadConfig({ configPath: tmpConfig });
  expect(config.port).toBe(6000);
  delete process.env.PORT;
});

test('CLI flag overrides env var', () => {
  process.env.PORT = '6000';
  const config = loadConfig({ port: 7000 });
  expect(config.port).toBe(7000);
  delete process.env.PORT;
});
