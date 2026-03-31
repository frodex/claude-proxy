# TUI Widget System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 14+ duplicated menu/picker/input handlers with composable widget objects and a flow engine.

**Architecture:** Six widget types built incrementally — leaf widgets first (ListPicker, TextInput, YesNoPrompt), then compound widgets (CheckboxPicker, ComboInput), then FlowEngine. Each widget is a state machine that receives normalized KeyEvents and emits typed events. ANSI renderers are separate functions. Migration replaces inline handlers in index.ts and session-manager.ts.

**Tech Stack:** TypeScript, vitest

**Spec:** `docs/superpowers/specs/2026-03-31-widget-system-design.md`

---

## Phase 1: Widget Library (Tasks 1-8)

Pure additions. No existing code modified. Each task creates new files only.

---

### Task 1: Key Normalization

**Files:**
- Create: `src/widgets/keys.ts`
- Create: `tests/widgets/keys.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/widgets/keys.test.ts
import { test, expect } from 'vitest';
import { parseKey } from '../src/widgets/keys.js';

test('CSI arrow up', () => {
  const e = parseKey(Buffer.from('\x1b[A'));
  expect(e.key).toBe('Up');
});

test('SS3 arrow up', () => {
  const e = parseKey(Buffer.from('\x1bOA'));
  expect(e.key).toBe('Up');
});

test('CSI arrow down', () => {
  expect(parseKey(Buffer.from('\x1b[B')).key).toBe('Down');
});

test('SS3 arrow down', () => {
  expect(parseKey(Buffer.from('\x1bOB')).key).toBe('Down');
});

test('CSI arrow right', () => {
  expect(parseKey(Buffer.from('\x1b[C')).key).toBe('Right');
});

test('SS3 arrow right', () => {
  expect(parseKey(Buffer.from('\x1bOC')).key).toBe('Right');
});

test('CSI arrow left', () => {
  expect(parseKey(Buffer.from('\x1b[D')).key).toBe('Left');
});

test('SS3 arrow left', () => {
  expect(parseKey(Buffer.from('\x1bOD')).key).toBe('Left');
});

test('enter (\\r)', () => {
  expect(parseKey(Buffer.from('\r')).key).toBe('Enter');
});

test('enter (\\n)', () => {
  expect(parseKey(Buffer.from('\n')).key).toBe('Enter');
});

test('space', () => {
  expect(parseKey(Buffer.from(' ')).key).toBe('Space');
});

test('escape (single byte)', () => {
  expect(parseKey(Buffer.from('\x1b')).key).toBe('Escape');
});

test('escape sequence is not Escape', () => {
  // Multi-byte escape sequences should not be 'Escape'
  expect(parseKey(Buffer.from('\x1b[A')).key).not.toBe('Escape');
});

test('backspace (0x7f)', () => {
  expect(parseKey(Buffer.from('\x7f')).key).toBe('Backspace');
});

test('backspace (0x08)', () => {
  expect(parseKey(Buffer.from('\b')).key).toBe('Backspace');
});

test('tab', () => {
  expect(parseKey(Buffer.from('\t')).key).toBe('Tab');
});

test('printable character', () => {
  const e = parseKey(Buffer.from('a'));
  expect(e.key).toBe('a');
});

test('printable multi-char (paste)', () => {
  const e = parseKey(Buffer.from('hello'));
  expect(e.key).toBe('hello');
});

test('raw is preserved', () => {
  const e = parseKey(Buffer.from('\x1b[A'));
  expect(e.raw).toBe('\x1b[A');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/keys.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement parseKey**

```typescript
// src/widgets/keys.ts

export type KeyName = 'Up' | 'Down' | 'Left' | 'Right' | 'Enter' | 'Space' |
  'Escape' | 'Backspace' | 'Tab' | string;

export interface KeyEvent {
  key: KeyName;
  raw: string;
}

