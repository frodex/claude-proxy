# TUI Widget System

Replace 14 duplicated menu/picker/input handlers with shared composable widget objects. Incremental migration — one widget type at a time, each step is a working commit.

## Problem

`src/index.ts` and `src/session-manager.ts` contain 14+ arrow-key handlers, 18 cursor movement patterns, and 5 distinct widget types — all copy-pasted with minor variations. Bugs (like the `\x1bOA` arrow variant) must be fixed in every copy. New features (like the workdir picker) re-implement navigation from scratch.

## Principles

1. **Composable.** Compound widgets contain simpler widgets. ComboInput = ListPicker + TextInput. CheckboxPicker = ListPicker + toggle state.
2. **Widgets manage state and handle keys.** They don't render. They expose state for the caller to render however it wants (ANSI for SSH, HTML for browser later).
3. **Both arrow key variants.** `\x1b[A` (CSI) and `\x1bOA` (SS3) handled once, in the base key normalization, never checked again.
4. **Incremental migration.** Each widget type is extracted, tested, and migrated independently. Old and new code coexist during migration. Each step is a working commit.

## Key Normalization

A shared function that all widgets call first. Converts raw terminal bytes to semantic key names:

```typescript
type KeyName = 'Up' | 'Down' | 'Left' | 'Right' | 'Enter' | 'Space' |
               'Escape' | 'Backspace' | 'Tab' | string;

interface KeyEvent {
  key: KeyName;
  raw: string;
}

function parseKey(data: Buffer): KeyEvent {
  const str = data.toString();
  if (str === '\x1b[A' || str === '\x1bOA') return { key: 'Up', raw: str };
  if (str === '\x1b[B' || str === '\x1bOB') return { key: 'Down', raw: str };
  if (str === '\x1b[C' || str === '\x1bOC') return { key: 'Right', raw: str };
  if (str === '\x1b[D' || str === '\x1bOD') return { key: 'Left', raw: str };
  if (str === '\r' || str === '\n') return { key: 'Enter', raw: str };
  if (str === ' ') return { key: 'Space', raw: str };
  if (str === '\x1b' && data.length === 1) return { key: 'Escape', raw: str };
  if (str === '\x7f' || str === '\b') return { key: 'Backspace', raw: str };
  if (str === '\t') return { key: 'Tab', raw: str };
  return { key: str, raw: str };
}
```

Arrow key variants are handled here once. No widget ever checks `\x1b[A` or `\x1bOA` directly.

## Widget Types

### 1. ListPicker

Manages a cursor over a list of items. Arrow keys wrap. Enter selects. Escape cancels.

```typescript
interface ListPickerState {
  items: Array<{ label: string; disabled?: boolean }>;
  cursor: number;
  title?: string;
  hint?: string;
}

type ListPickerEvent =
  | { type: 'navigate'; cursor: number }
  | { type: 'select'; index: number }
  | { type: 'cancel' }
  | { type: 'none' };

class ListPicker {
  state: ListPickerState;
  handleKey(key: KeyEvent): ListPickerEvent;
}
```

`handleKey` is pure — takes a key, returns an event, mutates `state.cursor`. The caller decides what to do with the event (render, advance flow, etc.).

Used by: lobby menu, restart picker, server picker, help menu, edit settings menu.

### 2. TextInput

Manages a text buffer. Type to append, backspace to delete, enter to submit.

```typescript
interface TextInputState {
  buffer: string;
  prompt?: string;
  masked?: boolean;  // for passwords — render as ***
}

type TextInputEvent =
  | { type: 'change'; buffer: string }
  | { type: 'submit'; value: string }
  | { type: 'cancel' }
  | { type: 'tab' }
  | { type: 'none' };

class TextInput {
  state: TextInputState;
  handleKey(key: KeyEvent): TextInputEvent;
}
```

Used by: session name, run-as user, password, resume ID prompt, edit password.

### 3. YesNoPrompt

Single keypress — y, n, or enter (for default).

```typescript
interface YesNoState {
  prompt: string;
  defaultValue: boolean;
  result?: boolean;
}

type YesNoEvent =
  | { type: 'answer'; value: boolean }
  | { type: 'cancel' }
  | { type: 'none' };

class YesNoPrompt {
  state: YesNoState;
  handleKey(key: KeyEvent): YesNoEvent;
}
```

