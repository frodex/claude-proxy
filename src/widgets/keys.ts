export type KeyName = 'Up' | 'Down' | 'Left' | 'Right' | 'Enter' | 'Space' |
  'Escape' | 'Backspace' | 'Tab' | 'CtrlC' | string;

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
  if (str === '\x03') return { key: 'CtrlC', raw: str };

  // Everything else — printable characters or paste
  return { key: str, raw: str };
}

/** Check if a key is a cancel action (Escape, Ctrl+C, or q in non-text contexts) */
export function isCancelKey(key: KeyEvent, allowQ: boolean = true): boolean {
  if (key.key === 'Escape' || key.key === 'CtrlC') return true;
  if (allowQ && key.key === 'q') return true;
  return false;
}

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
