# Unified Session Screen Implementation Plan v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Supersedes:** `2026-03-31-unified-session-screen.md` (v1)
> **Decision journal:** `docs/research/2026-04-01-v0.1-unified-session-screen-decisions-journal.md`

**Goal:** One screen for creating, editing, restarting, and forking sessions. Full-form rendering with two-mode interaction (navigate/edit). YAML-driven field configuration. All SSH features get corresponding API endpoints.

**Architecture:** Extend FlowEngine into a navigable form engine with two modes (field navigation + widget editing), validation, and submit gating. Field metadata (visibility, locked state, prefill per mode) driven by YAML config. SessionForm reuses one form definition for create/edit/restart/fork — each mode applies different field states from config.

**Tech Stack:** TypeScript, vitest, existing widget system at `src/widgets/`, existing YAML config system (`yaml@2.8.3`, `src/config.ts`)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/widgets/keys.ts` | Modify | Add `WidgetFieldState` type, `STATE_COLORS`, `RESET` |
| `src/widgets/flow-engine.ts` | Modify | Two-mode form engine: navigate/edit, goBack, validation, submit gate, `displayValue`, `getFlowSummary()` |
| `src/widgets/renderers.ts` | Modify | Add `renderFlowForm()`, `renderInlineWidget()` |
| `src/widgets/list-picker.ts` | Modify | Add `locked` option |
| `src/widgets/text-input.ts` | Modify | Add `locked` option |
| `src/widgets/yes-no.ts` | Modify | Add `locked` option |
| `src/session-form.ts` | Create | `buildSessionFormSteps()`, widget factory, predicate registry, YAML config types + loader |
| `src/session-form.yaml` | Create | Field × mode matrix config |
| `src/index.ts` | Modify | Replace `renderCurrentStep` + `buildCreateSessionSteps` with SessionForm, wire restart/fork-from-lobby |
| `src/session-manager.ts` | Modify | Replace `startEditSession`/`forkSession` with SessionForm |
| `src/lobby.ts` | Modify | Add fork action |
| `src/api-server.ts` | Modify | Session CRUD, restart, fork, supporting endpoints |
| `tests/widgets/widget-states.test.ts` | Create | Widget state types + colors |
| `tests/widgets/flow-engine.test.ts` | Modify | Two-mode navigation, goBack, validation, submit gate |
| `tests/widgets/list-picker.test.ts` | Modify | Locked behavior |
| `tests/widgets/text-input.test.ts` | Modify | Locked behavior |
| `tests/widgets/renderers.test.ts` | Modify | Full-form rendering |
| `tests/session-form.test.ts` | Create | YAML loading, mode matrix, predicate registry, widget factory |

---

## Phase 1: Widget States (Tasks 1–2)

### Task 1: Add widget field states to base types

**Files:**
- Modify: `src/widgets/keys.ts`
- Create: `tests/widgets/widget-states.test.ts`

- [ ] **Step 1: Write test for state types and colors**

```typescript
// tests/widgets/widget-states.test.ts
import { test, expect } from 'vitest';
import { STATE_COLORS, RESET, type WidgetFieldState } from '../../src/widgets/keys.js';

test('all six states have ANSI color codes', () => {
  const states: WidgetFieldState[] = ['active', 'editing', 'completed', 'locked', 'grayed', 'pending'];
  for (const s of states) {
    expect(STATE_COLORS[s]).toBeTruthy();
    expect(STATE_COLORS[s].startsWith('\x1b[')).toBe(true);
  }
});

test('RESET is ESC[0m', () => {
  expect(RESET).toBe('\x1b[0m');
});

