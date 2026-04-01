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
    if (key.key === 'Escape' || key.key === 'CtrlC') {
      return { type: 'cancel' };
    }
    return { type: 'none' };
  }
}
