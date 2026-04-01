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