Used by: hidden, view-only, public, danger mode.

### 4. CheckboxPicker

Extends ListPicker with toggle state. Space toggles the current item. Enter confirms selection.

```typescript
interface CheckboxPickerState extends ListPickerState {
  selected: Set<number>;
  allowManualEntry?: boolean;  // "type to add" mode at bottom
  entryBuffer?: string;
}

type CheckboxPickerEvent =
  | { type: 'navigate'; cursor: number }
  | { type: 'toggle'; index: number; selected: boolean }
  | { type: 'submit'; selectedIndices: number[] }
  | { type: 'cancel' }
  | { type: 'addEntry'; value: string }
  | { type: 'none' };

class CheckboxPicker {
  private list: ListPicker;  // delegates navigation
  state: CheckboxPickerState;
  handleKey(key: KeyEvent): CheckboxPickerEvent;
}
```

Internally contains a ListPicker for cursor management. Space handling and toggle state are added on top.

Used by: user picker, group picker, export picker, edit-users, edit-groups, edit-admins.

### 5. ComboInput

Contains a ListPicker and a TextInput. Starts in picker mode. Enter on an item pre-fills the text input. Typing switches to text mode. Escape in text mode returns to picker.

```typescript
interface ComboInputState {
  mode: 'picker' | 'text';
  picker: ListPickerState;
  text: TextInputState;
}

type ComboInputEvent =
  | { type: 'navigate'; cursor: number }
  | { type: 'select'; path: string }  // from picker, pre-fills text
  | { type: 'submit'; value: string }  // from text input
  | { type: 'cancel' }
  | { type: 'tab'; partial: string }   // for tab-completion
  | { type: 'none' };

class ComboInput {
  private picker: ListPicker;
  private text: TextInput;
  state: ComboInputState;
  handleKey(key: KeyEvent): ComboInputEvent;
}
```

Used by: workdir picker.

### 6. Flow Engine

Chains widgets into multi-step forms. Each step has a widget factory, a condition, and a result handler.

```typescript
interface FlowStep {
  id: string;
  label: string;
  createWidget: (accumulated: Record<string, any>) => ListPicker | TextInput | YesNoPrompt | CheckboxPicker | ComboInput;
  condition?: (accumulated: Record<string, any>) => boolean;
  onResult: (event: any, accumulated: Record<string, any>) => void;
}

class FlowEngine {
  private steps: FlowStep[];
  private currentIndex: number;
  private accumulated: Record<string, any>;
  private currentWidget: any;

  constructor(steps: FlowStep[]);
  handleKey(key: KeyEvent): FlowEvent;
  getCurrentState(): { stepId: string; widget: any; progress: number };
  isComplete(): boolean;
  getResults(): Record<string, any>;
}

type FlowEvent =
  | { type: 'step-complete'; stepId: string; nextStepId: string }
  | { type: 'flow-complete'; results: Record<string, any> }
  | { type: 'flow-cancelled' }
  | { type: 'widget-event'; event: any }
  | { type: 'none' };
```

The creation wizard becomes:

```typescript
const createSessionFlow: FlowStep[] = [
  {
    id: 'name',
    label: 'Session name',
    createWidget: () => new TextInput({ prompt: 'Session name' }),
    onResult: (e, acc) => { acc.name = e.value; },
  },
  {
    id: 'runas',
    label: 'Run as user',
    createWidget: (acc) => new TextInput({ prompt: `Run as user [${acc.currentUser}]` }),
    condition: (acc) => acc.isAdmin,
    onResult: (e, acc) => { acc.runAsUser = e.value || acc.currentUser; },
  },
  {
    id: 'server',
    label: 'Server',
    createWidget: (acc) => new ListPicker({ items: acc.remotes, title: 'Select server' }),
    condition: (acc) => acc.isAdmin && acc.remotes.length > 0,
    onResult: (e, acc) => { acc.remoteHost = acc.remotes[e.index]?.host; },
  },
  {
    id: 'workdir',
    label: 'Working directory',
    createWidget: (acc) => new ComboInput({ items: acc.directories, prompt: 'Path' }),
    onResult: (e, acc) => { acc.workingDir = e.value; },
  },
  {
    id: 'hidden',
    label: 'Hidden',
    createWidget: () => new YesNoPrompt({ prompt: 'Hidden session?', defaultValue: false }),
    onResult: (e, acc) => { acc.hidden = e.value; },
  },
  // ... viewonly, public, users, groups, password, dangermode
];
```