export function parseKey(data: Buffer): KeyEvent {
  const str = data.toString();

  // Arrow keys — both CSI (\x1b[) and SS3 (\x1bO) variants
  if (str === '\x1b[A' || str === '\x1bOA') return { key: 'Up', raw: str };
  if (str === '\x1b[B' || str === '\x1bOB') return { key: 'Down', raw: str };
  if (str === '\x1b[C' || str === '\x1bOC') return { key: 'Right', raw: str };
  if (str === '\x1b[D' || str === '\x1bOD') return { key: 'Left', raw: str };

  // Control keys
  if (str === '\r' || str === '\n') return { key: 'Enter', raw: str };
  if (str === ' ') return { key: 'Space', raw: str };
  if (str === '\x1b' && data.length === 1) return { key: 'Escape', raw: str };
  if (str === '\x7f' || str === '\b') return { key: 'Backspace', raw: str };
  if (str === '\t') return { key: 'Tab', raw: str };

  // Everything else — printable characters or paste
  return { key: str, raw: str };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/keys.test.ts`
Expected: All 19 tests PASS

- [ ] **Step 5: Run all tests**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /srv/claude-proxy && git add src/widgets/keys.ts tests/widgets/keys.test.ts && git commit -m "feat: parseKey — normalize terminal bytes to KeyEvent (both arrow variants)"
```

---

### Task 2: ListPicker

**Files:**
- Create: `src/widgets/list-picker.ts`
- Create: `tests/widgets/list-picker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/widgets/list-picker.test.ts
import { test, expect } from 'vitest';
import { ListPicker } from '../src/widgets/list-picker.js';
import { parseKey } from '../src/widgets/keys.js';

test('initial cursor is 0', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  expect(lp.state.cursor).toBe(0);
});

test('Down moves cursor forward', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  lp.handleKey(parseKey(Buffer.from('\x1b[B')));
  expect(lp.state.cursor).toBe(1);
});

test('Up wraps to last item from first', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] });
  lp.handleKey(parseKey(Buffer.from('\x1b[A')));
  expect(lp.state.cursor).toBe(2);
});

test('Down wraps to first item from last', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  lp.handleKey(parseKey(Buffer.from('\x1b[B')));
  lp.handleKey(parseKey(Buffer.from('\x1b[B')));
  expect(lp.state.cursor).toBe(0);
});

test('Down skips disabled items', () => {
  const lp = new ListPicker({ items: [
    { label: 'A' },
    { label: 'B', disabled: true },
    { label: 'C' },
  ]});
  lp.handleKey(parseKey(Buffer.from('\x1b[B')));
  expect(lp.state.cursor).toBe(2);
});

test('Enter returns select event', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  lp.handleKey(parseKey(Buffer.from('\x1b[B')));
  const event = lp.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'select', index: 1 });
});

test('Escape returns cancel event', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }] });
  const event = lp.handleKey(parseKey(Buffer.from('\x1b')));
  expect(event).toEqual({ type: 'cancel' });
});

test('Space returns select event', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }] });
  const event = lp.handleKey(parseKey(Buffer.from(' ')));
  expect(event).toEqual({ type: 'select', index: 0 });
});

test('SS3 arrow keys work', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  lp.handleKey(parseKey(Buffer.from('\x1bOB')));
  expect(lp.state.cursor).toBe(1);
  lp.handleKey(parseKey(Buffer.from('\x1bOA')));
  expect(lp.state.cursor).toBe(0);
});

test('navigate event includes new cursor position', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  const event = lp.handleKey(parseKey(Buffer.from('\x1b[B')));
  expect(event).toEqual({ type: 'navigate', cursor: 1 });
});

test('unrecognized key returns none', () => {
  const lp = new ListPicker({ items: [{ label: 'A' }] });
  const event = lp.handleKey(parseKey(Buffer.from('x')));
  expect(event).toEqual({ type: 'none' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/list-picker.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement ListPicker**

```typescript
// src/widgets/list-picker.ts
import type { KeyEvent } from './keys.js';

export interface ListPickerItem {
  label: string;
  disabled?: boolean;
}

export interface ListPickerState {
  items: ListPickerItem[];
  cursor: number;
  title?: string;
  hint?: string;
}

export type ListPickerEvent =
  | { type: 'navigate'; cursor: number }
  | { type: 'select'; index: number }
  | { type: 'cancel' }
  | { type: 'none' };

export class ListPicker {
  state: ListPickerState;

  constructor(options: { items: ListPickerItem[]; title?: string; hint?: string }) {
    this.state = {
      items: options.items,
      cursor: 0,
      title: options.title,
      hint: options.hint,
    };
  }

  handleKey(key: KeyEvent): ListPickerEvent {
    const total = this.state.items.length;
    if (total === 0) return { type: 'none' };

    if (key.key === 'Up') {
      this.state.cursor = this.nextSelectable(-1);
      return { type: 'navigate', cursor: this.state.cursor };
    }

    if (key.key === 'Down') {
      this.state.cursor = this.nextSelectable(1);
      return { type: 'navigate', cursor: this.state.cursor };
    }

    if (key.key === 'Enter' || key.key === 'Space') {
      if (!this.state.items[this.state.cursor]?.disabled) {
        return { type: 'select', index: this.state.cursor };
      }
      return { type: 'none' };
    }

    if (key.key === 'Escape') {
      return { type: 'cancel' };
    }

    return { type: 'none' };
  }

  private nextSelectable(direction: 1 | -1): number {
    const total = this.state.items.length;
    let next = this.state.cursor;
    for (let i = 0; i < total; i++) {
      next = (next + direction + total) % total;
      if (!this.state.items[next]?.disabled) return next;
    }
    return this.state.cursor;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/list-picker.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/widgets/list-picker.ts tests/widgets/list-picker.test.ts && git commit -m "feat: ListPicker widget — arrow nav, wrap, disabled skip, select/cancel"
```

---

### Task 3: TextInput

**Files:**
- Create: `src/widgets/text-input.ts`
- Create: `tests/widgets/text-input.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/widgets/text-input.test.ts
import { test, expect } from 'vitest';
import { TextInput } from '../src/widgets/text-input.js';
import { parseKey } from '../src/widgets/keys.js';

test('typing appends to buffer', () => {
  const ti = new TextInput({ prompt: 'Name' });
  ti.handleKey(parseKey(Buffer.from('a')));
  ti.handleKey(parseKey(Buffer.from('b')));
  expect(ti.state.buffer).toBe('ab');
});

test('backspace removes last char', () => {
  const ti = new TextInput({ prompt: 'Name' });
  ti.handleKey(parseKey(Buffer.from('abc')));
  ti.handleKey(parseKey(Buffer.from('\x7f')));
  expect(ti.state.buffer).toBe('ab');
});

test('backspace on empty buffer is noop', () => {
  const ti = new TextInput({ prompt: 'Name' });
  const event = ti.handleKey(parseKey(Buffer.from('\x7f')));
  expect(ti.state.buffer).toBe('');
  expect(event).toEqual({ type: 'none' });
});

test('enter submits with buffer value', () => {
  const ti = new TextInput({ prompt: 'Name' });
  ti.handleKey(parseKey(Buffer.from('hello')));
  const event = ti.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'submit', value: 'hello' });
});

test('enter submits empty string when buffer empty', () => {
  const ti = new TextInput({ prompt: 'Name' });
  const event = ti.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'submit', value: '' });
});

test('escape cancels', () => {
  const ti = new TextInput({ prompt: 'Name' });
  const event = ti.handleKey(parseKey(Buffer.from('\x1b')));
  expect(event).toEqual({ type: 'cancel' });
});

test('tab emits tab event with current buffer', () => {
  const ti = new TextInput({ prompt: 'Path' });
  ti.handleKey(parseKey(Buffer.from('/srv/cl')));
  const event = ti.handleKey(parseKey(Buffer.from('\t')));
  expect(event).toEqual({ type: 'tab', partial: '/srv/cl' });
});

