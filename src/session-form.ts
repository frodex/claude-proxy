import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';
import type { FlowStep } from './widgets/flow-engine.js';
import type { Client } from './types.js';
import { TextInput } from './widgets/text-input.js';
import { ListPicker } from './widgets/list-picker.js';
import { YesNoPrompt } from './widgets/yes-no.js';
import { CheckboxPicker } from './widgets/checkbox-picker.js';
import { ComboInput } from './widgets/combo-input.js';
import { getProfile } from './launch-profiles.js';

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
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const configPath = resolve(__dirname, 'session-form.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  _cachedConfig = parse(raw) as SessionFormConfig;
  return _cachedConfig;
}

export function _resetConfigCache(): void {
  _cachedConfig = null;
}

// --- Predicate registry ---

type Predicate = (acc: Record<string, any>) => boolean;

const PREDICATES: Record<string, Predicate> = {
  'admin-only': (acc) => acc._isAdmin === true,
  'admin-with-remotes': (acc) => acc._isAdmin === true && acc._hasRemotes === true,
  'not-hidden': (acc) => !acc.hidden,
  'not-hidden-and-not-public': (acc) => !acc.hidden && !acc.public,
  'claude-profile-only': (acc) => {
    if (acc._isAdmin !== true) return false;
    const profileId = acc._launchProfile || 'claude';
    const profile = getProfile(profileId);
    return profile?.capabilities.dangerMode === true;
  },
  'has-session-id-backfill': (acc) => {
    const profileId = acc._launchProfile || 'claude';
    const profile = getProfile(profileId);
    return profile?.capabilities.sessionIdBackfill === true;
  },
};

export function getConditionPredicate(name?: string): Predicate | undefined {
  if (!name) return undefined;
  return PREDICATES[name];
}

// --- Field-to-accumulated key mapping ---

const FIELD_TO_KEY: Record<string, string> = {
  name: 'name',
  runas: 'runAsUser',
  server: 'remoteHost',
  workdir: 'workingDir',
  hidden: 'hidden',
  viewonly: 'viewOnly',
  public: 'public',
  users: 'allowedUsers',
  groups: 'allowedGroups',
  password: 'password',
  dangermode: 'dangerousSkipPermissions',
  claudeSessionId: 'claudeSessionId',
};

// --- Widget context ---

export interface WidgetContext {
  getUsers?: () => string[];
  getGroups?: () => Array<{ name: string; systemName: string }>;
  getDirItems?: (acc: Record<string, any>) => Array<{ label: string }>;
  getServerItems?: () => Array<{ label: string }>;
  generateForkName?: (baseName: string) => string;
}

// --- Main builder ---

export function buildSessionFormSteps(
  mode: SessionFormMode,
  client: Client,
  prefill: Record<string, any>,
  context?: WidgetContext,
): FlowStep[] {
  const formConfig = loadSessionFormConfig();
  const steps: FlowStep[] = [];

  for (const field of formConfig.fields) {
    const modeConfig = field.modes[mode];
    if (!modeConfig.visible) continue;

    steps.push({
      id: field.id,
      label: field.label,
      required: field.required,
      condition: getConditionPredicate(field.condition),
      createWidget: (acc) => createWidget(field, modeConfig, mode, client, acc, prefill, context),
      onResult: (event, acc) => applyResult(field, event, acc, client),
      displayValue: (acc) => getDisplayValue(field, acc),
    });
  }

  return steps;
}

// --- Widget creation ---

function createWidget(
  field: FieldConfig,
  modeConfig: FieldModeConfig,
  mode: SessionFormMode,
  client: Client,
  acc: Record<string, any>,
  prefill: Record<string, any>,
  context?: WidgetContext,
): any {
  const locked = modeConfig.locked === true;
  const initial = resolveInitial(field, modeConfig, prefill, context);

  switch (field.widget) {
    case 'text':
      return new TextInput({ prompt: field.label, initial: initial ?? '', locked });

    case 'text-masked':
      return new TextInput({ prompt: field.label, initial: initial ?? '', masked: true, locked });

    case 'yesno':
      return new YesNoPrompt({
        prompt: field.label,
        defaultValue: initial !== undefined ? Boolean(initial) : (field.default ?? false),
        locked,
      });

    case 'list': {
      const items = context?.getServerItems?.() ?? [{ label: '(no items)' }];
      return new ListPicker({ items, title: field.label, locked });
    }

    case 'checkbox': {
      const items = field.id === 'users'
        ? (context?.getUsers?.() ?? []).filter(u => u !== client.username).map(u => ({ label: u }))
        : field.id === 'groups'
          ? (context?.getGroups?.() ?? []).map(g => ({ label: `${g.name} (${g.systemName})` }))
          : [];
      const initialSelected = resolveCheckboxSelection(field, prefill, items);
      return new CheckboxPicker({
        items,
        title: field.label,
        hint: 'space=toggle, enter=done',
        allowManualEntry: true,
        initialSelected,
      });
    }

    case 'combo': {
      // Temporary: plain text field until DirectorySelector service is built
      // See: docs/superpowers/specs/2026-04-01-directory-selector-design.md
      return new TextInput({ prompt: field.label, initial: initial ?? '', locked });
    }

    default:
      return new TextInput({ prompt: field.label, initial: initial ?? '', locked });
  }
}

