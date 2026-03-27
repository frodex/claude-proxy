// src/interactive-menu.ts

import { color } from './ansi.js';

export interface MenuItem {
  label: string;
  key?: string;        // shortcut key (optional)
  action: string;      // action identifier returned on select
  disabled?: boolean;  // grayed out, not selectable
}

export interface MenuSection {
  title?: string;
  items: MenuItem[];
}

export interface MenuOptions {
  title: string;
  sections: MenuSection[];
  footer?: string;
  cursor: number;
}

export function renderMenu(options: MenuOptions): string {
  const { title, sections, footer, cursor } = options;
  const parts: string[] = [];

  parts.push('\x1b[2J\x1b[H');  // clear screen
  parts.push(`\r\n  \x1b[1m${title}\x1b[0m\r\n`);
  parts.push(`  ${color('─'.repeat(40), 90)}\r\n`);

  let idx = 0;
  for (const section of sections) {
    if (section.title) {
      parts.push(`\r\n  \x1b[1m${section.title}\x1b[0m\r\n\r\n`);
    } else {
      parts.push('\r\n');
    }

    for (const item of section.items) {
      if (item.disabled) {
        parts.push(`    ${color(item.label, 90)}\r\n`);
        idx++;
        continue;
      }

      const arrow = idx === cursor ? color('> ', 33) : '  ';
      const keyHint = item.key ? color(` [${item.key}]`, 90) : '';
      const line = idx === cursor
        ? `  ${arrow}\x1b[1m${item.label}\x1b[0m${keyHint}`
        : `  ${arrow}${item.label}${keyHint}`;
      parts.push(`${line}\r\n`);
      idx++;
    }
  }

  if (footer) {
    parts.push(`\r\n  ${color('─'.repeat(40), 90)}\r\n`);
    parts.push(`  ${color(footer, 90)}\r\n`);
  }

  return parts.join('');
}

export function getTotalItems(sections: MenuSection[]): number {
  return sections.reduce((sum, s) => sum + s.items.length, 0);
}

export function getSelectableCount(sections: MenuSection[]): number {
  return sections.reduce((sum, s) => sum + s.items.filter(i => !i.disabled).length, 0);
}

/**
 * Get the action for the item at the given cursor position
 */
export function getActionAtCursor(sections: MenuSection[], cursor: number): string | null {
  let idx = 0;
  for (const section of sections) {
    for (const item of section.items) {
      if (idx === cursor) {
        return item.disabled ? null : item.action;
      }
      idx++;
    }
  }
  return null;
}

/**
 * Find cursor position for a shortcut key
 */
export function findItemByKey(sections: MenuSection[], key: string): { cursor: number; action: string } | null {
  let idx = 0;
  const lowerKey = key.toLowerCase();
  for (const section of sections) {
    for (const item of section.items) {
      if (!item.disabled && item.key && item.key.toLowerCase() === lowerKey) {
        return { cursor: idx, action: item.action };
      }
      idx++;
    }
  }
  return null;
}

/**
 * Move cursor to next selectable item
 */
export function nextSelectable(sections: MenuSection[], cursor: number, direction: 1 | -1): number {
  const total = getTotalItems(sections);
  let next = cursor;
  for (let i = 0; i < total; i++) {
    next = (next + direction + total) % total;
    let idx = 0;
    for (const section of sections) {
      for (const item of section.items) {
        if (idx === next && !item.disabled) return next;
        idx++;
      }
    }
  }
  return cursor;
}
