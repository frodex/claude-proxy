import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const MAX_HISTORY = 50;

interface DirScannerOptions {
  historyPath: string;
  scanRoots?: string[];
  maxDepth?: number;
}

export class DirScanner {
  private historyPath: string;
  private scanRoots: string[];
  private maxDepth: number;
  private cachedScan: string[] | null = null;

  constructor(options: DirScannerOptions) {
    this.historyPath = options.historyPath;
    this.scanRoots = options.scanRoots ?? ['/srv', '/home', '/root'];
    this.maxDepth = options.maxDepth ?? 3;
  }

  getHistory(): string[] {
    if (!existsSync(this.historyPath)) return [];
    try {
      return JSON.parse(readFileSync(this.historyPath, 'utf-8'));
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

  scan(): string[] {
    if (this.cachedScan) return this.cachedScan;
    this.cachedScan = this.performScan();
    return this.cachedScan;
  }

  rescan(): string[] {
    this.cachedScan = null;
    return this.scan();
  }

  getDirectories(): string[] {
    const history = this.getHistory();
    const scanned = this.scan();
    const historySet = new Set(history);
    const merged = [...history, ...scanned.filter(d => !historySet.has(d))];
    return merged;
  }

  private performScan(): string[] {
    // placeholder — implemented in Task 2
    return [];
  }
}
