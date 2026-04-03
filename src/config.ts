// src/config.ts

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';
import type { Config } from './types.js';

const DEFAULTS: Config = {
  port: 3100,
  host: '0.0.0.0',
  auth: {
    authorized_keys: '~/.ssh/authorized_keys',
  },
  sessions: {
    default_user: 'root',
    scrollback_bytes: 1048576,
    max_sessions: 10,
  },
  lobby: {
    motd: 'Welcome to claude-proxy',
  },
};

interface LoadOptions {
  configPath?: string;
  port?: number;
}

export function loadConfig(options: LoadOptions = {}): Config {
  const configPath = options.configPath ?? resolve('claude-proxy.yaml');

  // Start with defaults
  let config: Config = structuredClone(DEFAULTS);

  // Layer 1: YAML file
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    const fileConfig = parse(raw) ?? {};
    config = deepMerge(config, fileConfig) as Config;
  }

  // Layer 2: Environment variables
  if (process.env.PORT) {
    config.port = parseInt(process.env.PORT, 10);
  }

  // Layer 3: CLI flags (highest priority)
  if (options.port !== undefined) {
    config.port = options.port;
  }

  return config;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] ?? {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
