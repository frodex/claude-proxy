import { test, expect } from 'vitest';
import { cellColorToHex, lineToSpans, PALETTE_256 } from '../src/screen-renderer.js';

test('PALETTE_256 has 256 entries', () => {
  expect(PALETTE_256).toHaveLength(256);
});

test('PALETTE_256 standard colors are correct', () => {
  expect(PALETTE_256[0]).toBe('#000000');
  expect(PALETTE_256[1]).toBe('#cd0000');
  expect(PALETTE_256[7]).toBe('#e5e5e5');
  expect(PALETTE_256[15]).toBe('#ffffff');
});

test('PALETTE_256 grayscale ramp', () => {
  // 232 = darkest gray, 255 = lightest
  expect(PALETTE_256[232]).toBe('#080808');
  expect(PALETTE_256[255]).toBe('#eeeeee');
});

test('cellColorToHex returns undefined for default', () => {
  expect(cellColorToHex('fg', 0, 0, 1, 0)).toBeUndefined();
});

test('cellColorToHex handles RGB', () => {
  // RGB: red=255, green=128, blue=0 → packed as (255 << 16) | (128 << 8) | 0
  const packed = (255 << 16) | (128 << 8) | 0;
  expect(cellColorToHex('fg', 1, 0, 0, packed)).toBe('#ff8000');
});

test('cellColorToHex handles palette', () => {
  expect(cellColorToHex('fg', 0, 1, 0, 1)).toBe('#cd0000'); // red
  expect(cellColorToHex('fg', 0, 1, 0, 10)).toBe('#00ff00'); // bright green
});

test('lineToSpans groups adjacent cells with same attributes', () => {
  // Mock a buffer line with simple text
  const mockLine = {
    getCell: (x: number) => {
      if (x >= 5) return { getChars: () => '', getWidth: () => 1, isFgRGB: () => 0, isFgPalette: () => 0, isFgDefault: () => 1, getFgColor: () => 0, isBgRGB: () => 0, isBgPalette: () => 0, isBgDefault: () => 1, getBgColor: () => 0, isBold: () => 0, isItalic: () => 0, isUnderline: () => 0, isDim: () => 0, isStrikethrough: () => 0 };
      return {
        getChars: () => 'hello'[x],
        getWidth: () => 1,
        isFgRGB: () => 0, isFgPalette: () => 0, isFgDefault: () => 1, getFgColor: () => 0,
        isBgRGB: () => 0, isBgPalette: () => 0, isBgDefault: () => 1, getBgColor: () => 0,
        isBold: () => 0, isItalic: () => 0, isUnderline: () => 0, isDim: () => 0, isStrikethrough: () => 0,
      };
    },
  };

  const spans = lineToSpans(mockLine, 5);
  expect(spans).toHaveLength(1);
  expect(spans[0].text).toBe('hello');
  expect(spans[0].fg).toBeUndefined();
});

test('lineToSpans splits on attribute change', () => {
  const mockLine = {
    getCell: (x: number) => {
      const isBoldCell = x >= 3;
      return {
        getChars: () => 'abcdef'[x] || '',
        getWidth: () => 1,
        isFgRGB: () => 0, isFgPalette: () => 0, isFgDefault: () => 1, getFgColor: () => 0,
        isBgRGB: () => 0, isBgPalette: () => 0, isBgDefault: () => 1, getBgColor: () => 0,
        isBold: () => isBoldCell ? 1 : 0,
        isItalic: () => 0, isUnderline: () => 0, isDim: () => 0, isStrikethrough: () => 0,
      };
    },
  };

  const spans = lineToSpans(mockLine, 6);
  expect(spans).toHaveLength(2);
  expect(spans[0].text).toBe('abc');
  expect(spans[0].bold).toBeUndefined();
  expect(spans[1].text).toBe('def');
  expect(spans[1].bold).toBe(true);
});

test('lineToSpans skips wide-char spacers', () => {
  const mockLine = {
    getCell: (x: number) => {
      if (x === 0) return { getChars: () => '漢', getWidth: () => 2, isFgRGB: () => 0, isFgPalette: () => 0, isFgDefault: () => 1, getFgColor: () => 0, isBgRGB: () => 0, isBgPalette: () => 0, isBgDefault: () => 1, getBgColor: () => 0, isBold: () => 0, isItalic: () => 0, isUnderline: () => 0, isDim: () => 0, isStrikethrough: () => 0 };
      if (x === 1) return { getChars: () => '', getWidth: () => 0, isFgRGB: () => 0, isFgPalette: () => 0, isFgDefault: () => 1, getFgColor: () => 0, isBgRGB: () => 0, isBgPalette: () => 0, isBgDefault: () => 1, getBgColor: () => 0, isBold: () => 0, isItalic: () => 0, isUnderline: () => 0, isDim: () => 0, isStrikethrough: () => 0 };
      if (x === 2) return { getChars: () => 'a', getWidth: () => 1, isFgRGB: () => 0, isFgPalette: () => 0, isFgDefault: () => 1, getFgColor: () => 0, isBgRGB: () => 0, isBgPalette: () => 0, isBgDefault: () => 1, getBgColor: () => 0, isBold: () => 0, isItalic: () => 0, isUnderline: () => 0, isDim: () => 0, isStrikethrough: () => 0 };
      return null;
    },
  };

  const spans = lineToSpans(mockLine, 3);
  expect(spans).toHaveLength(1);
  expect(spans[0].text).toBe('漢a');
});

test('lineToSpans trims trailing default whitespace', () => {
  const mockLine = {
    getCell: (x: number) => ({
      getChars: () => x < 3 ? 'abc'[x] : ' ',
      getWidth: () => 1,
      isFgRGB: () => 0, isFgPalette: () => 0, isFgDefault: () => 1, getFgColor: () => 0,
      isBgRGB: () => 0, isBgPalette: () => 0, isBgDefault: () => 1, getBgColor: () => 0,
      isBold: () => 0, isItalic: () => 0, isUnderline: () => 0, isDim: () => 0, isStrikethrough: () => 0,
    }),
  };

  const spans = lineToSpans(mockLine, 10);
  expect(spans).toHaveLength(1);
  expect(spans[0].text).toBe('abc');
});

test('lineToSpans includes fg color in span', () => {
  const mockLine = {
    getCell: (x: number) => ({
      getChars: () => 'x',
      getWidth: () => 1,
      isFgRGB: () => 0, isFgPalette: () => 1, isFgDefault: () => 0, getFgColor: () => 2,
      isBgRGB: () => 0, isBgPalette: () => 0, isBgDefault: () => 1, getBgColor: () => 0,
      isBold: () => 0, isItalic: () => 0, isUnderline: () => 0, isDim: () => 0, isStrikethrough: () => 0,
    }),
  };

  const spans = lineToSpans(mockLine, 1);
  expect(spans[0].fg).toBe('#00cd00'); // palette index 2 = green
});