function resolveInitial(
  field: FieldConfig,
  modeConfig: FieldModeConfig,
  prefill: Record<string, any>,
  context?: WidgetContext,
): any {
  if (!modeConfig.prefill) return undefined;

  if (modeConfig.prefill === 'fork-name') {
    const baseName = prefill.name || 'session';
    return context?.generateForkName?.(baseName) ?? `${baseName}-fork_01`;
  }

  const key = FIELD_TO_KEY[field.id] ?? field.id;
  return prefill[key];
}

function resolveCheckboxSelection(
  field: FieldConfig,
  prefill: Record<string, any>,
  items: Array<{ label: string }>,
): Set<number> | undefined {
  const key = FIELD_TO_KEY[field.id] ?? field.id;
  const selected = prefill[key];
  if (!Array.isArray(selected)) return undefined;

  const indices = new Set<number>();
  for (const val of selected) {
    const idx = items.findIndex(item => item.label.startsWith(val));
    if (idx >= 0) indices.add(idx);
  }
  return indices.size > 0 ? indices : undefined;
}

// --- Result application ---

function applyResult(field: FieldConfig, event: any, acc: Record<string, any>, client: Client): void {
  switch (field.id) {
    case 'name': acc.name = event.value; break;
    case 'runas': acc.runAsUser = event.value || acc._defaultUser || client.username; break;
    case 'server':
      if (event.index === 0) { acc.remoteHost = undefined; }
      else { acc.remoteHost = acc._remotes?.[event.index - 1]?.host; }
      break;
    case 'workdir': {
      const val = event.value || event.path;
      if (!val || val === '~ (home directory)') { acc.workingDir = undefined; }
      else { acc.workingDir = val.startsWith('~') ? val.replace('~', process.env.HOME || '/root') : val; }
      break;
    }
    case 'hidden': acc.hidden = event.value; if (event.value) acc.public = false; break;
    case 'viewonly': acc.viewOnly = event.value; break;
    case 'public': acc.public = event.value; break;
    case 'users':
      if (event.type === 'submit') {
        const users = acc._availableUsers || [];
        acc.allowedUsers = event.selectedIndices.map((i: number) => users[i]).filter(Boolean);
      }
      break;
    case 'groups':
      if (event.type === 'submit') {
        const groups = acc._availableGroups || [];
        acc.allowedGroups = event.selectedIndices.map((i: number) => groups[i]?.name).filter(Boolean);
      }
      break;
    case 'password': acc.password = event.value || ''; break;
    case 'dangermode': acc.dangerousSkipPermissions = event.value; break;
    case 'claudeSessionId': acc.claudeSessionId = event.value; break;
  }
}

// --- Display values ---

function getDisplayValue(field: FieldConfig, acc: Record<string, any>): string {
  const key = FIELD_TO_KEY[field.id] ?? field.id;
  const val = acc[key];
  if (val === undefined || val === null) {
    // Field-specific defaults for display (match widget defaults — visible before first edit)
    if (field.id === 'server') return 'local';
    if (field.id === 'workdir') return '~ (home directory)';
    if (field.id === 'runas') return acc._defaultUser || 'root';
    if (field.widget === 'yesno' && field.default !== undefined) {
      return field.default ? 'Yes' : 'No';
    }
    if (field.widget === 'checkbox') return '(none selected)';
    if (field.id === 'password') return '(none)';
    return '';
  }
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'string') {
    if (field.widget === 'text-masked' && val) return '****';
    return val || '(none)';
  }
  if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : '(none)';
  return String(val);
}
