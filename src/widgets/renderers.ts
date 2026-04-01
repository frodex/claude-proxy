// src/widgets/renderers.ts
import { STATE_COLORS, RESET } from './keys.js';
import type { FlowStepSummary } from './flow-engine.js';
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
      const arrow = (step as any).isCursor ? '\x1b[33m>\x1b[0m' : ' ';
      parts.push(`${arrow} ${color}${step.label}: ${step.value || ''} \x1b[31m[LOCKED]\x1b[0m${RESET}\r\n`);
    } else {
      // pending
      const pendingVal = step.value ? `\x1b[2m${step.value}\x1b[0m` : `\x1b[2m[default]\x1b[0m`;
      parts.push(`  ${color}${step.label}: ${pendingVal}${RESET}\r\n`);
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