test('setBuffer updates buffer externally', () => {
  const ti = new TextInput({ prompt: 'Path' });
  ti.setBuffer('/srv/claude-proxy/');
  expect(ti.state.buffer).toBe('/srv/claude-proxy/');
});

test('masked mode does not affect buffer', () => {
  const ti = new TextInput({ prompt: 'Password', masked: true });
  ti.handleKey(parseKey(Buffer.from('secret')));
  expect(ti.state.buffer).toBe('secret');
  expect(ti.state.masked).toBe(true);
});

test('paste (multi-char) appends entire string', () => {
  const ti = new TextInput({ prompt: 'ID' });
  ti.handleKey(parseKey(Buffer.from('abc-123-def')));
  expect(ti.state.buffer).toBe('abc-123-def');
});

test('change event emitted on typing', () => {
  const ti = new TextInput({ prompt: 'Name' });
  const event = ti.handleKey(parseKey(Buffer.from('a')));
  expect(event).toEqual({ type: 'change', buffer: 'a' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/text-input.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement TextInput**

```typescript
// src/widgets/text-input.ts
import type { KeyEvent } from './keys.js';

export interface TextInputState {
  buffer: string;
  prompt?: string;
  masked?: boolean;
}

export type TextInputEvent =
  | { type: 'change'; buffer: string }
  | { type: 'submit'; value: string }
  | { type: 'cancel' }
  | { type: 'tab'; partial: string }
  | { type: 'none' };

export class TextInput {
  state: TextInputState;

  constructor(options: { prompt?: string; masked?: boolean; initial?: string }) {
    this.state = {
      buffer: options.initial ?? '',
      prompt: options.prompt,
      masked: options.masked,
    };
  }

  handleKey(key: KeyEvent): TextInputEvent {
    if (key.key === 'Enter') {
      return { type: 'submit', value: this.state.buffer };
    }

    if (key.key === 'Escape') {
      return { type: 'cancel' };
    }

    if (key.key === 'Backspace') {
      if (this.state.buffer.length > 0) {
        this.state.buffer = this.state.buffer.slice(0, -1);
        return { type: 'change', buffer: this.state.buffer };
      }
      return { type: 'none' };
    }

    if (key.key === 'Tab') {
      return { type: 'tab', partial: this.state.buffer };
    }

    // Ignore arrow keys and other control sequences
    if (key.key === 'Up' || key.key === 'Down' || key.key === 'Left' || key.key === 'Right') {
      return { type: 'none' };
    }

    // Printable character(s) — including paste
    if (key.key.length >= 1 && !key.raw.startsWith('\x1b')) {
      this.state.buffer += key.key;
      return { type: 'change', buffer: this.state.buffer };
    }

    return { type: 'none' };
  }

  setBuffer(value: string): void {
    this.state.buffer = value;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/text-input.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/widgets/text-input.ts tests/widgets/text-input.test.ts && git commit -m "feat: TextInput widget — type, backspace, submit, tab, paste, masked mode"
```

---

### Task 4: YesNoPrompt

**Files:**
- Create: `src/widgets/yes-no.ts`
- Create: `tests/widgets/yes-no.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/widgets/yes-no.test.ts
import { test, expect } from 'vitest';
import { YesNoPrompt } from '../src/widgets/yes-no.js';
import { parseKey } from '../src/widgets/keys.js';

test('y answers true', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false });
  const event = yn.handleKey(parseKey(Buffer.from('y')));
  expect(event).toEqual({ type: 'answer', value: true });
});

test('Y answers true', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false });
  const event = yn.handleKey(parseKey(Buffer.from('Y')));
  expect(event).toEqual({ type: 'answer', value: true });
});

test('n answers false', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: true });
  const event = yn.handleKey(parseKey(Buffer.from('n')));
  expect(event).toEqual({ type: 'answer', value: false });
});

test('N answers false', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: true });
  const event = yn.handleKey(parseKey(Buffer.from('N')));
  expect(event).toEqual({ type: 'answer', value: false });
});

test('Enter uses default (false)', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false });
  const event = yn.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'answer', value: false });
});

test('Enter uses default (true)', () => {
  const yn = new YesNoPrompt({ prompt: 'Public?', defaultValue: true });
  const event = yn.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'answer', value: true });
});

test('Escape cancels', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false });
  const event = yn.handleKey(parseKey(Buffer.from('\x1b')));
  expect(event).toEqual({ type: 'cancel' });
});

test('other keys return none', () => {
  const yn = new YesNoPrompt({ prompt: 'Hidden?', defaultValue: false });
  const event = yn.handleKey(parseKey(Buffer.from('x')));
  expect(event).toEqual({ type: 'none' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/yes-no.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement YesNoPrompt**

```typescript
// src/widgets/yes-no.ts
import type { KeyEvent } from './keys.js';

export interface YesNoState {
  prompt: string;
  defaultValue: boolean;
}

export type YesNoEvent =
  | { type: 'answer'; value: boolean }
  | { type: 'cancel' }
  | { type: 'none' };

export class YesNoPrompt {
  state: YesNoState;

  constructor(options: { prompt: string; defaultValue: boolean }) {
    this.state = {
      prompt: options.prompt,
      defaultValue: options.defaultValue,
    };
  }

  handleKey(key: KeyEvent): YesNoEvent {
    if (key.key === 'y' || key.key === 'Y') {
      return { type: 'answer', value: true };
    }
    if (key.key === 'n' || key.key === 'N') {
      return { type: 'answer', value: false };
    }
    if (key.key === 'Enter') {
      return { type: 'answer', value: this.state.defaultValue };
    }
    if (key.key === 'Escape') {
      return { type: 'cancel' };
    }
    return { type: 'none' };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/yes-no.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/widgets/yes-no.ts tests/widgets/yes-no.test.ts && git commit -m "feat: YesNoPrompt widget — y/n/enter with configurable default"
```

---

### Task 5: CheckboxPicker

**Files:**
- Create: `src/widgets/checkbox-picker.ts`
- Create: `tests/widgets/checkbox-picker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/widgets/checkbox-picker.test.ts
import { test, expect } from 'vitest';
import { CheckboxPicker } from '../src/widgets/checkbox-picker.js';
import { parseKey } from '../src/widgets/keys.js';

test('space toggles current item on', () => {
  const cp = new CheckboxPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  const event = cp.handleKey(parseKey(Buffer.from(' ')));
  expect(event).toEqual({ type: 'toggle', index: 0, selected: true });
  expect(cp.state.selected.has(0)).toBe(true);
});

test('space toggles current item off', () => {
  const cp = new CheckboxPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  cp.handleKey(parseKey(Buffer.from(' '))); // toggle on
  const event = cp.handleKey(parseKey(Buffer.from(' '))); // toggle off
  expect(event).toEqual({ type: 'toggle', index: 0, selected: false });
  expect(cp.state.selected.has(0)).toBe(false);
});

test('arrow navigation delegates to ListPicker', () => {
  const cp = new CheckboxPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  cp.handleKey(parseKey(Buffer.from('\x1b[B')));
  expect(cp.state.cursor).toBe(1);
});

test('wraps around', () => {
  const cp = new CheckboxPicker({ items: [{ label: 'A' }, { label: 'B' }] });
  cp.handleKey(parseKey(Buffer.from('\x1b[A')));
  expect(cp.state.cursor).toBe(1);
});

test('enter submits selected indices', () => {
  const cp = new CheckboxPicker({ items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] });
  cp.handleKey(parseKey(Buffer.from(' '))); // select A
  cp.handleKey(parseKey(Buffer.from('\x1b[B'))); // move to B
  cp.handleKey(parseKey(Buffer.from('\x1b[B'))); // move to C
  cp.handleKey(parseKey(Buffer.from(' '))); // select C
  const event = cp.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'submit', selectedIndices: [0, 2] });
});

test('escape cancels', () => {
  const cp = new CheckboxPicker({ items: [{ label: 'A' }] });
  const event = cp.handleKey(parseKey(Buffer.from('\x1b')));
  expect(event).toEqual({ type: 'cancel' });
});

test('manual entry mode — typing at bottom item', () => {
  const cp = new CheckboxPicker({
    items: [{ label: 'A' }, { label: 'B' }],
    allowManualEntry: true,
  });
  // Navigate to the "type to add" slot (last position = items.length)
  cp.handleKey(parseKey(Buffer.from('\x1b[B'))); // B
  cp.handleKey(parseKey(Buffer.from('\x1b[B'))); // type-to-add slot
  cp.handleKey(parseKey(Buffer.from('newuser')));
  const event = cp.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'addEntry', value: 'newuser' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/checkbox-picker.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement CheckboxPicker**

```typescript
// src/widgets/checkbox-picker.ts
import { ListPicker, type ListPickerItem } from './list-picker.js';
import type { KeyEvent } from './keys.js';

export interface CheckboxPickerState {
  items: ListPickerItem[];
  cursor: number;
  selected: Set<number>;
  title?: string;
  hint?: string;
  allowManualEntry?: boolean;
  entryBuffer: string;
}

export type CheckboxPickerEvent =
  | { type: 'navigate'; cursor: number }
  | { type: 'toggle'; index: number; selected: boolean }
  | { type: 'submit'; selectedIndices: number[] }
  | { type: 'cancel' }
  | { type: 'addEntry'; value: string }
  | { type: 'none' };

export class CheckboxPicker {
  private list: ListPicker;
  state: CheckboxPickerState;

  constructor(options: {
    items: ListPickerItem[];
    title?: string;
    hint?: string;
    allowManualEntry?: boolean;
    initialSelected?: Set<number>;
  }) {
    // If manual entry, add a virtual slot at the end
    const listItems = options.allowManualEntry
      ? [...options.items, { label: 'Type to add...' }]
      : [...options.items];

    this.list = new ListPicker({ items: listItems, title: options.title, hint: options.hint });

    this.state = {
      items: options.items,
      cursor: 0,
      selected: options.initialSelected ?? new Set(),
      title: options.title,
      hint: options.hint,
      allowManualEntry: options.allowManualEntry,
      entryBuffer: '',
    };
  }

  handleKey(key: KeyEvent): CheckboxPickerEvent {
    const isOnEntrySlot = this.state.allowManualEntry &&
      this.state.cursor === this.state.items.length;

    // Manual entry mode — typing at the bottom slot
    if (isOnEntrySlot) {
      if (key.key === 'Backspace') {
        if (this.state.entryBuffer.length > 0) {
          this.state.entryBuffer = this.state.entryBuffer.slice(0, -1);
        }
        return { type: 'none' };
      }
      if (key.key === 'Enter') {
        if (this.state.entryBuffer.trim()) {
          const value = this.state.entryBuffer.trim();
          this.state.entryBuffer = '';
          return { type: 'addEntry', value };
        }
        // Empty entry = submit
        return { type: 'submit', selectedIndices: Array.from(this.state.selected).sort() };
      }
      if (key.key === 'Escape') {
        return { type: 'cancel' };
      }
      if (key.key === 'Up' || key.key === 'Down') {
        // Allow navigation away from entry slot
        const event = this.list.handleKey(key);
        this.state.cursor = this.list.state.cursor;
        this.state.entryBuffer = '';
        return event.type === 'navigate' ? { type: 'navigate', cursor: event.cursor } : { type: 'none' };
      }
      // Printable — append to entry buffer
      if (key.key.length >= 1 && !key.raw.startsWith('\x1b')) {
        this.state.entryBuffer += key.key;
        return { type: 'none' };
      }
      return { type: 'none' };
    }

    // Space — toggle
    if (key.key === 'Space') {
      const idx = this.state.cursor;
      if (idx < this.state.items.length && !this.state.items[idx]?.disabled) {
        if (this.state.selected.has(idx)) {
          this.state.selected.delete(idx);
          return { type: 'toggle', index: idx, selected: false };
        } else {
          this.state.selected.add(idx);
          return { type: 'toggle', index: idx, selected: true };
        }
      }
      return { type: 'none' };
    }

    // Enter — submit
    if (key.key === 'Enter') {
      return { type: 'submit', selectedIndices: Array.from(this.state.selected).sort() };
    }

    // Escape — cancel
    if (key.key === 'Escape') {
      return { type: 'cancel' };
    }

    // Arrow navigation — delegate to ListPicker
    if (key.key === 'Up' || key.key === 'Down') {
      const event = this.list.handleKey(key);
      this.state.cursor = this.list.state.cursor;
      if (event.type === 'navigate') {
        return { type: 'navigate', cursor: event.cursor };
      }
    }

    return { type: 'none' };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/checkbox-picker.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/widgets/checkbox-picker.ts tests/widgets/checkbox-picker.test.ts && git commit -m "feat: CheckboxPicker widget — composes ListPicker + toggle + manual entry"
```

---

### Task 6: ComboInput

**Files:**
- Create: `src/widgets/combo-input.ts`
- Create: `tests/widgets/combo-input.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/widgets/combo-input.test.ts
import { test, expect } from 'vitest';
import { ComboInput } from '../src/widgets/combo-input.js';
import { parseKey } from '../src/widgets/keys.js';

test('starts in picker mode', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }, { label: '/srv/b' }] });
  expect(ci.state.mode).toBe('picker');
});

test('arrows navigate in picker mode', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }, { label: '/srv/b' }] });
  ci.handleKey(parseKey(Buffer.from('\x1b[B')));
  expect(ci.state.picker.cursor).toBe(1);
});

test('enter on picker item switches to text mode with pre-fill', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }, { label: '/srv/b' }] });
  ci.handleKey(parseKey(Buffer.from('\x1b[B'))); // cursor on /srv/b
  const event = ci.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'select', path: '/srv/b' });
  expect(ci.state.mode).toBe('text');
  expect(ci.state.text.buffer).toBe('/srv/b');
});

test('typing in picker mode switches to text mode', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }] });
  ci.handleKey(parseKey(Buffer.from('/')));
  expect(ci.state.mode).toBe('text');
  expect(ci.state.text.buffer).toBe('/');
});

test('tab in picker mode switches to text mode', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }] });
  ci.handleKey(parseKey(Buffer.from('\t')));
  expect(ci.state.mode).toBe('text');
});

test('enter in text mode submits', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }] });
  ci.handleKey(parseKey(Buffer.from('/srv/custom')));
  const event = ci.handleKey(parseKey(Buffer.from('\r')));
  expect(event).toEqual({ type: 'submit', value: '/srv/custom' });
});

test('escape in text mode returns to picker', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }] });
  ci.handleKey(parseKey(Buffer.from('x'))); // switch to text
  ci.handleKey(parseKey(Buffer.from('\x1b'))); // escape
  expect(ci.state.mode).toBe('picker');
});

test('escape in picker mode cancels', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }] });
  const event = ci.handleKey(parseKey(Buffer.from('\x1b')));
  expect(event).toEqual({ type: 'cancel' });
});

test('tab in text mode emits tab event', () => {
  const ci = new ComboInput({ items: [{ label: '/srv/a' }] });
  ci.handleKey(parseKey(Buffer.from('/srv/cl')));
  const event = ci.handleKey(parseKey(Buffer.from('\t')));
  expect(event).toEqual({ type: 'tab', partial: '/srv/cl' });
});

test('space in picker mode selects immediately', () => {
  const ci = new ComboInput({ items: [{ label: '~ (home)' }, { label: '/srv/a' }] });
  const event = ci.handleKey(parseKey(Buffer.from(' ')));
  expect(event).toEqual({ type: 'submit', value: '~ (home)' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/combo-input.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement ComboInput**

```typescript
// src/widgets/combo-input.ts
import { ListPicker, type ListPickerItem, type ListPickerState } from './list-picker.js';
import { TextInput, type TextInputState } from './text-input.js';
import type { KeyEvent } from './keys.js';

export interface ComboInputState {
  mode: 'picker' | 'text';
  picker: ListPickerState;
  text: TextInputState;
}

export type ComboInputEvent =
  | { type: 'navigate'; cursor: number }
  | { type: 'select'; path: string }
  | { type: 'submit'; value: string }
  | { type: 'cancel' }
  | { type: 'tab'; partial: string }
  | { type: 'none' };

export class ComboInput {
  private picker: ListPicker;
  private text: TextInput;
  state: ComboInputState;

  constructor(options: { items: ListPickerItem[]; prompt?: string; title?: string }) {
    this.picker = new ListPicker({ items: options.items, title: options.title });
    this.text = new TextInput({ prompt: options.prompt });
    this.state = {
      mode: 'picker',
      picker: this.picker.state,
      text: this.text.state,
    };
  }

  handleKey(key: KeyEvent): ComboInputEvent {
    if (this.state.mode === 'picker') {
      return this.handlePickerKey(key);
    }
    return this.handleTextKey(key);
  }

  setTextBuffer(value: string): void {
    this.text.setBuffer(value);
  }

  private handlePickerKey(key: KeyEvent): ComboInputEvent {
    // Escape — cancel
    if (key.key === 'Escape') {
      return { type: 'cancel' };
    }

    // Arrow navigation
    if (key.key === 'Up' || key.key === 'Down') {
      const event = this.picker.handleKey(key);
      if (event.type === 'navigate') {
        return { type: 'navigate', cursor: event.cursor };
      }
      return { type: 'none' };
    }

    // Enter — select item, switch to text mode with pre-fill
    if (key.key === 'Enter') {
      const item = this.picker.state.items[this.picker.state.cursor];
      if (item) {
        this.state.mode = 'text';
        this.text.setBuffer(item.label);
        return { type: 'select', path: item.label };
      }
      return { type: 'none' };
    }

    // Space — select and submit immediately
    if (key.key === 'Space') {
      const item = this.picker.state.items[this.picker.state.cursor];
      if (item) {
        return { type: 'submit', value: item.label };
      }
      return { type: 'none' };
    }

    // Tab — switch to text mode
    if (key.key === 'Tab') {
      this.state.mode = 'text';
      return { type: 'tab', partial: this.text.state.buffer };
    }

    // Printable character — switch to text mode and type
    if (key.key.length >= 1 && !key.raw.startsWith('\x1b')) {
      this.state.mode = 'text';
      this.text.handleKey(key);
      return { type: 'none' };
    }

    return { type: 'none' };
  }

  private handleTextKey(key: KeyEvent): ComboInputEvent {
    // Escape — back to picker
    if (key.key === 'Escape') {
      this.state.mode = 'picker';
      this.text.setBuffer('');
      return { type: 'none' };
    }

    const event = this.text.handleKey(key);

    if (event.type === 'submit') {
      return { type: 'submit', value: event.value };
    }
    if (event.type === 'tab') {
      return { type: 'tab', partial: event.partial };
    }

    return { type: 'none' };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/combo-input.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/widgets/combo-input.ts tests/widgets/combo-input.test.ts && git commit -m "feat: ComboInput widget — composes ListPicker + TextInput, picker/freehand modes"
```

---

### Task 7: ANSI Renderers

**Files:**
- Create: `src/widgets/renderers.ts`
- Create: `tests/widgets/renderers.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/widgets/renderers.test.ts
import { test, expect } from 'vitest';
import { renderListPicker, renderTextInput, renderYesNo, renderCheckboxPicker } from '../src/widgets/renderers.js';

test('renderListPicker shows cursor arrow on current item', () => {
  const output = renderListPicker({
    items: [{ label: 'Apple' }, { label: 'Banana' }],
    cursor: 1,
    title: 'Pick fruit',
  });
  expect(output).toContain('Pick fruit');
  expect(output).toContain('Banana');
  // cursor arrow on Banana (index 1), not on Apple
  const lines = output.split('\r\n');
  const bananaLine = lines.find(l => l.includes('Banana'));
  expect(bananaLine).toContain('>');
});

test('renderListPicker grays out disabled items', () => {
  const output = renderListPicker({
    items: [{ label: 'Active' }, { label: 'Disabled', disabled: true }],
    cursor: 0,
  });
  // Disabled item should have gray escape code
  expect(output).toContain('Disabled');
  expect(output).toContain('\x1b[38;5;245m');
});

test('renderTextInput shows prompt and buffer', () => {
  const output = renderTextInput({ buffer: 'hello', prompt: 'Name' });
  expect(output).toContain('Name');
  expect(output).toContain('hello');
});

test('renderTextInput masks buffer when masked', () => {
  const output = renderTextInput({ buffer: 'secret', prompt: 'Password', masked: true });
  expect(output).toContain('******');
  expect(output).not.toContain('secret');
});

test('renderYesNo shows prompt with default highlighted', () => {
  const output = renderYesNo({ prompt: 'Hidden?', defaultValue: false });
  expect(output).toContain('Hidden?');
  expect(output).toContain('N');
});

test('renderCheckboxPicker shows checked and unchecked items', () => {
  const output = renderCheckboxPicker({
    items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    cursor: 1,
    selected: new Set([0, 2]),
    entryBuffer: '',
  });
  expect(output).toContain('[x]');
  expect(output).toContain('[ ]');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/renderers.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement renderers**

```typescript
// src/widgets/renderers.ts
import type { ListPickerState } from './list-picker.js';
import type { TextInputState } from './text-input.js';
import type { YesNoState } from './yes-no.js';
import type { CheckboxPickerState } from './checkbox-picker.js';
import type { ComboInputState } from './combo-input.js';

export function renderListPicker(state: ListPickerState): string {
  const parts: string[] = ['\x1b[2J\x1b[H'];

  if (state.title) {
    parts.push(`\x1b[1m${state.title}\x1b[0m\r\n\r\n`);
  }

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    const arrow = i === state.cursor ? '\x1b[33m>\x1b[0m' : ' ';
    if (item.disabled) {
      parts.push(`  ${arrow} \x1b[38;5;245m${item.label}\x1b[0m\r\n`);
    } else {
      const label = i === state.cursor ? `\x1b[1m${item.label}\x1b[0m` : item.label;
      parts.push(`  ${arrow} ${label}\r\n`);
    }
  }

  if (state.hint) {
    parts.push(`\r\n  \x1b[38;5;245m${state.hint}\x1b[0m\r\n`);
  }

  return parts.join('');
}

export function renderTextInput(state: TextInputState): string {
  const display = state.masked ? '*'.repeat(state.buffer.length) : state.buffer;
  return `${state.prompt ?? ''}: ${display}`;
}

export function renderYesNo(state: YesNoState): string {
  const yes = state.defaultValue ? 'Y' : 'y';
  const no = state.defaultValue ? 'n' : 'N';
  const defaultMarker = state.defaultValue ? `[\x1b[1m${yes}\x1b[0m/${no}]` : `[${yes}/\x1b[1m${no}\x1b[0m]`;
  return `${state.prompt} ${defaultMarker}: `;
}

export function renderCheckboxPicker(state: CheckboxPickerState): string {
  const parts: string[] = ['\x1b[2J\x1b[H'];

  if (state.title) {
    parts.push(`\x1b[1m${state.title}\x1b[0m\r\n`);
  }
  if (state.hint) {
    parts.push(`\x1b[38;5;245m${state.hint}\x1b[0m\r\n`);
  }
  parts.push('\r\n');

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    const arrow = i === state.cursor ? '\x1b[33m>\x1b[0m' : ' ';
    const check = state.selected.has(i) ? '\x1b[32m[x]\x1b[0m' : '[ ]';
    parts.push(`  ${arrow} ${check} ${item.label}\r\n`);
  }

  if (state.allowManualEntry) {
    const arrow = state.cursor === state.items.length ? '\x1b[33m>\x1b[0m' : ' ';
    parts.push(`\r\n  ${arrow} Type to add: ${state.entryBuffer}\r\n`);
  }

  parts.push(`\r\n  \x1b[38;5;245mspace=toggle, enter=done, esc=cancel\x1b[0m\r\n`);
  return parts.join('');
}

export function renderComboInput(state: ComboInputState): string {
  if (state.mode === 'text') {
    return `\x1b[2J\x1b[H\x1b[1mWorking directory:\x1b[0m\r\n  \x1b[38;5;245mesc=back to list, tab=complete\x1b[0m\r\n\r\n  Path: ${state.text.buffer}`;
  }
  return renderListPicker(state.picker);
}
```

- [ ] **Step 4: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/renderers.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/widgets/renderers.ts tests/widgets/renderers.test.ts && git commit -m "feat: ANSI renderers for all widget types"
```

---

### Task 8: Flow Engine

**Files:**
- Create: `src/widgets/flow-engine.ts`
- Create: `tests/widgets/flow-engine.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/widgets/flow-engine.test.ts
import { test, expect } from 'vitest';
import { FlowEngine, type FlowStep } from '../src/widgets/flow-engine.js';
import { TextInput } from '../src/widgets/text-input.js';
import { YesNoPrompt } from '../src/widgets/yes-no.js';
import { parseKey } from '../src/widgets/keys.js';

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

test('isComplete returns true after all steps', () => {
  const flow = new FlowEngine(twoStepFlow);
  expect(flow.isComplete()).toBe(false);
  flow.handleKey(parseKey(Buffer.from('test')));
  flow.handleKey(parseKey(Buffer.from('\r')));
  flow.handleKey(parseKey(Buffer.from('n')));
  expect(flow.isComplete()).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/flow-engine.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement FlowEngine**

```typescript
// src/widgets/flow-engine.ts
import type { KeyEvent } from './keys.js';

type Widget = { handleKey(key: KeyEvent): any; state: any };

export interface FlowStep {
  id: string;
  label: string;
  createWidget: (accumulated: Record<string, any>) => Widget;
  condition?: (accumulated: Record<string, any>) => boolean;
  onResult: (event: any, accumulated: Record<string, any>) => void;
}

export type FlowEvent =
  | { type: 'step-complete'; stepId: string; nextStepId: string }
  | { type: 'flow-complete'; results: Record<string, any> }
  | { type: 'flow-cancelled' }
  | { type: 'widget-event'; event: any }
  | { type: 'none' };

export class FlowEngine {
  private steps: FlowStep[];
  private currentIndex: number;
  private accumulated: Record<string, any>;
  private currentWidget: Widget | null;
  private complete: boolean;

  constructor(steps: FlowStep[], initialState?: Record<string, any>) {
    this.steps = steps;
    this.accumulated = initialState ? { ...initialState } : {};
    this.complete = false;
    this.currentIndex = -1;
    this.currentWidget = null;
    this.advanceToNext();
  }

  handleKey(key: KeyEvent): FlowEvent {
    if (this.complete || !this.currentWidget) return { type: 'none' };

    const event = this.currentWidget.handleKey(key);

    // Cancel
    if (event.type === 'cancel') {
      return { type: 'flow-cancelled' };
    }

    // Completion events vary by widget type
    if (event.type === 'submit' || event.type === 'select' || event.type === 'answer') {
      const step = this.steps[this.currentIndex];
      step.onResult(event, this.accumulated);
      const prevStepId = step.id;

      this.advanceToNext();

      if (this.complete) {
        return { type: 'flow-complete', results: this.accumulated };
      }

      return { type: 'step-complete', stepId: prevStepId, nextStepId: this.steps[this.currentIndex].id };
    }

    return { type: 'widget-event', event };
  }

  getCurrentState(): { stepId: string; widget: Widget; progress: number } {
    const step = this.steps[this.currentIndex];
    return {
      stepId: step?.id ?? '',
      widget: this.currentWidget!,
      progress: this.currentIndex / this.steps.length,
    };
  }

  isComplete(): boolean {
    return this.complete;
  }

  getResults(): Record<string, any> {
    return this.accumulated;
  }

  private advanceToNext(): void {
    this.currentIndex++;

    // Skip steps whose conditions are false
    while (this.currentIndex < this.steps.length) {
      const step = this.steps[this.currentIndex];
      if (step.condition && !step.condition(this.accumulated)) {
        this.currentIndex++;
        continue;
      }
      // Found a valid step
      this.currentWidget = step.createWidget(this.accumulated);
      return;
    }

    // No more steps
    this.complete = true;
    this.currentWidget = null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /srv/claude-proxy && npx vitest run tests/widgets/flow-engine.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Run all tests**

Run: `cd /srv/claude-proxy && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /srv/claude-proxy && git add src/widgets/flow-engine.ts tests/widgets/flow-engine.test.ts && git commit -m "feat: FlowEngine — chains widgets into multi-step forms with conditions"
```

---

## Phase 2: Migration (Tasks 9-12)

Replace inline handlers in existing files with widget-based code. Each task modifies existing files.

---

### Task 9: Migrate Creation Flow in index.ts

**Files:**
- Modify: `src/index.ts`

This is the largest migration task. The creation flow (`handleCreationInput`, ~400 lines) becomes a FlowEngine definition + a small handler.

- [ ] **Step 1: Define the creation flow steps**

At the top of index.ts (after imports), define `createSessionSteps` using the FlowStep pattern. Each step maps to the existing flow steps: name, workdir, runas, server, hidden, viewonly, public, users, groups, password, dangermode.

Use the widget types: TextInput for name/runas/password, ComboInput for workdir, ListPicker for server, YesNoPrompt for hidden/viewonly/public/dangermode, CheckboxPicker for users/groups.

Conditions: runas requires isAdmin, server requires isAdmin + remotes configured, users/groups require !hidden && !public, dangermode requires isAdmin.

- [ ] **Step 2: Replace creationFlow Map with FlowEngine instances**

Replace `const creationFlow: Map<string, { step: ... }>` with `const creationFlows: Map<string, FlowEngine>`.

- [ ] **Step 3: Replace startNewSessionFlow**

Instead of creating a complex state object, create a FlowEngine:

```typescript
function startNewSessionFlow(client: Client): void {
  const flow = new FlowEngine(createSessionSteps, {
    currentUser: client.username,
    isAdmin: isAdmin(client.username),
    remotes: config.remotes || [],
    directories: getWorkdirItems({ remoteHost: undefined }),
  });
  creationFlows.set(client.id, flow);
  client.write('\x1b[2J\x1b[H');
  renderCurrentFlowStep(client, flow);
}
```

- [ ] **Step 4: Replace handleCreationInput**

The entire function becomes:

```typescript
function handleCreationInput(client: Client, data: Buffer): void {
  const flow = creationFlows.get(client.id);
  if (!flow) return;

  const event = flow.handleKey(parseKey(data));

  if (event.type === 'flow-complete') {
    creationFlows.delete(client.id);
    finalizeSession(client, event.results);
  } else if (event.type === 'flow-cancelled') {
    creationFlows.delete(client.id);
    showLobby(client);
  } else {
    renderCurrentFlowStep(client, flow);
  }
}
```

- [ ] **Step 5: Write renderCurrentFlowStep**

Uses the renderers from `src/widgets/renderers.ts` to draw the current widget state. Handles tab-completion callbacks for ComboInput.

- [ ] **Step 6: Update finalizeSession to read from flow results**

Instead of reading `flow.name`, `flow.hidden`, etc., read from `results.name`, `results.hidden`, etc.

- [ ] **Step 7: Update launchDeepScan similarly**

- [ ] **Step 8: Build and run all tests**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: All tests PASS

- [ ] **Step 9: Manual test — create a session through the SSH lobby**

Verify: name → workdir → (runas if admin) → (server if admin+remotes) → hidden → viewonly → public → (users if not public) → (groups if not public) → password → (dangermode if admin) → session created.

- [ ] **Step 10: Commit**

```bash
cd /srv/claude-proxy && git add src/index.ts && git commit -m "refactor: creation flow uses FlowEngine — replaces ~400 lines of inline handlers"
```

---

### Task 10: Migrate Restart and Export Flows in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace handleRestartInput with ListPicker**

The restart picker becomes a ListPicker. The resume ID prompt becomes a TextInput. Chain them manually (not a full FlowEngine — only 2 steps).

- [ ] **Step 2: Replace handleExportInput with CheckboxPicker**

The export picker becomes a CheckboxPicker with toggle-all support.

- [ ] **Step 3: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`

- [ ] **Step 4: Manual test — restart and export flows**

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/index.ts && git commit -m "refactor: restart and export flows use ListPicker and CheckboxPicker"
```

---

### Task 11: Migrate Session Settings Editor in session-manager.ts

**Files:**
- Modify: `src/session-manager.ts`

- [ ] **Step 1: Replace edit menu handler with ListPicker**

The edit settings main menu becomes a ListPicker. Each sub-editor (password, users, groups, admins) becomes the appropriate widget.

- [ ] **Step 2: Replace checkbox pickers with CheckboxPicker widget**

The edit-users, edit-groups, edit-admins handlers (currently 3 copies of ~50 lines each) become 3 instances of CheckboxPicker with `allowManualEntry: true`.

- [ ] **Step 3: Build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`

- [ ] **Step 4: Commit**

```bash
cd /srv/claude-proxy && git add src/session-manager.ts && git commit -m "refactor: session settings editor uses ListPicker and CheckboxPicker widgets"
```

---

### Task 12: Remove Dead Code and Final Verification

**Files:**
- Modify: `src/index.ts`
- Modify: `src/session-manager.ts`
- Modify: `src/interactive-menu.ts`

- [ ] **Step 1: Remove unused functions**

Remove: `renderUserPicker`, `renderGroupPicker`, `renderServerPicker`, `renderWorkdirPrompt`, `getWorkdirItems`, `getFilteredWorkdirs`, `tabComplete` (move to widgets if needed), `renderRestartPicker`, `renderExportPicker`, `renderResumeIdPrompt`, `handleResumeIdInput`.

Remove from session-manager.ts: `renderCheckboxPicker`, inline edit handlers replaced by widgets.

- [ ] **Step 2: Remove wrapCursor from interactive-menu.ts**

The `wrapCursor` function is now superseded by ListPicker's built-in wrapping. If the lobby still uses it directly, leave it. Otherwise remove.

- [ ] **Step 3: Full build and test**

Run: `cd /srv/claude-proxy && npm run build && npx vitest run`
Expected: All tests PASS, no unused imports

- [ ] **Step 4: Manual end-to-end test**

Test every flow: create session, restart session, export, edit settings (all sub-editors), help menu.

- [ ] **Step 5: Commit**

```bash
cd /srv/claude-proxy && git add src/ && git commit -m "refactor: remove dead code from pre-widget inline handlers"
```
