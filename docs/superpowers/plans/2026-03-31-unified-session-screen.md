# Unified Session Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One screen for creating, editing, restarting, and forking sessions. Full-form rendering with widget states (active/completed/locked/grayed/pending). All SSH features get corresponding API endpoints.

**Architecture:** Add widget states to existing widget system. Build a SessionForm composite widget that renders all fields at once. Reuse it for create, edit, restart, and fork flows — each pre-fills differently. API endpoints mirror each operation.

**Tech Stack:** TypeScript, vitest, existing widget system at `src/widgets/`

**Handoff:** `docs/superpowers/plans/2026-03-31-handoff-todos-v3.md`

---

## Phase 1: Widget States (Tasks 1-2)

### Task 1: Add widget states to base types

**Files:**
- Modify: `src/widgets/keys.ts`
- Modify: `src/widgets/renderers.ts`
- Create: `tests/widgets/widget-states.test.ts`

- [ ] **Step 1: Add WidgetFieldState type to keys.ts**

```typescript
// Add to src/widgets/keys.ts
export type WidgetFieldState = 'active' | 'completed' | 'locked' | 'grayed' | 'pending';

export const STATE_COLORS: Record<WidgetFieldState, string> = {
  active: '\x1b[1m',              // bold white
  completed: '\x1b[32m',          // green
  locked: '\x1b[33;2m',           // yellow dim
  grayed: '\x1b[38;5;245m',       // dark gray
  pending: '\x1b[2m',             // dim white
};

export const RESET = '\x1b[0m';
```

- [ ] **Step 2: Write tests for state rendering**

```typescript
// tests/widgets/widget-states.test.ts
import { test, expect } from 'vitest';
import { STATE_COLORS, RESET, type WidgetFieldState } from '../../src/widgets/keys.js';

test('all five states have colors', () => {
  const states: WidgetFieldState[] = ['active', 'completed', 'locked', 'grayed', 'pending'];
  for (const s of states) {
    expect(STATE_COLORS[s]).toBeTruthy();
    expect(STATE_COLORS[s].startsWith('\x1b[')).toBe(true);
  }
});

test('RESET is ESC[0m', () => {
  expect(RESET).toBe('\x1b[0m');
});
```

- [ ] **Step 3: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/widget-states.test.ts`
Expected: 2 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/widgets/keys.ts tests/widgets/widget-states.test.ts && git commit -m "feat: widget field states — active, completed, locked, grayed, pending with ANSI colors"
```

---

### Task 2: Add locked/grayed handling to widgets

**Files:**
- Modify: `src/widgets/list-picker.ts`
- Modify: `src/widgets/text-input.ts`
- Modify: `src/widgets/yes-no.ts`
- Modify: `tests/widgets/list-picker.test.ts`
- Modify: `tests/widgets/text-input.test.ts`

- [ ] **Step 1: Add `locked` option to ListPicker**

When `locked: true`, handleKey returns `{ type: 'none' }` for all inputs except Escape/cancel. The picker renders but doesn't respond to navigation or selection.

- [ ] **Step 2: Add `locked` option to TextInput**

When `locked: true`, handleKey returns `{ type: 'none' }` for typing/backspace. Only cancel works.

- [ ] **Step 3: Add `locked` option to YesNoPrompt**

When `locked: true`, handleKey returns `{ type: 'none' }` for y/n/enter. Only cancel works.

- [ ] **Step 4: Write tests for locked behavior**

```typescript
// Add to tests/widgets/list-picker.test.ts
test('locked picker ignores all input except cancel', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }], locked: true });
  expect(lp.handleKey(parseKey(Buffer.from('\x1b[B'))).type).toBe('none');
  expect(lp.handleKey(parseKey(Buffer.from('\r'))).type).toBe('none');
  expect(lp.handleKey(parseKey(Buffer.from('\x1b'))).type).toBe('cancel');
});

// Add to tests/widgets/text-input.test.ts
test('locked input ignores typing', () => {
  const ti = new TextInput({ prompt: 'ID', locked: true, initial: 'abc-123' });
  expect(ti.handleKey(parseKey(Buffer.from('x'))).type).toBe('none');
  expect(ti.state.buffer).toBe('abc-123');
  expect(ti.handleKey(parseKey(Buffer.from('\x1b'))).type).toBe('cancel');
});
```

