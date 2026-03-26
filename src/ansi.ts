// src/ansi.ts

export function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function setScrollRegion(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`;
}

export function clearLine(): string {
  return '\x1b[2K';
}

export function color(text: string, code: number): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

export function saveCursor(): string {
  return '\x1b7';
}

export function restoreCursor(): string {
  return '\x1b8';
}

export function hideCursor(): string {
  return '\x1b[?25l';
}

export function showCursor(): string {
  return '\x1b[?25h';
}

export function enterAltScreen(): string {
  return '\x1b[?1049h';
}

export function leaveAltScreen(): string {
  return '\x1b[?1049l';
}