test('editing and active have different colors', () => {
  expect(STATE_COLORS.editing).not.toBe(STATE_COLORS.active);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/widget-states.test.ts`
Expected: FAIL — `STATE_COLORS` and `WidgetFieldState` not exported from keys.ts

- [ ] **Step 3: Add types to keys.ts**

Add to the end of `src/widgets/keys.ts`:

```typescript
export type WidgetFieldState = 'active' | 'editing' | 'completed' | 'locked' | 'grayed' | 'pending';

export const STATE_COLORS: Record<WidgetFieldState, string> = {
  active: '\x1b[33m',              // yellow — field nav cursor
  editing: '\x1b[1m',              // bold white — widget edit mode
  completed: '\x1b[32m',          // green
  locked: '\x1b[33;2m',           // yellow dim
  grayed: '\x1b[38;5;245m',       // dark gray
  pending: '\x1b[2m',             // dim white
};

export const RESET = '\x1b[0m';
```

Note: `active` = yellow (navigate mode selected), `editing` = bold white (widget edit mode). This is the two-mode color signaling.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/widget-states.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/widgets/keys.ts tests/widgets/widget-states.test.ts && git commit -m "feat: widget field states — active, editing, completed, locked, grayed, pending with ANSI colors"
```

---

### Task 2: Add locked option to widgets

**Files:**
- Modify: `src/widgets/list-picker.ts`
- Modify: `src/widgets/text-input.ts`
- Modify: `src/widgets/yes-no.ts`
- Modify: `tests/widgets/list-picker.test.ts`
- Modify: `tests/widgets/text-input.test.ts`

- [ ] **Step 1: Write test for locked ListPicker**

Add to `tests/widgets/list-picker.test.ts`:

```typescript
test('locked picker ignores all input except cancel', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }], locked: true });
  expect(lp.handleKey(parseKey(Buffer.from('\x1b[B'))).type).toBe('none'); // Down
  expect(lp.handleKey(parseKey(Buffer.from('\x1b[A'))).type).toBe('none'); // Up
  expect(lp.handleKey(parseKey(Buffer.from('\r'))).type).toBe('none');     // Enter
  expect(lp.handleKey(parseKey(Buffer.from(' '))).type).toBe('none');      // Space
  expect(lp.handleKey(parseKey(Buffer.from('\x1b'))).type).toBe('cancel'); // Escape still works
});
```

- [ ] **Step 2: Write test for locked TextInput**

Add to `tests/widgets/text-input.test.ts`:

```typescript
test('locked input ignores typing and backspace', () => {
  const ti = new TextInput({ prompt: 'ID', locked: true, initial: 'abc-123' });
  expect(ti.handleKey(parseKey(Buffer.from('x'))).type).toBe('none');
  expect(ti.state.buffer).toBe('abc-123');
  expect(ti.handleKey(parseKey(Buffer.from('\x7f'))).type).toBe('none'); // Backspace
  expect(ti.state.buffer).toBe('abc-123');
  expect(ti.handleKey(parseKey(Buffer.from('\x1b'))).type).toBe('cancel'); // Escape works
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/list-picker.test.ts tests/widgets/text-input.test.ts`
Expected: FAIL — `locked` option not recognized

- [ ] **Step 4: Add locked to ListPicker**

In `src/widgets/list-picker.ts`, add `locked` to constructor options and state:

Change constructor signature from:
```typescript
constructor(options: { items: ListPickerItem[]; title?: string; hint?: string }) {
```
to:
```typescript
constructor(options: { items: ListPickerItem[]; title?: string; hint?: string; locked?: boolean }) {
```

Add to state interface:
```typescript
export interface ListPickerState {
  items: ListPickerItem[];
  cursor: number;
  title?: string;
  hint?: string;
  locked?: boolean;
}
```

Initialize in constructor: `locked: options.locked,` in the state assignment.

Add guard at the top of `handleKey`:
```typescript
if (this.state.locked) {
  if (isCancelKey(key)) return { type: 'cancel' };
  return { type: 'none' };
}
```

- [ ] **Step 5: Add locked to TextInput**

In `src/widgets/text-input.ts`, add `locked` to constructor and state:

Change constructor signature from:
```typescript
constructor(options: { prompt?: string; masked?: boolean; initial?: string }) {
```
to:
```typescript
constructor(options: { prompt?: string; masked?: boolean; initial?: string; locked?: boolean }) {
```

Add `locked?: boolean` to `TextInputState`.

Initialize in constructor: `locked: options.locked,`

Add guard at the top of `handleKey`:
```typescript
if (this.state.locked) {
  if (key.key === 'Escape' || key.key === 'CtrlC') return { type: 'cancel' };
  return { type: 'none' };
}
```

- [ ] **Step 6: Add locked to YesNoPrompt**

In `src/widgets/yes-no.ts`, add `locked` to constructor and state:

Change constructor signature from:
```typescript
constructor(options: { prompt: string; defaultValue: boolean }) {
```
to:
```typescript
constructor(options: { prompt: string; defaultValue: boolean; locked?: boolean }) {
```

Add `locked?: boolean` to `YesNoState`.

Initialize in constructor: `locked: options.locked,`

Add guard at the top of `handleKey`:
```typescript
if (this.state.locked) {
  if (key.key === 'Escape' || key.key === 'CtrlC') return { type: 'cancel' };
  return { type: 'none' };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS (existing + 2 new)

- [ ] **Step 8: Commit**

```bash
git add src/widgets/list-picker.ts src/widgets/text-input.ts src/widgets/yes-no.ts tests/widgets/list-picker.test.ts tests/widgets/text-input.test.ts && git commit -m "feat: locked state for list-picker, text-input, yes-no — ignores input except cancel"
```

---

## Phase 2: FlowEngine Form Mode (Tasks 3–5)

### Task 3: Add displayValue and FlowStep extensions

**Files:**
- Modify: `src/widgets/flow-engine.ts`
- Modify: `tests/widgets/flow-engine.test.ts`

- [ ] **Step 1: Write test for displayValue callback**

Add to `tests/widgets/flow-engine.test.ts`:

```typescript
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
```

- [ ] **Step 2: Write test for getFlowSummary with grayed conditional steps**

Add to `tests/widgets/flow-engine.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/flow-engine.test.ts`
Expected: FAIL — `getFlowSummary` and `displayValue` don't exist

- [ ] **Step 4: Add displayValue to FlowStep interface and implement getFlowSummary**

In `src/widgets/flow-engine.ts`, update the imports and types:

```typescript
import type { KeyEvent } from './keys.js';
import type { WidgetFieldState } from './keys.js';

type Widget = { handleKey(key: KeyEvent): any; state: any };

export interface FlowStep {
  id: string;
  label: string;
  createWidget: (accumulated: Record<string, any>) => Widget;
  condition?: (accumulated: Record<string, any>) => boolean;
  onResult: (event: any, accumulated: Record<string, any>) => void;
  displayValue?: (accumulated: Record<string, any>) => string;
  required?: boolean;
}

export interface FlowStepSummary {
  id: string;
  label: string;
  fieldState: WidgetFieldState;
  value?: string;
}
```

Add `getFlowSummary()` method to `FlowEngine`:

```typescript
getFlowSummary(): FlowStepSummary[] {
  return this.steps.map((step, i) => {
    if (i < this.currentIndex) {
      const value = step.displayValue
        ? step.displayValue(this.accumulated)
        : this.defaultDisplayValue(step.id);
      return { id: step.id, label: step.label, fieldState: 'completed' as const, value };
    }
    if (i === this.currentIndex) {
      return { id: step.id, label: step.label, fieldState: 'active' as const };
    }
    if (step.condition && !step.condition(this.accumulated)) {
      return { id: step.id, label: step.label, fieldState: 'grayed' as const };
    }
    return { id: step.id, label: step.label, fieldState: 'pending' as const };
  });
}

private defaultDisplayValue(stepId: string): string {
  const val = this.accumulated[stepId];
  if (val === undefined || val === null) return '';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'string') return val || '(default)';
  if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : '(none)';
  return String(val);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/flow-engine.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/widgets/flow-engine.ts tests/widgets/flow-engine.test.ts && git commit -m "feat: FlowStep.displayValue + FlowEngine.getFlowSummary() — field states for form rendering"
```

---

### Task 4: Two-mode navigation (navigate/edit) in FlowEngine

**Files:**
- Modify: `src/widgets/flow-engine.ts`
- Modify: `tests/widgets/flow-engine.test.ts`

- [ ] **Step 1: Write test for navigate mode — arrows move between fields**

Add to `tests/widgets/flow-engine.test.ts`:

```typescript
test('navigate mode: arrow down moves to next visible field', () => {
  const flow = new FlowEngine(twoStepFlow);
  flow.setMode('navigate');
  const summary1 = flow.getFlowSummary();
  expect(summary1[0].fieldState).toBe('active'); // cursor on name

  flow.handleKey(parseKey(Buffer.from('\x1b[B'))); // Down
  const summary2 = flow.getFlowSummary();
  expect(summary2[0].fieldState).toBe('pending');
  expect(summary2[1].fieldState).toBe('active'); // cursor moved to hidden
});

test('navigate mode: arrow up moves to previous visible field', () => {
  const flow = new FlowEngine(twoStepFlow);
  flow.setMode('navigate');
  flow.handleKey(parseKey(Buffer.from('\x1b[B'))); // Down to hidden
  flow.handleKey(parseKey(Buffer.from('\x1b[A'))); // Up back to name
  const summary = flow.getFlowSummary();
  expect(summary[0].fieldState).toBe('active');
});

test('navigate mode: Enter switches to edit mode', () => {
  const flow = new FlowEngine(twoStepFlow);
  flow.setMode('navigate');
  const event = flow.handleKey(parseKey(Buffer.from('\r'))); // Enter
  expect(flow.getMode()).toBe('edit');
  expect(event.type).toBe('mode-change');
});
```

- [ ] **Step 2: Write test for edit mode — keys go to widget, Enter confirms**

```typescript
test('edit mode: keys go to widget, Enter confirms and returns to navigate', () => {
  const flow = new FlowEngine(twoStepFlow);
  flow.setMode('navigate');
  flow.handleKey(parseKey(Buffer.from('\r'))); // Enter edit mode on 'name'

  // Type into widget
  flow.handleKey(parseKey(Buffer.from('test-session')));
  const state = flow.getCurrentState();
  expect(state.widget.state.buffer).toBe('test-session');

  // Enter confirms — back to navigate mode, field is completed
  const event = flow.handleKey(parseKey(Buffer.from('\r')));
  expect(flow.getMode()).toBe('navigate');
  const summary = flow.getFlowSummary();
  expect(summary[0].fieldState).toBe('completed');
});

test('edit mode: Escape cancels edit and returns to navigate without saving', () => {
  const flow = new FlowEngine(twoStepFlow);
  flow.setMode('navigate');
  flow.handleKey(parseKey(Buffer.from('\r'))); // Enter edit on 'name'
  flow.handleKey(parseKey(Buffer.from('test'))); // type
  flow.handleKey(parseKey(Buffer.from('\x1b'))); // Escape — cancel edit

  expect(flow.getMode()).toBe('navigate');
  // name should NOT be completed since we cancelled
  const summary = flow.getFlowSummary();
  expect(summary[0].fieldState).toBe('active');
});
```

- [ ] **Step 3: Write test for navigate mode skipping grayed fields**

```typescript
test('navigate mode: arrow skips grayed (conditional false) fields', () => {
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
      condition: () => false,
      onResult: (e, acc) => { acc.admin = e.value; },
    },
    {
      id: 'final',
      label: 'Final',
      createWidget: () => new YesNoPrompt({ prompt: 'Done?', defaultValue: true }),
      onResult: (e, acc) => { acc.done = e.value; },
    },
  ];

  const flow = new FlowEngine(conditionalFlow);
  flow.setMode('navigate');
  flow.handleKey(parseKey(Buffer.from('\x1b[B'))); // Down — should skip admin, land on final
  const summary = flow.getFlowSummary();
  expect(summary[2].fieldState).toBe('active');
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/flow-engine.test.ts`
Expected: FAIL — `setMode`, `getMode`, `mode-change` don't exist

- [ ] **Step 5: Implement two-mode navigation in FlowEngine**

Major rewrite of `src/widgets/flow-engine.ts`. The engine gains:

- `mode: 'navigate' | 'edit'` state
- `setMode(mode)` and `getMode()` methods
- In navigate mode: Up/Down move `currentIndex` (skipping grayed fields), Enter switches to edit mode and instantiates widget
- In edit mode: all keys go to widget. On submit/select/answer: `onResult` fires, mode returns to navigate, field marked completed. On cancel: mode returns to navigate, no change saved.
- `getFlowSummary()` updated: uses `currentIndex` for cursor position regardless of mode. The `fieldState` for the current index is `'active'` in navigate mode, `'editing'` in edit mode.
- Backward compatibility: when `setMode` is never called, FlowEngine behaves exactly as before (sequential wizard). The default mode is `'legacy'` which preserves existing behavior. Only when `setMode('navigate')` is called does the new behavior activate.

```typescript
export type FlowEvent =
  | { type: 'step-complete'; stepId: string; nextStepId: string }
  | { type: 'flow-complete'; results: Record<string, any> }
  | { type: 'flow-cancelled' }
  | { type: 'widget-event'; event: any }
  | { type: 'mode-change'; mode: 'navigate' | 'edit' }
  | { type: 'none' };

export class FlowEngine {
  private steps: FlowStep[];
  private currentIndex: number;
  private accumulated: Record<string, any>;
  private currentWidget: Widget | null;
  private complete: boolean;
  private mode: 'legacy' | 'navigate' | 'edit';
  private completedSteps: Set<number>;

  constructor(steps: FlowStep[], initialState?: Record<string, any>) {
    this.steps = steps;
    this.accumulated = initialState ? { ...initialState } : {};
    this.complete = false;
    this.currentIndex = -1;
    this.currentWidget = null;
    this.mode = 'legacy';
    this.completedSteps = new Set();
    this.advanceToNext();
  }

  setMode(mode: 'navigate' | 'edit'): void {
    this.mode = mode;
    if (mode === 'navigate') {
      // Position cursor on first visible step
      this.currentIndex = this.findNextVisible(-1, 1);
      this.currentWidget = null;
    }
  }

  getMode(): 'legacy' | 'navigate' | 'edit' {
    return this.mode;
  }

  handleKey(key: KeyEvent): FlowEvent {
    if (this.complete) return { type: 'none' };

    if (this.mode === 'legacy') {
      return this.handleLegacyKey(key);
    }
    if (this.mode === 'navigate') {
      return this.handleNavigateKey(key);
    }
    return this.handleEditKey(key);
  }

  private handleLegacyKey(key: KeyEvent): FlowEvent {
    // Original behavior — unchanged
    if (!this.currentWidget) return { type: 'none' };
    const event = this.currentWidget.handleKey(key);
    if (event.type === 'cancel') return { type: 'flow-cancelled' };
    if (event.type === 'submit' || event.type === 'select' || event.type === 'answer') {
      const step = this.steps[this.currentIndex];
      step.onResult(event, this.accumulated);
      const prevStepId = step.id;
      this.advanceToNext();
      if (this.complete) return { type: 'flow-complete', results: this.accumulated };
      return { type: 'step-complete', stepId: prevStepId, nextStepId: this.steps[this.currentIndex].id };
    }
    return { type: 'widget-event', event };
  }

  private handleNavigateKey(key: KeyEvent): FlowEvent {
    if (key.key === 'Up') {
      const prev = this.findNextVisible(this.currentIndex, -1);
      if (prev !== this.currentIndex) {
        this.currentIndex = prev;
        return { type: 'none' }; // re-render handles visual update
      }
      return { type: 'none' };
    }
    if (key.key === 'Down') {
      const next = this.findNextVisible(this.currentIndex, 1);
      if (next !== this.currentIndex) {
        this.currentIndex = next;
        return { type: 'none' };
      }
      return { type: 'none' };
    }
    if (key.key === 'Enter') {
      const step = this.steps[this.currentIndex];
      if (!step) return { type: 'none' };
      // Don't enter edit mode on locked fields
      if (step.condition && !step.condition(this.accumulated)) return { type: 'none' };
      this.currentWidget = step.createWidget(this.accumulated);
      this.mode = 'edit';
      return { type: 'mode-change', mode: 'edit' };
    }
    if (key.key === 'Escape' || key.key === 'CtrlC') {
      return { type: 'flow-cancelled' };
    }
    // Ctrl+S or similar for submit — check validation
    if (key.key === 's' || key.key === 'S') {
      return this.trySubmit();
    }
    return { type: 'none' };
  }

  private handleEditKey(key: KeyEvent): FlowEvent {
    if (!this.currentWidget) return { type: 'none' };
    const event = this.currentWidget.handleKey(key);

    if (event.type === 'cancel') {
      // Cancel edit — return to navigate, discard changes
      this.mode = 'navigate';
      this.currentWidget = null;
      return { type: 'mode-change', mode: 'navigate' };
    }

    if (event.type === 'submit' || event.type === 'select' || event.type === 'answer') {
      const step = this.steps[this.currentIndex];
      step.onResult(event, this.accumulated);
      this.completedSteps.add(this.currentIndex);
      this.mode = 'navigate';
      this.currentWidget = null;
      return { type: 'mode-change', mode: 'navigate' };
    }

    return { type: 'widget-event', event };
  }

  trySubmit(): FlowEvent {
    const missing = this.getMissingRequired();
    if (missing.length > 0) {
      // Jump cursor to first missing required field
      this.currentIndex = missing[0];
      return { type: 'none' }; // caller checks getValidationErrors()
    }
    this.complete = true;
    return { type: 'flow-complete', results: this.accumulated };
  }

  getMissingRequired(): number[] {
    const missing: number[] = [];
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      // Skip grayed/conditional-false steps
      if (step.condition && !step.condition(this.accumulated)) continue;
      if (step.required && !this.completedSteps.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  getFlowSummary(): FlowStepSummary[] {
    if (this.mode === 'legacy') {
      return this.getLegacyFlowSummary();
    }
    const missingSet = new Set(this.getMissingRequired());
    return this.steps.map((step, i) => {
      const base = { id: step.id, label: step.label };
      if (step.condition && !step.condition(this.accumulated)) {
        return { ...base, fieldState: 'grayed' as const };
      }
      if (i === this.currentIndex) {
        const state = this.mode === 'edit' ? 'editing' as const : 'active' as const;
        if (this.completedSteps.has(i)) {
          const value = step.displayValue
            ? step.displayValue(this.accumulated)
            : this.defaultDisplayValue(step.id);
          return { ...base, fieldState: state, value };
        }
        return { ...base, fieldState: state };
      }
      if (this.completedSteps.has(i)) {
        const value = step.displayValue
          ? step.displayValue(this.accumulated)
          : this.defaultDisplayValue(step.id);
        return { ...base, fieldState: 'completed' as const, value };
      }
      return { ...base, fieldState: 'pending' as const };
    });
  }

  private getLegacyFlowSummary(): FlowStepSummary[] {
    return this.steps.map((step, i) => {
      if (i < this.currentIndex) {
        const value = step.displayValue
          ? step.displayValue(this.accumulated)
          : this.defaultDisplayValue(step.id);
        return { id: step.id, label: step.label, fieldState: 'completed' as const, value };
      }
      if (i === this.currentIndex) {
        return { id: step.id, label: step.label, fieldState: 'active' as const };
      }
      if (step.condition && !step.condition(this.accumulated)) {
        return { id: step.id, label: step.label, fieldState: 'grayed' as const };
      }
      return { id: step.id, label: step.label, fieldState: 'pending' as const };
    });
  }

  private findNextVisible(from: number, direction: 1 | -1): number {
    let i = from + direction;
    while (i >= 0 && i < this.steps.length) {
      const step = this.steps[i];
      if (!step.condition || step.condition(this.accumulated)) {
        return i;
      }
      i += direction;
    }
    return from; // no valid step found, stay put
  }

  // ... keep existing getCurrentState, isComplete, getResults, advanceToNext, defaultDisplayValue
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/flow-engine.test.ts`
Expected: All tests PASS (existing legacy tests + new navigate/edit tests)

- [ ] **Step 7: Commit**

```bash
git add src/widgets/flow-engine.ts tests/widgets/flow-engine.test.ts && git commit -m "feat: FlowEngine two-mode navigation — navigate (yellow) / edit (white) with field cursor"
```

---

### Task 5: Validation and submit gate

**Files:**
- Modify: `src/widgets/flow-engine.ts`
- Modify: `tests/widgets/flow-engine.test.ts`

- [ ] **Step 1: Write test for required field validation**

Add to `tests/widgets/flow-engine.test.ts`:

```typescript
test('trySubmit fails when required fields are incomplete', () => {
  const flow: FlowStep[] = [
    {
      id: 'name',
      label: 'Name',
      required: true,
      createWidget: () => new TextInput({ prompt: 'Name' }),
      onResult: (e, acc) => { acc.name = e.value; },
    },
    {
      id: 'optional',
      label: 'Optional',
      createWidget: () => new YesNoPrompt({ prompt: 'Optional?', defaultValue: false }),
      onResult: (e, acc) => { acc.optional = e.value; },
    },
  ];

  const engine = new FlowEngine(flow);
  engine.setMode('navigate');

  const result = engine.trySubmit();
  expect(result.type).toBe('none'); // blocked
  expect(engine.getMissingRequired()).toEqual([0]); // name is missing
});

test('trySubmit succeeds when all required fields are complete', () => {
  const flow: FlowStep[] = [
    {
      id: 'name',
      label: 'Name',
      required: true,
      createWidget: () => new TextInput({ prompt: 'Name' }),
      onResult: (e, acc) => { acc.name = e.value; },
    },
  ];

  const engine = new FlowEngine(flow);
  engine.setMode('navigate');

  // Edit and complete the name field
  engine.handleKey(parseKey(Buffer.from('\r'))); // Enter edit
  engine.handleKey(parseKey(Buffer.from('test')));
  engine.handleKey(parseKey(Buffer.from('\r'))); // Submit field

  const result = engine.trySubmit();
  expect(result.type).toBe('flow-complete');
});

test('getMissingRequired skips grayed conditional fields', () => {
  const flow: FlowStep[] = [
    {
      id: 'name',
      label: 'Name',
      required: true,
      createWidget: () => new TextInput({ prompt: 'Name' }),
      onResult: (e, acc) => { acc.name = e.value; },
    },
    {
      id: 'admin',
      label: 'Admin',
      required: true,
      condition: () => false,
      createWidget: () => new YesNoPrompt({ prompt: 'Admin?', defaultValue: false }),
      onResult: (e, acc) => { acc.admin = e.value; },
    },
  ];

  const engine = new FlowEngine(flow);
  engine.setMode('navigate');

  // Only name is missing — admin is conditional-false so not required
  expect(engine.getMissingRequired()).toEqual([0]);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/flow-engine.test.ts`
Expected: All tests PASS (trySubmit and getMissingRequired were implemented in Task 4)

If any fail, fix the implementation in flow-engine.ts.

- [ ] **Step 3: Commit**

```bash
git add src/widgets/flow-engine.ts tests/widgets/flow-engine.test.ts && git commit -m "feat: FlowEngine validation — required fields, trySubmit gate, getMissingRequired"
```

---

### Task 6: Full-form renderer

**Files:**
- Modify: `src/widgets/renderers.ts`
- Modify: `tests/widgets/renderers.test.ts`

- [ ] **Step 1: Write test for renderFlowForm**

Add to `tests/widgets/renderers.test.ts`:

```typescript
import { renderFlowForm } from '../../src/widgets/renderers.js';
import type { FlowStepSummary } from '../../src/widgets/flow-engine.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/renderers.test.ts`
Expected: FAIL — `renderFlowForm` not exported

- [ ] **Step 3: Implement renderFlowForm and renderInlineWidget**

Add to `src/widgets/renderers.ts`:

```typescript
import { STATE_COLORS, RESET, type WidgetFieldState } from './keys.js';
import type { FlowStepSummary } from './flow-engine.js';

export function renderFlowForm(
  title: string,
  summary: FlowStepSummary[],
  activeWidget: any,
  activeStepId: string,
  invalidIndices?: number[],
): string {
  const invalidSet = new Set(invalidIndices ?? []);
  const parts: string[] = ['\x1b[2J\x1b[H'];
  parts.push(`  \x1b[1m${title}\x1b[0m\r\n`);
  parts.push(`  \x1b[38;5;245m${'─'.repeat(50)}\x1b[0m\r\n\r\n`);

  for (let i = 0; i < summary.length; i++) {
    const step = summary[i];
    const color = STATE_COLORS[step.fieldState];
    const isInvalid = invalidSet.has(i);
    const labelColor = isInvalid ? '\x1b[31m' : color; // red if invalid

    if (step.fieldState === 'editing') {
      parts.push(`\x1b[33m>\x1b[0m ${labelColor}${step.label}:${RESET} `);
      parts.push(renderInlineWidget(activeWidget));
      parts.push('\r\n');
    } else if (step.fieldState === 'active') {
      parts.push(`\x1b[33m>\x1b[0m ${labelColor}${step.label}:${RESET} `);
      if (step.value) {
        parts.push(`${step.value}`);
      } else {
        parts.push(`\x1b[2m[enter to edit]\x1b[0m`);
      }
      parts.push('\r\n');
    } else if (step.fieldState === 'completed') {
      parts.push(`  ${color}${step.label}: ${step.value}${RESET} \u2713\r\n`);
    } else if (step.fieldState === 'grayed') {
      parts.push(`  ${color}${step.label}: ---${RESET}\r\n`);
    } else if (step.fieldState === 'locked') {
      parts.push(`  ${color}\uD83D\uDD12 ${step.label}: ${step.value || ''}${RESET}\r\n`);
    } else {
      // pending
      parts.push(`  ${color}${step.label}: \x1b[2m[default]\x1b[0m${RESET}\r\n`);
    }
  }

  parts.push(`\r\n  \x1b[38;5;245m\u2191\u2193=navigate, enter=edit, s=submit, esc=cancel\x1b[0m\r\n`);
  return parts.join('');
}

function renderInlineWidget(widget: any): string {
  if (!widget) return '';
  if (widget.state?.buffer !== undefined) {
    const display = widget.state.masked ? '*'.repeat(widget.state.buffer.length) : widget.state.buffer;
    return display + '\x1b[K';
  }
  if (widget.state?.defaultValue !== undefined && widget.state?.prompt !== undefined) {
    const yes = widget.state.defaultValue ? 'Y' : 'y';
    const no = widget.state.defaultValue ? 'n' : 'N';
    return `[${yes}/${no}]`;
  }
  if (widget.state?.items) {
    const item = widget.state.items[widget.state.cursor];
    return item ? `[${item.label}] \u2191\u2193` : '';
  }
  return '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/renderers.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/widgets/renderers.ts tests/widgets/renderers.test.ts && git commit -m "feat: renderFlowForm — full-form rendering with field states, inline widgets, validation highlighting"
```

---

## Phase 3: YAML-Driven Session Form (Tasks 7–8)

### Task 7: Session form YAML config + loader

**Files:**
- Create: `src/session-form.yaml`
- Create: `src/session-form.ts`
- Create: `tests/session-form.test.ts`

- [ ] **Step 1: Write the YAML config file**

Create `src/session-form.yaml`:

```yaml
# Session form field definitions
# Each field defines its behavior per mode (create/edit/restart/fork)
# Widget creation and onResult logic are in code — this config controls
# visibility, locking, prefill, and field metadata.

fields:
  - id: name
    label: Session name
    widget: text
    required: true
    modes:
      create:  { visible: true, locked: false }
      edit:    { visible: true, locked: false, prefill: true }
      restart: { visible: true, locked: false, prefill: true }
      fork:    { visible: true, locked: false, prefill: fork-name }

  - id: runas
    label: Run as user
    widget: text
    condition: admin-only
    modes:
      create:  { visible: true, locked: false }
      edit:    { visible: true, locked: true, prefill: true }
      restart: { visible: true, locked: true, prefill: true }
      fork:    { visible: true, locked: true, prefill: true }

  - id: server
    label: Server
    widget: list
    condition: admin-with-remotes
    modes:
      create:  { visible: true, locked: false }
      edit:    { visible: true, locked: true, prefill: true }
      restart: { visible: true, locked: true, prefill: true }
      fork:    { visible: true, locked: true, prefill: true }

  - id: workdir
    label: Working directory
    widget: combo
    modes:
      create:  { visible: true, locked: false }
      edit:    { visible: true, locked: true, prefill: true }
      restart: { visible: true, locked: true, prefill: true }
      fork:    { visible: true, locked: true, prefill: true }

  - id: hidden
    label: Hidden session?
    widget: yesno
    default: false
    modes:
      create:  { visible: true, locked: false }
      edit:    { visible: true, locked: false, prefill: true }
      restart: { visible: true, locked: false, prefill: true }
      fork:    { visible: true, locked: false, prefill: true }

  - id: viewonly
    label: View-only?
    widget: yesno
    default: false
    modes:
      create:  { visible: true, locked: false }
      edit:    { visible: true, locked: false, prefill: true }
      restart: { visible: true, locked: false, prefill: true }
      fork:    { visible: true, locked: false, prefill: true }

  - id: public
    label: Public session?
    widget: yesno
    default: true
    condition: not-hidden
    modes:
      create:  { visible: true, locked: false }
      edit:    { visible: true, locked: false, prefill: true }
      restart: { visible: true, locked: false, prefill: true }
      fork:    { visible: true, locked: false, prefill: true }

  - id: users
    label: Allowed users
    widget: checkbox
    condition: not-hidden-and-not-public
    modes:
      create:  { visible: true, locked: false }
      edit:    { visible: true, locked: false, prefill: true }
      restart: { visible: true, locked: false, prefill: true }
      fork:    { visible: true, locked: false, prefill: true }

  - id: groups
    label: Allowed groups
    widget: checkbox
    condition: not-hidden-and-not-public
    modes:
      create:  { visible: true, locked: false }
      edit:    { visible: true, locked: false, prefill: true }
      restart: { visible: true, locked: false, prefill: true }
      fork:    { visible: true, locked: false, prefill: true }

  - id: password
    label: Password
    widget: text-masked
    modes:
      create:  { visible: true, locked: false }
      edit:    { visible: true, locked: false, prefill: true }
      restart: { visible: true, locked: false, prefill: true }
      fork:    { visible: true, locked: false }

  - id: dangermode
    label: Skip permissions?
    widget: yesno
    default: false
    condition: admin-only
    modes:
      create:  { visible: true, locked: false }
      edit:    { visible: true, locked: false, prefill: true }
      restart: { visible: true, locked: false, prefill: true }
      fork:    { visible: true, locked: false, prefill: true }

  - id: claudeSessionId
    label: Claude session ID
    widget: text
    modes:
      create:  { visible: false }
      edit:    { visible: true, locked: false, prefill: true }
      restart: { visible: true, locked: false, prefill: true }
      fork:    { visible: true, locked: true, prefill: true }
```

- [ ] **Step 2: Write TypeScript types for the config**

Create `src/session-form.ts`:

```typescript
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';
import type { FlowStep } from './widgets/flow-engine.js';
import type { Client } from './types.js';

// --- YAML config types ---

export type SessionFormMode = 'create' | 'edit' | 'restart' | 'fork';

export interface FieldModeConfig {
  visible: boolean;
  locked: boolean;
  prefill?: boolean | string; // true = from session, string = special handler (e.g. 'fork-name')
}

export interface FieldConfig {
  id: string;
  label: string;
  widget: 'text' | 'text-masked' | 'yesno' | 'list' | 'checkbox' | 'combo';
  required?: boolean;
  default?: any;
  condition?: string; // named predicate
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

// For testing — clear cached config
export function _resetConfigCache(): void {
  _cachedConfig = null;
}
```

- [ ] **Step 3: Write test for config loading**

Create `tests/session-form.test.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/session-form.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/session-form.yaml src/session-form.ts tests/session-form.test.ts && git commit -m "feat: session form YAML config — 12 fields × 4 modes, config loader with types"
```

---

### Task 8: Predicate registry + widget factory + buildSessionFormSteps

**Files:**
- Modify: `src/session-form.ts`
- Modify: `tests/session-form.test.ts`

- [ ] **Step 1: Write test for predicate registry**

Add to `tests/session-form.test.ts`:

```typescript
import { getConditionPredicate } from '../src/session-form.js';

test('admin-only predicate checks isAdmin', () => {
  const pred = getConditionPredicate('admin-only');
  expect(pred({ _isAdmin: true })).toBe(true);
  expect(pred({ _isAdmin: false })).toBe(false);
});

test('not-hidden predicate checks accumulated hidden flag', () => {
  const pred = getConditionPredicate('not-hidden');
  expect(pred({ hidden: true })).toBe(false);
  expect(pred({ hidden: false })).toBe(true);
});

test('not-hidden-and-not-public predicate', () => {
  const pred = getConditionPredicate('not-hidden-and-not-public');
  expect(pred({ hidden: false, public: false })).toBe(true);
  expect(pred({ hidden: false, public: true })).toBe(false);
  expect(pred({ hidden: true, public: false })).toBe(false);
});

test('admin-with-remotes predicate', () => {
  const pred = getConditionPredicate('admin-with-remotes');
  expect(pred({ _isAdmin: true, _hasRemotes: true })).toBe(true);
  expect(pred({ _isAdmin: true, _hasRemotes: false })).toBe(false);
  expect(pred({ _isAdmin: false, _hasRemotes: true })).toBe(false);
});

test('undefined condition returns undefined', () => {
  const pred = getConditionPredicate(undefined);
  expect(pred).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /srv/claude-proxy && npx vitest run tests/session-form.test.ts`
Expected: FAIL — `getConditionPredicate` not exported

- [ ] **Step 3: Implement predicate registry**

Add to `src/session-form.ts`:

```typescript
// --- Predicate registry ---
// Maps YAML condition names to runtime predicates.
// Predicates receive the accumulated state which includes
// _isAdmin and _hasRemotes injected at form creation.

type Predicate = (acc: Record<string, any>) => boolean;

const PREDICATES: Record<string, Predicate> = {
  'admin-only': (acc) => acc._isAdmin === true,
  'admin-with-remotes': (acc) => acc._isAdmin === true && acc._hasRemotes === true,
  'not-hidden': (acc) => !acc.hidden,
  'not-hidden-and-not-public': (acc) => !acc.hidden && !acc.public,
};

export function getConditionPredicate(name?: string): Predicate | undefined {
  if (!name) return undefined;
  return PREDICATES[name];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/session-form.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Write test for buildSessionFormSteps**

Add to `tests/session-form.test.ts`:

```typescript
import { buildSessionFormSteps, type SessionFormMode } from '../src/session-form.js';

test('buildSessionFormSteps create mode returns all visible fields', () => {
  const mockClient = { username: 'root', id: 'test', transport: 'ssh' as const, termSize: { cols: 80, rows: 24 }, write: () => {}, lastKeystroke: 0 };
  const steps = buildSessionFormSteps('create', mockClient, {});
  // At minimum: name, hidden, viewonly, password should be present
  const ids = steps.map(s => s.id);
  expect(ids).toContain('name');
  expect(ids).toContain('hidden');
  expect(ids).toContain('password');
  // claudeSessionId should NOT be present (hidden on create)
  expect(ids).not.toContain('claudeSessionId');
});

test('buildSessionFormSteps edit mode locks runas, server, workdir', () => {
  const mockClient = { username: 'root', id: 'test', transport: 'ssh' as const, termSize: { cols: 80, rows: 24 }, write: () => {}, lastKeystroke: 0 };
  const prefill = { name: 'test-session', runAsUser: 'root', workingDir: '/tmp', remoteHost: 'bigserver' };
  const steps = buildSessionFormSteps('edit', mockClient, prefill);

  // Find the workdir step and verify its widget is locked
  const workdir = steps.find(s => s.id === 'workdir');
  expect(workdir).toBeDefined();
  // Create the widget and check its locked state
  const widget = workdir!.createWidget({ _isAdmin: true, _hasRemotes: true });
  expect(widget.state.locked).toBe(true);
});

test('buildSessionFormSteps fork mode prefills name with -fork_01 suffix', () => {
  const mockClient = { username: 'root', id: 'test', transport: 'ssh' as const, termSize: { cols: 80, rows: 24 }, write: () => {}, lastKeystroke: 0 };
  const prefill = { name: 'my-session' };
  const steps = buildSessionFormSteps('fork', mockClient, prefill);

  const nameStep = steps.find(s => s.id === 'name');
  const widget = nameStep!.createWidget({});
  expect(widget.state.buffer).toContain('my-session-fork_');
});
```

- [ ] **Step 6: Implement buildSessionFormSteps with widget factory**

Add to `src/session-form.ts`:

```typescript
import { TextInput } from './widgets/text-input.js';
import { ListPicker } from './widgets/list-picker.js';
import { YesNoPrompt } from './widgets/yes-no.js';
import { CheckboxPicker } from './widgets/checkbox-picker.js';
import { ComboInput } from './widgets/combo-input.js';

// --- Widget factories ---
// Each widget type has a factory that creates the widget with appropriate
// options based on field config, mode config, and prefill data.

interface WidgetContext {
  client: Client;
  config: any;        // app config (for remotes etc.)
  getUsers: () => string[];
  getGroups: () => Array<{ name: string; systemName: string }>;
  getDirItems: (acc: Record<string, any>) => Array<{ label: string }>;
  generateForkName: (baseName: string) => string;
}

export function buildSessionFormSteps(
  mode: SessionFormMode,
  client: Client,
  prefill: Record<string, any>,
  context?: Partial<WidgetContext>,
): FlowStep[] {
  const formConfig = loadSessionFormConfig();
  const steps: FlowStep[] = [];

  for (const field of formConfig.fields) {
    const modeConfig = field.modes[mode];
    if (!modeConfig.visible) continue;

    const step = buildStepFromField(field, modeConfig, mode, client, prefill, context);
    steps.push(step);
  }

  return steps;
}

function buildStepFromField(
  field: FieldConfig,
  modeConfig: FieldModeConfig,
  mode: SessionFormMode,
  client: Client,
  prefill: Record<string, any>,
  context?: Partial<WidgetContext>,
): FlowStep {
  const conditionFn = getConditionPredicate(field.condition);

  return {
    id: field.id,
    label: field.label,
    required: field.required,
    condition: conditionFn,
    createWidget: (acc) => createWidgetForField(field, modeConfig, mode, client, acc, prefill, context),
    onResult: (event, acc) => applyResult(field, event, acc),
    displayValue: (acc) => getDisplayForField(field, acc),
  };
}

function createWidgetForField(
  field: FieldConfig,
  modeConfig: FieldModeConfig,
  mode: SessionFormMode,
  client: Client,
  acc: Record<string, any>,
  prefill: Record<string, any>,
  context?: Partial<WidgetContext>,
): any {
  const locked = modeConfig.locked;
  const initial = resolveInitialValue(field, modeConfig, prefill, context);

  switch (field.widget) {
    case 'text':
      return new TextInput({ prompt: field.label, initial: initial ?? '', locked });

    case 'text-masked':
      return new TextInput({ prompt: field.label, initial: initial ?? '', masked: true, locked });

    case 'yesno':
      return new YesNoPrompt({
        prompt: field.label,
        defaultValue: initial !== undefined ? initial : (field.default ?? false),
        locked,
      });

    case 'list': {
      const items = context?.getDirItems
        ? context.getDirItems(acc)
        : [{ label: '(no items)' }];
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
      const items = context?.getDirItems
        ? [{ label: '~ (home directory)' }, ...context.getDirItems(acc)]
        : [{ label: '~ (home directory)' }];
      // ComboInput doesn't support locked natively — wrap with a locked TextInput showing the value
      if (locked && initial) {
        return new TextInput({ prompt: field.label, initial, locked: true });
      }
      return new ComboInput({ items, prompt: 'Path', title: field.label });
    }

    default:
      return new TextInput({ prompt: field.label, initial: initial ?? '', locked });
  }
}

function resolveInitialValue(
  field: FieldConfig,
  modeConfig: FieldModeConfig,
  prefill: Record<string, any>,
  context?: Partial<WidgetContext>,
): any {
  if (!modeConfig.prefill) return undefined;

  if (modeConfig.prefill === 'fork-name') {
    const baseName = prefill.name || 'session';
    return context?.generateForkName?.(baseName) ?? `${baseName}-fork_01`;
  }

  // Map field IDs to prefill keys (handles the ID vs accumulated key mismatch)
  const FIELD_TO_PREFILL: Record<string, string> = {
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

  const key = FIELD_TO_PREFILL[field.id] ?? field.id;
  return prefill[key];
}

function resolveCheckboxSelection(
  field: FieldConfig,
  prefill: Record<string, any>,
  items: Array<{ label: string }>,
): Set<number> | undefined {
  const FIELD_TO_PREFILL: Record<string, string> = {
    users: 'allowedUsers',
    groups: 'allowedGroups',
  };
  const key = FIELD_TO_PREFILL[field.id] ?? field.id;
  const selected = prefill[key];
  if (!Array.isArray(selected)) return undefined;

  const indices = new Set<number>();
  for (const val of selected) {
    const idx = items.findIndex(item => item.label.startsWith(val));
    if (idx >= 0) indices.add(idx);
  }
  return indices.size > 0 ? indices : undefined;
}

function applyResult(field: FieldConfig, event: any, acc: Record<string, any>): void {
  // Map field results to accumulated keys matching existing convention
  switch (field.id) {
    case 'name': acc.name = event.value; break;
    case 'runas': acc.runAsUser = event.value || acc._defaultUser; break;
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

function getDisplayForField(field: FieldConfig, acc: Record<string, any>): string {
  const FIELD_TO_KEY: Record<string, string> = {
    name: 'name', runas: 'runAsUser', server: 'remoteHost', workdir: 'workingDir',
    hidden: 'hidden', viewonly: 'viewOnly', public: 'public',
    users: 'allowedUsers', groups: 'allowedGroups',
    password: 'password', dangermode: 'dangerousSkipPermissions',
    claudeSessionId: 'claudeSessionId',
  };
  const key = FIELD_TO_KEY[field.id] ?? field.id;
  const val = acc[key];
  if (val === undefined || val === null) return '';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'string') {
    if (field.widget === 'text-masked' && val) return '****';
    return val || '(none)';
  }
  if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : '(none)';
  return String(val);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/session-form.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/session-form.ts tests/session-form.test.ts && git commit -m "feat: buildSessionFormSteps — YAML-driven widget factory, predicate registry, field-to-key mapping"
```

---

## Phase 4: Wire Into Application (Tasks 9–12)

### Task 9: Replace renderCurrentStep + creation flow with SessionForm

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace buildCreateSessionSteps with buildSessionFormSteps**

In `src/index.ts`, replace the 130-line `buildCreateSessionSteps` function (lines 135–265) with a call to `buildSessionFormSteps`:

```typescript
import { buildSessionFormSteps } from './session-form.js';

// Replace buildCreateSessionSteps(client) with:
function startNewSessionFlow(client: Client): void {
  const steps = buildSessionFormSteps('create', client, {}, {
    config,
    getUsers: () => getClaudeUsers().filter(u => u !== client.username),
    getGroups: () => getClaudeGroups(),
    getDirItems: (acc) => {
      const items: Array<{ label: string }> = [];
      const history = dirScanner.getHistory();
      const scanned = acc.remoteHost ? [] : dirScanner.scan();
      const historySet = new Set(history);
      for (const dir of history) items.push({ label: dir });
      for (const dir of scanned) {
        if (!historySet.has(dir)) items.push({ label: dir });
      }
      return items;
    },
  });

  const initialState = {
    _isAdmin: isAdmin(client.username),
    _hasRemotes: (config.remotes?.length ?? 0) > 0,
    _defaultUser: client.username,
    _remotes: config.remotes || [],
    _availableUsers: getClaudeUsers().filter(u => u !== client.username),
    _availableGroups: getClaudeGroups(),
  };

  const flow = new FlowEngine(steps, initialState);
  flow.setMode('navigate');
  creationFlows.set(client.id, { flow });
  renderSessionForm(client);
}
```

- [ ] **Step 2: Replace renderCurrentStep with renderSessionForm**

Replace `renderCurrentStep` (lines 268–287) with:

```typescript
function renderSessionForm(client: Client): void {
  const entry = creationFlows.get(client.id);
  if (!entry) return;

  const summary = entry.flow.getFlowSummary();
  const state = entry.flow.getCurrentState();
  const missing = entry.flow.getMissingRequired();
  const title = entry.isResume ? 'Resume session' : entry.isFork ? 'Fork session' : entry.isEdit ? 'Edit session' : 'New session';

  client.write(renderFlowForm(title, summary, state.widget, state.stepId, missing.length > 0 ? missing : undefined));
}
```

- [ ] **Step 3: Update handleCreationInput for two-mode events**

Update `handleCreationInput` (lines 656–688) to handle `mode-change` events:

```typescript
function handleCreationInput(client: Client, data: Buffer): void {
  const entry = creationFlows.get(client.id);
  if (!entry) return;

  const key = parseKey(data);
  const event = entry.flow.handleKey(key);

  if (event.type === 'flow-complete') {
    creationFlows.delete(client.id);
    finalizeSessionFromResults(client, event.results, entry.isResume);
  } else if (event.type === 'flow-cancelled') {
    creationFlows.delete(client.id);
    showLobby(client);
  } else if (event.type === 'widget-event') {
    const widgetEvent = event.event;
    if (widgetEvent.type === 'tab') {
      const result = tabComplete(widgetEvent.partial || '~');
      const state = entry.flow.getCurrentState();
      if (state.widget && 'setTextBuffer' in state.widget) {
        if (result.completed !== (widgetEvent.partial || '~')) {
          (state.widget as any).setTextBuffer(result.completed);
        }
      }
    }
    renderSessionForm(client);
  } else {
    // mode-change, none, etc — just re-render
    renderSessionForm(client);
  }
}
```

- [ ] **Step 4: Delete old buildCreateSessionSteps function**

Remove lines 135–265 (the old `buildCreateSessionSteps`).

- [ ] **Step 5: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: Build succeeds, all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/index.ts && git commit -m "feat: creation flow uses YAML-driven SessionForm with two-mode navigation"
```

---

### Task 10: Wire edit settings (Ctrl+B e) to SessionForm

**Files:**
- Modify: `src/session-manager.ts`

- [ ] **Step 1: Replace startEditSession with SessionForm in edit mode**

In `src/session-manager.ts`, replace the `startEditSession` method (around line 992) and related edit menu handling with:

```typescript
import { buildSessionFormSteps } from './session-form.js';
import { FlowEngine } from './widgets/flow-engine.js';
import { renderFlowForm } from './widgets/renderers.js';

startEditSession(sessionId: string, client: Client): void {
  const session = this.sessions.get(sessionId);
  if (!session) return;
  if (!this.canUserEditSession(sessionId, client.username)) {
    client.write('\r\n  \x1b[31mYou do not have permission to edit this session.\x1b[0m\r\n');
    return;
  }

  // Detach from PTY while editing
  session.pty.detach(client);

  const prefill = {
    name: session.name,
    runAsUser: session.runAsUser,
    remoteHost: session.remoteHost,
    workingDir: session.workingDir,
    hidden: session.access.hidden,
    viewOnly: session.access.viewOnly,
    public: session.access.public,
    allowedUsers: session.access.allowedUsers,
    allowedGroups: session.access.allowedGroups,
    password: '',  // don't pre-fill actual password hash
    dangerousSkipPermissions: false,
    claudeSessionId: session.metadata?.claudeSessionId,
  };

  const steps = buildSessionFormSteps('edit', client, prefill, { /* context */ });
  const initialState = {
    _isAdmin: this.isAdmin(client.username),
    _hasRemotes: false, // locked on edit anyway
    _defaultUser: client.username,
  };

  const flow = new FlowEngine(steps, initialState);
  flow.setMode('navigate');
  this.editFlows.set(client.id, { flow, sessionId });
  this.renderEditForm(client);
}
```

- [ ] **Step 2: Add editFlows map and rendering**

```typescript
private editFlows = new Map<string, { flow: FlowEngine; sessionId: string }>();

private renderEditForm(client: Client): void {
  const entry = this.editFlows.get(client.id);
  if (!entry) return;
  const summary = entry.flow.getFlowSummary();
  const state = entry.flow.getCurrentState();
  client.write(renderFlowForm('Edit session', summary, state.widget, state.stepId));
}
```

- [ ] **Step 3: Handle flow completion — apply changes to session**

On flow-complete, diff results against current session and apply changes:

```typescript
private applyEditResults(sessionId: string, results: Record<string, any>): void {
  const session = this.sessions.get(sessionId);
  if (!session) return;

  if (results.name !== undefined) session.name = results.name;
  if (results.hidden !== undefined) session.access.hidden = results.hidden;
  if (results.viewOnly !== undefined) session.access.viewOnly = results.viewOnly;
  if (results.public !== undefined) session.access.public = results.public;
  if (results.allowedUsers !== undefined) session.access.allowedUsers = results.allowedUsers;
  if (results.allowedGroups !== undefined) session.access.allowedGroups = results.allowedGroups;
  if (results.password) {
    session.access.passwordHash = this.hashPassword(results.password);
  }
  if (results.claudeSessionId !== undefined) {
    // Update metadata
  }
}
```

- [ ] **Step 4: Update handleInput to route edit flow input**

In the `handleInput` method, add routing for `editFlows`:

```typescript
if (this.editFlows.has(client.id)) {
  this.handleEditFlowInput(sessionId, client, data);
  return;
}
```

- [ ] **Step 5: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: Build succeeds, all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/session-manager.ts && git commit -m "feat: edit settings uses unified SessionForm with two-mode navigation"
```

---

### Task 11: Wire fork to SessionForm + notice screen

**Files:**
- Modify: `src/session-manager.ts`

- [ ] **Step 1: Replace forkSession with SessionForm in fork mode**

Replace the existing `forkSession` method with one that shows SessionForm in fork mode:

```typescript
async startForkFlow(sessionId: string, client: Client): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) return;

  const claudeId = session.metadata?.claudeSessionId ||
    await this.discoverClaudeSessionId(session);

  const prefill = {
    name: session.name,
    runAsUser: session.runAsUser,
    remoteHost: session.remoteHost,
    workingDir: session.workingDir,
    hidden: session.access.hidden,
    viewOnly: session.access.viewOnly,
    public: session.access.public,
    allowedUsers: session.access.allowedUsers,
    allowedGroups: session.access.allowedGroups,
    claudeSessionId: claudeId,
  };

  const steps = buildSessionFormSteps('fork', client, prefill, {
    generateForkName: (base) => this.generateForkName(base),
  });
  const initialState = {
    _isAdmin: this.isAdmin(client.username),
    _hasRemotes: false,
    _defaultUser: client.username,
  };

  session.pty.detach(client);
  const flow = new FlowEngine(steps, initialState);
  flow.setMode('navigate');
  this.forkFlows.set(client.id, { flow, sourceSessionId: sessionId });
  this.renderForkForm(client);
}
```

- [ ] **Step 2: Add fork name uniqueness validation**

```typescript
private generateForkName(baseName: string): string {
  const existingNames = new Set([...this.sessions.values()].map(s => s.name));
  let counter = 1;
  let candidate: string;
  do {
    candidate = `${baseName}-fork_${String(counter).padStart(2, '0')}`;
    counter++;
  } while (existingNames.has(candidate));
  return candidate;
}
```

- [ ] **Step 3: Add notice screen after fork form completion**

On flow-complete from fork form, show a confirmation notice before creating:

```typescript
private showForkNotice(client: Client, sourceName: string, forkName: string): void {
  client.write('\x1b[2J\x1b[H');
  client.write(`  \x1b[1mFork session\x1b[0m\r\n`);
  client.write(`  \x1b[38;5;245m${'─'.repeat(50)}\x1b[0m\r\n\r\n`);
  client.write(`  You are creating a fork of \x1b[33m${sourceName}\x1b[0m\r\n`);
  client.write(`  New session: \x1b[32m${forkName}\x1b[0m\r\n\r\n`);
  client.write(`  Your current session will remain running and\r\n`);
  client.write(`  can be accessed from the lobby.\r\n\r\n`);
  client.write(`  After confirmation you will be placed in the\r\n`);
  client.write(`  forked session.\r\n\r\n`);
  client.write(`  \x1b[1m[Enter]\x1b[0m Create fork    \x1b[1m[Esc]\x1b[0m Cancel\r\n`);
}
```

- [ ] **Step 4: On confirmation, create fork session and enter it**

```typescript
// On Enter at notice screen:
// 1. Create fork session with --resume <claudeId> --fork-session
// 2. Detach client from original
// 3. Attach client to fork
// 4. Schedule Claude ID backfill for fork
```

- [ ] **Step 5: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`

- [ ] **Step 6: Commit**

```bash
git add src/session-manager.ts && git commit -m "feat: fork uses unified SessionForm + notice screen + enters fork session"
```

---

### Task 12: Wire dead session restart + fork from lobby

**Files:**
- Modify: `src/index.ts`
- Modify: `src/lobby.ts`

- [ ] **Step 1: After selecting dead session, show SessionForm in restart mode**

In `src/index.ts`, update the restart flow handler. After the user selects a dead session from the picker, create a SessionForm in restart mode:

```typescript
function startRestartWithForm(client: Client, dead: StoredSession): void {
  const prefill = {
    name: dead.name,
    runAsUser: dead.runAsUser,
    workingDir: dead.workingDir,
    remoteHost: dead.remoteHost,
    hidden: dead.access?.hidden,
    viewOnly: dead.access?.viewOnly,
    public: dead.access?.public,
    allowedUsers: dead.access?.allowedUsers,
    allowedGroups: dead.access?.allowedGroups,
    claudeSessionId: dead.claudeSessionId,
  };

  const steps = buildSessionFormSteps('restart', client, prefill, { /* context */ });
  const initialState = {
    _isAdmin: isAdmin(client.username),
    _hasRemotes: false,
    _defaultUser: client.username,
  };

  const flow = new FlowEngine(steps, initialState);
  flow.setMode('navigate');
  creationFlows.set(client.id, { flow, isResume: true });
  renderSessionForm(client);
}
```

- [ ] **Step 2: Add fork action to lobby menu**

In `src/lobby.ts`, add fork to the actions section:

```typescript
// In buildSections, add to actions:
{ label: 'Fork a session', key: 'f', action: 'fork' }
```

In `handleInput`, add the 'f' shortcut:

```typescript
if (key.key === 'f') return { type: 'select', action: 'fork' };
```

- [ ] **Step 3: Build fork-from-lobby picker in index.ts**

When lobby returns `action: 'fork'`, show a session picker (live and dead sessions with known Claude IDs), then enter SessionForm in fork mode:

```typescript
function startForkFromLobby(client: Client): void {
  const sessions = sessionManager.getActiveSessions();
  const items = sessions.map(s => ({
    label: `${s.name}${s.metadata?.claudeSessionId ? '' : ' (no session ID)'}`,
    disabled: !s.metadata?.claudeSessionId,
  }));
  items.push({ label: 'Enter session ID manually' });

  const picker = new ListPicker({ items, title: 'Select session to fork' });
  forkPickerFlows.set(client.id, { picker, sessions });
  client.write(renderListPicker(picker.state));
}
```

- [ ] **Step 4: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`

- [ ] **Step 5: Manual test — create, edit (Ctrl+B e), fork (Ctrl+B f), restart, fork from lobby**

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/lobby.ts && git commit -m "feat: restart shows edit form for review, fork from lobby with f key"
```

---

## Phase 5: API Endpoints (Tasks 13–15)

### Task 13: Session CRUD endpoints

**Files:**
- Modify: `src/api-server.ts`

- [ ] **Step 1: POST /api/sessions — create session**

```typescript
app.post('/api/sessions', async (req, res) => {
  const { name, runAsUser, workingDir, hidden, viewOnly, public: isPublic,
          allowedUsers, allowedGroups, password, dangerousSkipPermissions } = req.body;
  // Validate required fields
  if (!name) return res.status(400).json({ error: 'name is required' });
  // Create session via sessionManager
  const access: SessionAccess = {
    owner: req.user?.username || 'root',
    hidden: hidden ?? false,
    public: isPublic ?? true,
    allowedUsers: allowedUsers ?? [],
    allowedGroups: allowedGroups ?? [],
    passwordHash: password ? hashPassword(password) : null,
    viewOnly: viewOnly ?? false,
    admins: [],
  };
  const session = await sessionManager.createSession({ name, runAsUser, workingDir, access, dangerousSkipPermissions });
  res.json({ id: session.id, name: session.name });
});
```

- [ ] **Step 2: DELETE /api/sessions/:id**

```typescript
app.delete('/api/sessions/:id', (req, res) => {
  const result = sessionManager.destroySession(req.params.id);
  if (!result) return res.status(404).json({ error: 'session not found' });
  res.json({ ok: true });
});
```

- [ ] **Step 3: GET /api/sessions/:id/settings**

```typescript
app.get('/api/sessions/:id/settings', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json({
    name: session.name,
    runAsUser: session.runAsUser,
    workingDir: session.workingDir,
    access: session.access,
  });
});
```

- [ ] **Step 4: PATCH /api/sessions/:id/settings**

```typescript
app.patch('/api/sessions/:id/settings', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  // Apply allowed changes (not runas, server, workdir — locked on edit)
  const { name, hidden, viewOnly, public: isPublic, allowedUsers, allowedGroups, password } = req.body;
  if (name !== undefined) session.name = name;
  if (hidden !== undefined) session.access.hidden = hidden;
  if (viewOnly !== undefined) session.access.viewOnly = viewOnly;
  if (isPublic !== undefined) session.access.public = isPublic;
  if (allowedUsers !== undefined) session.access.allowedUsers = allowedUsers;
  if (allowedGroups !== undefined) session.access.allowedGroups = allowedGroups;
  if (password) session.access.passwordHash = hashPassword(password);
  res.json({ ok: true });
});
```

- [ ] **Step 5: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`

- [ ] **Step 6: Commit**

```bash
git add src/api-server.ts && git commit -m "feat: session CRUD API endpoints — create, delete, get/patch settings"
```

---

### Task 14: Restart and fork endpoints

**Files:**
- Modify: `src/api-server.ts`

- [ ] **Step 1: GET /api/sessions/dead — list dead sessions**

```typescript
app.get('/api/sessions/dead', (req, res) => {
  const dead = sessionManager.getDeadSessions();
  res.json(dead.map(s => ({
    id: s.id, name: s.name, claudeSessionId: s.claudeSessionId,
    workingDir: s.workingDir, remoteHost: s.remoteHost,
  })));
});
```

- [ ] **Step 2: POST /api/sessions/:id/restart**

```typescript
app.post('/api/sessions/:id/restart', async (req, res) => {
  const { settings } = req.body; // reviewed settings from form
  const result = await sessionManager.restartSession(req.params.id, settings);
  if (!result) return res.status(404).json({ error: 'dead session not found' });
  res.json({ id: result.id, name: result.name });
});
```

- [ ] **Step 3: POST /api/sessions/:id/fork**

```typescript
app.post('/api/sessions/:id/fork', async (req, res) => {
  const { settings } = req.body;
  const result = await sessionManager.forkSessionFromApi(req.params.id, settings);
  if (!result) return res.status(400).json({ error: 'fork failed — no claude session ID' });
  res.json({ id: result.id, name: result.name });
});
```

- [ ] **Step 4: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add src/api-server.ts && git commit -m "feat: restart and fork API endpoints"
```

---

### Task 15: Supporting endpoints

**Files:**
- Modify: `src/api-server.ts`

- [ ] **Step 1: GET /api/remotes**

```typescript
app.get('/api/remotes', (req, res) => {
  res.json(config.remotes || []);
});
```

- [ ] **Step 2: POST /api/remotes/:host/check-path**

```typescript
app.post('/api/remotes/:host/check-path', async (req, res) => {
  const { path } = req.body;
  // SSH to remote, check if path exists
  // Return { exists: boolean, isDirectory: boolean }
});
```

- [ ] **Step 3: GET /api/users**

```typescript
app.get('/api/users', (req, res) => {
  res.json(getClaudeUsers());
});
```

- [ ] **Step 4: GET /api/groups**

```typescript
app.get('/api/groups', (req, res) => {
  res.json(getClaudeGroups());
});
```

- [ ] **Step 5: POST /api/export**

```typescript
app.post('/api/export', async (req, res) => {
  const { sessionIds } = req.body;
  const zip = await createExportZip(sessionIds);
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename=sessions-export.zip');
  res.send(zip);
});
```

- [ ] **Step 6: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`

- [ ] **Step 7: Commit**

```bash
git add src/api-server.ts && git commit -m "feat: supporting API endpoints — remotes, users, groups, export"
```