The entire `handleCreationInput` function (currently ~400 lines of switch/if chains) becomes:

```typescript
const flow = new FlowEngine(createSessionFlow);
// in the input handler:
const event = flow.handleKey(parseKey(data));
if (event.type === 'flow-complete') {
  finalizeSession(client, event.results);
} else if (event.type === 'flow-cancelled') {
  showLobby(client);
} else {
  renderCurrentStep(client, flow.getCurrentState());
}
```

## ANSI Rendering

Each widget type gets a render function that takes its state and returns ANSI strings. These are separate from the widgets — the widget manages state, the renderer draws it.

```typescript
function renderListPicker(state: ListPickerState, cols: number): string;
function renderTextInput(state: TextInputState): string;
function renderYesNoPrompt(state: YesNoState): string;
function renderCheckboxPicker(state: CheckboxPickerState, cols: number): string;
function renderComboInput(state: ComboInputState, cols: number): string;
function renderFlowStep(flowState: { stepId: string; widget: any }, cols: number): string;
```

These live in a separate file (`src/widgets/renderers.ts`). If a browser needs the same data, it reads widget state directly (JSON) and renders HTML. The ANSI renderers are SSH-only.

## Files

| File | Purpose |
|------|---------|
| `src/widgets/keys.ts` | `parseKey()` — normalize raw bytes to KeyEvent |
| `src/widgets/list-picker.ts` | ListPicker widget |
| `src/widgets/text-input.ts` | TextInput widget |
| `src/widgets/yes-no.ts` | YesNoPrompt widget |
| `src/widgets/checkbox-picker.ts` | CheckboxPicker (composes ListPicker) |
| `src/widgets/combo-input.ts` | ComboInput (composes ListPicker + TextInput) |
| `src/widgets/flow-engine.ts` | FlowEngine — chains widgets into multi-step forms |
| `src/widgets/renderers.ts` | ANSI render functions for each widget type |
| `tests/widgets/keys.test.ts` | Key normalization tests |
| `tests/widgets/list-picker.test.ts` | ListPicker tests |
| `tests/widgets/text-input.test.ts` | TextInput tests |
| `tests/widgets/yes-no.test.ts` | YesNoPrompt tests |
| `tests/widgets/checkbox-picker.test.ts` | CheckboxPicker tests |
| `tests/widgets/combo-input.test.ts` | ComboInput tests |
| `tests/widgets/flow-engine.test.ts` | FlowEngine tests |
| Modify: `src/index.ts` | Replace inline handlers with FlowEngine + widgets |
| Modify: `src/session-manager.ts` | Replace edit menu handlers with widgets |

## Migration Order

1. `keys.ts` + tests — the foundation
2. `list-picker.ts` + tests — most common widget
3. `text-input.ts` + tests
4. `yes-no.ts` + tests
5. `checkbox-picker.ts` + tests — composes ListPicker
6. `combo-input.ts` + tests — composes ListPicker + TextInput
7. `renderers.ts` — ANSI output for all widget types
8. `flow-engine.ts` + tests — chains widgets
9. Migrate `index.ts` creation flow to FlowEngine
10. Migrate `index.ts` restart/export flows to widgets
11. Migrate `session-manager.ts` edit menu to widgets
12. Remove dead code from old handlers

Each step produces a working build with passing tests. Steps 1-8 are pure additions (no existing code modified). Steps 9-12 are the migration (replacing old code with new).

## What Does NOT Change

- Lobby (already uses `interactive-menu.ts` with `nextSelectable` — clean, leave it)
- Scrollback viewer (standalone, not duplicated)
- Hotkey handler (different pattern — prefix key, not a picker)
- API server (uses HTTP/WebSocket, not terminal widgets)
- Session management logic (only the UI handlers change)
