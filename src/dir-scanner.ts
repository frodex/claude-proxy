import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';

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

  scan(): string[] {
    if (this.cachedScan) return this.cachedScan;
    this.cachedScan = this.performScan();
    return this.cachedScan;
  }

  rescan(): string[] {
    this.cachedScan = null;
    return this.scan();
  }

  /** History first, then scanned repos, deduplicated */
  getDirectories(): string[] {
    const history = this.getHistory();
    const scanned = this.scan();
    const historySet = new Set(history);
    return [...history, ...scanned.filter(d => !historySet.has(d))];
  }

  private performScan(): string[] {
    const results: string[] = [];
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

    const walk = (dir: string, depth: number): void => {
      if (depth > this.maxDepth) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue;
        if (entry.startsWith('.') && entry !== '.config') continue;
        const full = join(dir, entry);
        try {
          if (!statSync(full).isDirectory()) continue;
        } catch {
          continue;
        }
        if (existsSync(join(full, '.git'))) {
          results.push(full);
          continue;
        }
        walk(full, depth + 1);
      }
    };

    for (const root of this.scanRoots) {
      if (existsSync(root)) {
        walk(root, 0);
      }
    }

    return results.sort();
  }
}