- [ ] **Step 5: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/widgets/ tests/widgets/ && git commit -m "feat: locked state for widgets — ignores input except cancel"
```

---

## Phase 2: SessionForm Widget (Tasks 3-5)

### Task 3: FlowEngine full-form state

**Files:**
- Modify: `src/widgets/flow-engine.ts`
- Modify: `tests/widgets/flow-engine.test.ts`

- [ ] **Step 1: Add getFlowSummary() to FlowEngine**

Returns all steps with their state and accumulated values:

```typescript
interface FlowStepSummary {
  id: string;
  label: string;
  fieldState: WidgetFieldState;  // active, completed, pending, grayed
  value?: string;                // display value for completed steps
}

getFlowSummary(): FlowStepSummary[] {
  return this.steps.map((step, i) => {
    if (i < this.currentIndex) {
      return { id: step.id, label: step.label, fieldState: 'completed', value: this.getDisplayValue(step.id) };
    }
    if (i === this.currentIndex) {
      return { id: step.id, label: step.label, fieldState: 'active' };
    }
    // Future step — check condition
    if (step.condition && !step.condition(this.accumulated)) {
      return { id: step.id, label: step.label, fieldState: 'grayed' };
    }
    return { id: step.id, label: step.label, fieldState: 'pending' };
  });
}
```

- [ ] **Step 2: Add getDisplayValue() helper**

Returns a human-readable string for each accumulated result:

```typescript
private getDisplayValue(stepId: string): string {
  const val = this.accumulated[stepId];
  if (val === undefined || val === null) return '';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'string') return val || '(default)';
  if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : '(none)';
  return String(val);
}
```

Note: `onResult` currently writes to arbitrary keys in accumulated. For `getDisplayValue` to work, the step definitions should use `stepId` as the key, or we store display values separately. The simplest approach: `onResult` stores a `_display_<stepId>` key alongside the actual value.

- [ ] **Step 3: Write tests**

```typescript
test('getFlowSummary shows completed, active, and pending steps', () => {
  const flow = new FlowEngine(twoStepFlow);
  flow.handleKey(parseKey(Buffer.from('test')));
  flow.handleKey(parseKey(Buffer.from('\r'))); // complete step 1

  const summary = flow.getFlowSummary();
  expect(summary[0].fieldState).toBe('completed');
  expect(summary[1].fieldState).toBe('active');
});

test('getFlowSummary grays out conditional steps', () => {
  const flow = new FlowEngine(conditionalFlow); // isAdmin not set
  const summary = flow.getFlowSummary();
  const adminStep = summary.find(s => s.id === 'admin-only');
  expect(adminStep?.fieldState).toBe('grayed');
});
```

- [ ] **Step 4: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/flow-engine.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/widgets/flow-engine.ts tests/widgets/flow-engine.test.ts && git commit -m "feat: FlowEngine.getFlowSummary() — all steps with states for full-form rendering"
```

---

### Task 4: Full-form renderer

**Files:**
- Modify: `src/widgets/renderers.ts`
- Modify: `tests/widgets/renderers.test.ts`

- [ ] **Step 1: Add renderFlowForm() function**

Takes a FlowStepSummary array + the current widget, renders ALL steps at once:

