// src/claude-fork-client.ts
// Wrapper around the claude-fork CLI tool.
// Handles list, fork, dry-run commands with JSON output and schema validation.

import { execSync } from 'child_process';

const CLAUDE_FORK_BIN = process.env.CLAUDE_FORK_BIN || '/srv/svg-terminal/claude-forker/tools/claude-fork';

// --- Types ---

export interface ForkSessionInfo {
  sessionId: string;
  project: string;
  encodedCwd: string;
  jsonlPath: string;
  sizeBytes: number;
  sizeHuman: string;
  records: number;
  status: 'active' | 'idle' | 'compacted';
  pid: number | null;
  compacted: boolean;
  hasCompanion: boolean;
  companionFiles: number;
  lastModified: string;
  createdAt: string;
}

export interface ForkListResult {
  command: 'list';
  user: string;
  sessions: ForkSessionInfo[];
  warnings: string[];
}

export interface ForkDryRunChecks {
  sourceExists: boolean;
  sourceActive: boolean;
  sourceActivePid: number | null;
  sourceCompacted: boolean;
  sourceRecords: number;
  sourceSizeHuman: string;
  targetDirExists: boolean;
  targetHasClaudeMd: boolean;
  targetHasSettings?: boolean;
  targetUserHasClaude: boolean;
  targetCleanupProtected: boolean;
}

export interface ForkDryRunResult {
  command: 'fork';
  status: 'dry-run';
  wouldDo: {
    source: string;
    target: string;
    cwdRewrite: { from: string[]; to: string; recordsAffected: number };
    userChange: string | null;
    createDir: boolean;
    companionFiles: number;
  };
  checks: ForkDryRunChecks;
  warnings: string[];
}

export interface ForkSuccessResult {
  command: 'fork';
  status: 'success';
  source: {
    sessionId: string;
    project: string;
    sizeBytes: number;
    records: number;
    compacted: boolean;
  };
  fork: {
    sessionId: string;
    project: string;
    user: string;
    jsonlPath: string;
    sizeBytes: number;
    recordsWritten: number;
    cwdFieldsRewritten: number;
    companionFilesCopied: number;
    lastRecordCleaned: boolean;
  };
  resume: string;
  warnings: string[];
}

export interface ForkErrorResult {
  command: 'fork';
  status: 'error';
  exitCode: number;
  error: string;
  detail?: string;
  suggestions?: string[];
}

// --- Schema cache ---

let _cachedSchema: any = null;

export function getToolSchema(): any {
  if (_cachedSchema) return _cachedSchema;
  try {
    const output = execSync(`python3 ${CLAUDE_FORK_BIN} schema`, { encoding: 'utf-8', timeout: 5000 });
    _cachedSchema = JSON.parse(output);
    return _cachedSchema;
  } catch (err: any) {
    throw new Error(`claude-fork schema failed: ${err.message}`);
  }
}

function validateResponse(command: string, response: any): void {
  const schema = getToolSchema();
  if (!schema?.commands?.[command]) return; // skip validation if schema missing
  // Basic structural validation: check command field matches
  if (response.command && response.command !== command) {
    throw new Error(`claude-fork response mismatch: expected command="${command}", got "${response.command}"`);
  }
}

// --- Helpers ---

function runCommand(args: string[]): string {
  const cmd = `python3 ${CLAUDE_FORK_BIN} ${args.join(' ')}`;
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
  } catch (err: any) {
    // execSync throws on non-zero exit. The tool returns JSON on stderr/stdout even on error.
    if (err.stdout) return err.stdout;
    throw new Error(`claude-fork failed: ${err.message}`);
  }
}

function parseJsonResponse<T>(output: string, command: string): T {
  const trimmed = output.trim();
  if (!trimmed) throw new Error(`claude-fork returned empty output`);
  let parsed: T;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`claude-fork returned non-JSON: ${trimmed.slice(0, 200)}`);
  }
  validateResponse(command, parsed);
  return parsed;
}

// --- Public API ---

export function listSessions(user?: string): ForkListResult {
  const args = ['list', '--json'];
  if (user) args.push('--user', user);
  const output = runCommand(args);
  return parseJsonResponse<ForkListResult>(output, 'list');
}

export function dryRunFork(
  sessionId: string,
  targetDir: string,
  user?: string,
): ForkDryRunResult | ForkErrorResult {
  const args = ['fork', sessionId, targetDir, '--dry-run', '--json'];
  if (user) args.push('--user', user);
  const output = runCommand(args);
  return parseJsonResponse<ForkDryRunResult | ForkErrorResult>(output, 'fork');
}

export function executeCrossFork(
  sessionId: string,
  targetDir: string,
  user?: string,
): ForkSuccessResult | ForkErrorResult {
  const args = ['fork', sessionId, targetDir, '--json'];
  if (user) args.push('--user', user);
  const output = runCommand(args);
  return parseJsonResponse<ForkSuccessResult | ForkErrorResult>(output, 'fork');
}

export function isToolAvailable(): boolean {
  try {
    execSync(`python3 ${CLAUDE_FORK_BIN} help`, { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function _resetSchemaCache(): void {
  _cachedSchema = null;
}
