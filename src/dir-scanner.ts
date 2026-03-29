import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const MAX_HISTORY = 50;

interface DirScannerOptions {
  historyPath: string;
}

export class DirScanner {
  private historyPath: string;

  constructor(options: DirScannerOptions) {
    this.historyPath = options.historyPath;
  }

  getHistory(): string[] {
    if (!existsSync(this.historyPath)) return [];
    try {
      const data = JSON.parse(readFileSync(this.historyPath, 'utf-8'));
      if (!Array.isArray(data)) return [];
      return data.filter((d): d is string => typeof d === 'string');
    } catch {
      return [];
    }
  }

  addToHistory(dir: string): void {
    const history = this.getHistory().filter(d => d !== dir);
    history.unshift(dir);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    mkdirSync(dirname(this.historyPath), { recursive: true });
    writeFileSync(this.historyPath, JSON.stringify(history, null, 2));
  }
}
