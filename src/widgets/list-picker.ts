import { isCancelKey, type KeyEvent } from './keys.js';

export interface ListPickerItem {
  label: string;
  disabled?: boolean;
}

export interface ListPickerState {
  items: ListPickerItem[];
  cursor: number;
  title?: string;
  hint?: string;
  locked?: boolean;
}

export type ListPickerEvent =
  | { type: 'navigate'; cursor: number }
  | { type: 'select'; index: number }
  | { type: 'cancel' }
  | { type: 'none' };

export class ListPicker {
  state: ListPickerState;

  constructor(options: { items: ListPickerItem[]; title?: string; hint?: string; locked?: boolean }) {
    this.state = {
      items: options.items,
      cursor: 0,
      title: options.title,
      hint: options.hint,
      locked: options.locked,
    };
  }

  handleKey(key: KeyEvent): ListPickerEvent {
    if (this.state.locked) {
      if (isCancelKey(key)) return { type: 'cancel' };
      return { type: 'none' };
    }

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

    if (isCancelKey(key)) {
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
