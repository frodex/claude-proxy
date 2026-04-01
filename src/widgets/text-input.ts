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