```typescript
export function renderFlowForm(
  title: string,
  summary: FlowStepSummary[],
  activeWidget: any,  // current widget for active step
  activeStepId: string,
): string {
  const parts: string[] = ['\x1b[2J\x1b[H'];
  parts.push(`  \x1b[1m${title}\x1b[0m\r\n`);
  parts.push(`  \x1b[38;5;245m${'─'.repeat(50)}\x1b[0m\r\n\r\n`);

  for (const step of summary) {
    const color = STATE_COLORS[step.fieldState];
    const prefix = step.fieldState === 'active' ? '\x1b[33m>\x1b[0m' : ' ';

    if (step.fieldState === 'active') {
      // Render the active widget inline
      parts.push(`${prefix} ${color}${step.label}:${RESET} `);
      parts.push(renderInlineWidget(activeWidget));
      parts.push('\r\n');
    } else if (step.fieldState === 'completed') {
      parts.push(`${prefix} ${color}${step.label}: ${step.value}${RESET} ✓\r\n`);
    } else if (step.fieldState === 'grayed') {
      parts.push(`  ${color}${step.label}: ---${RESET}\r\n`);
    } else if (step.fieldState === 'locked') {
      parts.push(`  ${color}🔒 ${step.label}: ${step.value || ''}${RESET}\r\n`);
    } else {
      // pending
      parts.push(`  ${color}${step.label}: [default]${RESET}\r\n`);
    }
  }

  parts.push(`\r\n  \x1b[38;5;245menter=confirm, esc/ctrl-c/q=cancel\x1b[0m\r\n`);
  return parts.join('');
}
```

- [ ] **Step 2: Add renderInlineWidget() helper**

Renders the active widget's input state as a single line (not full screen):

```typescript
function renderInlineWidget(widget: any): string {
  if (widget.state?.buffer !== undefined) {
    // TextInput or similar
    const display = widget.state.masked ? '*'.repeat(widget.state.buffer.length) : widget.state.buffer;
    return display + '\x1b[K';  // clear to end of line
  }
  if (widget.state?.defaultValue !== undefined) {
    // YesNoPrompt
    const yes = widget.state.defaultValue ? 'Y' : 'y';
    const no = widget.state.defaultValue ? 'n' : 'N';
    return `[${yes}/${no}]`;
  }
  if (widget.state?.items) {
    // ListPicker — show current selection
    const item = widget.state.items[widget.state.cursor];
    return item ? `[${item.label}] ↑↓` : '';
  }
  return '';
}
```

- [ ] **Step 3: Write tests**

```typescript
test('renderFlowForm shows all steps with correct states', () => {
  const summary = [
    { id: 'name', label: 'Session name', fieldState: 'completed' as const, value: 'my-project' },
    { id: 'hidden', label: 'Hidden', fieldState: 'active' as const },
    { id: 'public', label: 'Public', fieldState: 'pending' as const },
    { id: 'users', label: 'Users', fieldState: 'grayed' as const },
  ];
  const mockWidget = { state: { defaultValue: false, prompt: 'Hidden?' } };
  const output = renderFlowForm('New session', summary, mockWidget, 'hidden');
  expect(output).toContain('my-project');
  expect(output).toContain('✓');
  expect(output).toContain('>');
  expect(output).toContain('---');
});
```

- [ ] **Step 4: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/renderers.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/widgets/renderers.ts tests/widgets/renderers.test.ts && git commit -m "feat: renderFlowForm — full-form rendering with widget states"
```

---

### Task 5: Replace renderCurrentStep with renderFlowForm

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update renderCurrentStep to use full-form rendering**

Replace the current single-widget rendering with:

```typescript
function renderCurrentStep(client: Client): void {
  const entry = creationFlows.get(client.id);
  if (!entry) return;

  const state = entry.flow.getCurrentState();
  const summary = entry.flow.getFlowSummary();
  const title = entry.isResume ? 'Resume session' : 'New session';

  client.write(renderFlowForm(title, summary, state.widget, state.stepId));
}
```

- [ ] **Step 2: Update buildCreateSessionSteps to store display values**

Each `onResult` should also store a display-friendly value:

```typescript
onResult: (e, acc) => {
  acc.name = e.value;
  acc._display_name = e.value;  // for full-form rendering
},
```

- [ ] **Step 3: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`

- [ ] **Step 4: Manual test via SSH — create a session, verify all fields visible**

- [ ] **Step 5: Commit**

```bash
git add src/index.ts && git commit -m "feat: creation flow uses full-form rendering — all fields visible at once"
```

---

## Phase 3: Unified Edit Screen (Tasks 6-8)

### Task 6: Build SessionForm as reusable FlowEngine config

**Files:**
- Create: `src/session-form.ts`
- Create: `tests/session-form.test.ts`

- [ ] **Step 1: Create buildSessionFormSteps()**

A function that returns FlowStep[] for the session form. Accepts a `mode` parameter:

```typescript
type SessionFormMode = 'create' | 'edit' | 'restart' | 'fork';

function buildSessionFormSteps(
  mode: SessionFormMode,
  client: Client,
  prefill?: Record<string, any>,
): FlowStep[] {
  // Same fields as buildCreateSessionSteps, but:
  // - 'edit' mode: session name is editable, Claude session ID is editable
  // - 'fork' mode: name pre-filled as X-fork_01, session ID locked
  // - 'restart' mode: all fields pre-filled from dead session metadata
  // - 'create' mode: same as current
}
```

- [ ] **Step 2: Add Claude session ID as a field**

New step in the form — only for edit/fork/restart modes:

```typescript
{
  id: 'claudeSessionId',
  label: 'Claude session ID',
  createWidget: (acc) => new TextInput({
    prompt: 'Claude session ID',
    initial: acc.claudeSessionId || '',
    locked: mode === 'fork',  // locked on fork, editable on edit/restart
  }),
  condition: () => mode !== 'create',  // not shown on create
  onResult: (e, acc) => { acc.claudeSessionId = e.value; },
}
```

- [ ] **Step 3: Write tests**

Test that each mode produces the right steps with right pre-fills and locked states.

- [ ] **Step 4: Commit**

```bash
git add src/session-form.ts tests/session-form.test.ts && git commit -m "feat: SessionForm — unified create/edit/restart/fork form definition"
```

---

### Task 7: Wire edit settings (Ctrl+B e) to SessionForm

**Files:**
- Modify: `src/session-manager.ts`

- [ ] **Step 1: Replace startEditSession with SessionForm in edit mode**

Instead of the current ListPicker menu with sub-editors, use:

```typescript
const steps = buildSessionFormSteps('edit', client, {
  name: session.name,
  workingDir: session.workingDir,
  hidden: session.access.hidden,
  viewOnly: session.access.viewOnly,
  // ... all current settings
  claudeSessionId: meta?.claudeSessionId,
});
const flow = new FlowEngine(steps, prefill);
```

- [ ] **Step 2: Handle flow completion — apply changes to session**

On flow-complete, diff the results against current settings and apply changes.

- [ ] **Step 3: Build and test**

- [ ] **Step 4: Manual test — Ctrl+B e in a session**

- [ ] **Step 5: Commit**

```bash
git add src/session-manager.ts && git commit -m "feat: edit settings uses unified SessionForm"
```

---

### Task 8: Wire fork to SessionForm + notice screen

**Files:**
- Modify: `src/session-manager.ts`

- [ ] **Step 1: Replace forkSession with SessionForm in fork mode**

Pre-fill name as `sessionname-fork_01`, lock Claude session ID, pre-fill all settings from source.

- [ ] **Step 2: Add notice screen before fork creation**

After form completion, show:
```
NOTICE: You are creating a fork of "session-name".
Your current session will remain running and can be
accessed from the lobby.

After this confirmation you will be in the forked
session to confirm it was created and working.

[Create Fork] (press Enter)
```

- [ ] **Step 3: Create fork and send user into it**

On confirmation:
1. Create the fork session with `--resume <id> --fork-session`
2. Leave original session (detach client)
3. Join fork session (attach client)
4. Schedule Claude ID backfill for the fork

- [ ] **Step 4: Build and test**

- [ ] **Step 5: Manual test — Ctrl+B f in a session**

- [ ] **Step 6: Commit**

```bash
git add src/session-manager.ts && git commit -m "feat: fork uses unified SessionForm + notice screen + enters fork"
```

---

## Phase 4: Restart Flow (Tasks 9-10)

### Task 9: Wire dead session restart to SessionForm

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: After selecting dead session from restart picker, show SessionForm**

Replace the current `resumeIdFlow` transition with:

```typescript
const steps = buildSessionFormSteps('restart', client, {
  name: dead.name,
  workingDir: dead.workingDir,
  hidden: dead.access.hidden,
  // ... all stored settings
  claudeSessionId: dead.claudeSessionId,
});
```

User reviews security settings before session starts.

- [ ] **Step 2: On flow completion, create session with reviewed settings**

- [ ] **Step 3: Deep scan → session ID prompt still available**

Deep scan path: TextInput for session ID → if provided, pre-fill in SessionForm → then same flow.

- [ ] **Step 4: Remove old resumeIdFlow** (replaced by SessionForm with claudeSessionId field)

- [ ] **Step 5: Build and test**

- [ ] **Step 6: Commit**

```bash
git add src/index.ts && git commit -m "feat: dead session restart shows edit screen for security review"
```

---

### Task 10: Fork from lobby

**Files:**
- Modify: `src/index.ts`
- Modify: `src/lobby.ts`

- [ ] **Step 1: Add `f` key to lobby menu**

New menu item: `{ label: 'Fork a session', key: 'f', action: 'fork' }`

- [ ] **Step 2: Build fork picker**

Show sessions with known Claude session IDs (from metadata). Include live and dead sessions. Also include "Enter session ID manually" option at bottom.

- [ ] **Step 3: On select, show SessionForm in fork mode**

Pre-fill from selected session, same flow as Ctrl+B f.

- [ ] **Step 4: Build and test**

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/lobby.ts && git commit -m "feat: fork from lobby — pick session or enter ID"
```

---

## Phase 5: API Endpoints (Tasks 11-13)

### Task 11: Session CRUD endpoints

**Files:**
- Modify: `src/api-server.ts`

- [ ] **Step 1: POST /api/sessions — create session**

Accept JSON body with all session form fields. Call sessionManager.createSession().

- [ ] **Step 2: DELETE /api/sessions/:id — destroy session**

- [ ] **Step 3: GET /api/sessions/:id/settings — get settings**

- [ ] **Step 4: PATCH /api/sessions/:id/settings — update settings**

- [ ] **Step 5: Build and test**

- [ ] **Step 6: Commit**

```bash
git add src/api-server.ts && git commit -m "feat: session CRUD API endpoints — create, delete, get/patch settings"
```

---

### Task 12: Restart and fork endpoints

**Files:**
- Modify: `src/api-server.ts`

- [ ] **Step 1: GET /api/sessions/dead — list dead sessions**

- [ ] **Step 2: POST /api/sessions/:id/restart — restart dead session**

Accept JSON body with reviewed settings.

- [ ] **Step 3: POST /api/sessions/:id/fork — fork a session**

Accept JSON body with fork settings. Returns the new session ID.

- [ ] **Step 4: Build and test**

- [ ] **Step 5: Commit**

```bash
git add src/api-server.ts && git commit -m "feat: restart and fork API endpoints"
```

---

### Task 13: Supporting endpoints

**Files:**
- Modify: `src/api-server.ts`

- [ ] **Step 1: GET /api/remotes — list configured remote hosts**

- [ ] **Step 2: POST /api/remotes/:host/check-path — check path exists on remote**

- [ ] **Step 3: GET /api/users — list available users**

- [ ] **Step 4: GET /api/groups — list available groups**

- [ ] **Step 5: POST /api/export — export sessions as zip**

- [ ] **Step 6: Build and test**

- [ ] **Step 7: Commit**

```bash
git add src/api-server.ts && git commit -m "feat: supporting API endpoints — remotes, users, groups, export"
```
