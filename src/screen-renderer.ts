// src/screen-renderer.ts
// Converts xterm.js headless buffer cells into styled spans for WebSocket streaming.
// Each line becomes an array of spans — adjacent cells with identical attributes grouped together.

export interface Span {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
}

export interface ScreenLine {
  spans: Span[];
}

export interface ScreenState {
  width: number;
  height: number;
  cursor: { x: number; y: number };
  title: string;
  lines: ScreenLine[];
}

// Standard 256-color palette
const PALETTE_256: string[] = [
  // 0-7: standard colors
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  // 8-15: bright colors
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
  // 16-231: 6x6x6 color cube
  ...Array.from({ length: 216 }, (_, i) => {
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    return '#' + [r, g, b].map(c => (c ? c * 40 + 55 : 0).toString(16).padStart(2, '0')).join('');
  }),
  // 232-255: grayscale ramp
  ...Array.from({ length: 24 }, (_, i) => {
    const v = (i * 10 + 8).toString(16).padStart(2, '0');
    return `#${v}${v}${v}`;
  }),
];

export { PALETTE_256 };

/**
 * Convert a cell's color to hex RGB string.
 * Returns undefined for default terminal color.
 */
export function cellColorToHex(
  isFgOrBg: 'fg' | 'bg',
  isRGB: number,
  isPalette: number,
  isDefault: number,
  colorValue: number,
): string | undefined {
  if (isDefault) return undefined;

  if (isRGB) {
    const r = (colorValue >> 16) & 0xff;
    const g = (colorValue >> 8) & 0xff;
    const b = colorValue & 0xff;
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  if (isPalette) {
    return PALETTE_256[colorValue] ?? undefined;
  }

  return undefined;
}

/**
 * Convert a single buffer line to an array of styled spans.
 * Adjacent cells with identical attributes are grouped into one span.
 */
export function lineToSpans(line: any, cols: number): Span[] {
  const spans: Span[] = [];
  let current: Span | null = null;

  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell) break;

    // Skip wide-character spacer cells (width 0)
    if (cell.getWidth() === 0) continue;

    const char = cell.getChars() || ' ';

    const fg = cellColorToHex('fg', cell.isFgRGB(), cell.isFgPalette(), cell.isFgDefault(), cell.getFgColor());
    const bg = cellColorToHex('bg', cell.isBgRGB(), cell.isBgPalette(), cell.isBgDefault(), cell.getBgColor());
    const bold = cell.isBold() === 1;
    const italic = cell.isItalic() === 1;
    const underline = cell.isUnderline() === 1;
    const dim = cell.isDim() === 1;
    const strikethrough = cell.isStrikethrough() === 1;

    // Same attributes as current span? Extend it.
    // Use !! to normalize: span may have undefined for false-y attributes
    if (
      current &&
      current.fg === fg &&
      current.bg === bg &&
      !!current.bold === bold &&
      !!current.italic === italic &&
      !!current.underline === underline &&
      !!current.dim === dim &&
      !!current.strikethrough === strikethrough
    ) {
      current.text += char;
    } else {
      if (current) spans.push(current);
      current = { text: char };
      // Only include non-default attributes to keep JSON small
      if (fg) current.fg = fg;
      if (bg) current.bg = bg;
      if (bold) current.bold = true;
      if (italic) current.italic = true;
      if (underline) current.underline = true;
      if (dim) current.dim = true;
      if (strikethrough) current.strikethrough = true;
    }
  }

  if (current) spans.push(current);

  // Trim trailing whitespace span (common — saves bandwidth)
  if (spans.length > 0) {
    const last = spans[spans.length - 1];
    if (!last.fg && !last.bg && !last.bold && !last.italic && !last.underline && !last.dim && !last.strikethrough) {
      last.text = last.text.trimEnd();
      if (last.text === '') spans.pop();
    }
  }

  return spans;
}

/**
 * Read the full visible screen from an xterm buffer as ScreenState.
 * Reads the viewport (baseY to baseY + rows).
 */
export function bufferToScreenState(
  buffer: any,
  cols: number,
  rows: number,
  title: string,
): ScreenState {
  const lines: ScreenLine[] = [];
  const baseY = buffer.baseY;

  for (let i = 0; i < rows; i++) {
    const line = buffer.getLine(baseY + i);
    if (line) {
      lines.push({ spans: lineToSpans(line, cols) });
    } else {
      lines.push({ spans: [] });
    }
  }

  return {
    width: cols,
    height: rows,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    title,
    lines,
  };
}

/**
 * Read a specific line range from the buffer (for scrollback).
 * lineStart and lineEnd are absolute buffer indices.
 */
export function bufferLinesToSpans(
  buffer: any,
  cols: number,
  lineStart: number,
  lineEnd: number,
): ScreenLine[] {
  const lines: ScreenLine[] = [];
  for (let i = lineStart; i < lineEnd; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push({ spans: lineToSpans(line, cols) });
    } else {
      lines.push({ spans: [] });
    }
  }
  return lines;
}
