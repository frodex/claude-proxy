import { ListPicker, type ListPickerItem, type ListPickerState } from './list-picker.js';
import { TextInput, type TextInputState } from './text-input.js';
import { isCancelKey, type KeyEvent } from './keys.js';

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
    // Cancel (Esc, Ctrl+C, q)
    if (isCancelKey(key)) {
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
    // Escape or Ctrl+C — back to picker (not q — that types q)
    if (key.key === 'Escape' || key.key === 'CtrlC') {
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
