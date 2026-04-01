import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

// --- YAML config types ---

export type SessionFormMode = 'create' | 'edit' | 'restart' | 'fork';

export interface FieldModeConfig {
  visible: boolean;
  locked?: boolean;
  prefill?: boolean | string;
}

export interface FieldConfig {
  id: string;
  label: string;
  widget: 'text' | 'text-masked' | 'yesno' | 'list' | 'checkbox' | 'combo';
  required?: boolean;
  default?: any;
  condition?: string;
  modes: Record<SessionFormMode, FieldModeConfig>;
}

export interface SessionFormConfig {
  fields: FieldConfig[];
}

// --- Config loader ---

let _cachedConfig: SessionFormConfig | null = null;

export function loadSessionFormConfig(): SessionFormConfig {
  if (_cachedConfig) return _cachedConfig;
  const configPath = resolve('src/session-form.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  _cachedConfig = parse(raw) as SessionFormConfig;
  return _cachedConfig;
}

export function _resetConfigCache(): void {
  _cachedConfig = null;
}
