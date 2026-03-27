// src/interactive-menu.ts

import { color } from './ansi.js';

export interface MenuItem {
  label: string;
  key?: string;        // shortcut key shown in yellow before label
  hint?: string;       // terminal keystroke hint shown in gray after label
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

  parts.push('\x1b[2J\x1b[H');
  parts.push(`\r\n  \x1b[1m${title}\x1b[0m\r\n`);
  parts.push(`  ${`\x1b[38;5;245m${'─'.repeat(40)}\x1b[0m`}\r\n`);

  let idx = 0;
  for (const section of sections) {
    if (section.title) {
      parts.push(`\r\n  \x1b[1m${section.title}\x1b[0m\r\n\r\n`);
    } else {
      parts.push('\r\n');
    }

    for (const item of section.items) {
      if (item.disabled) {
        parts.push(`      ${`\x1b[38;5;245m${item.label}\x1b[0m`}\r\n`);
        idx++;
        continue;
      }

      const isCurrent = idx === cursor;
      const arrow = isCurrent ? color('> ', 33) : '  ';
      const keyTag = item.key ? color(`[${item.key}]`, 33) + ' ' : '';
      const hint = item.hint ? ' ' + `\x1b[38;5;245m${item.hint}\x1b[0m` : '';
      const label = isCurrent ? `\x1b[1m${item.label}\x1b[0m` : item.label;

      parts.push(`  ${arrow}${keyTag}${label}${hint}\r\n`);
      idx++;
    }
  }

  if (footer) {
    parts.push(`\r\n  ${`\x1b[38;5;245m${'─'.repeat(40)}\x1b[0m`}\r\n`);
    parts.push(`  ${`\x1b[38;5;245m${footer}\x1b[0m`}\r\n`);
  }

  return parts.join('');
}

export function getTotalItems(sections: MenuSection[]): number {
  return sections.reduce((sum, s) => sum + s.items.length, 0);
}

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
