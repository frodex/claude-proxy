// tests/claude-fork-client.test.ts
import { test, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

// Mock child_process before importing the module
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

// Must import AFTER mock setup
import {
  listSessions,
  dryRunFork,
  executeCrossFork,
  isToolAvailable,
  getToolSchema,
  _resetSchemaCache,
} from '../src/claude-fork-client.js';

beforeEach(() => {
  vi.clearAllMocks();
  _resetSchemaCache();
});

// --- Schema ---

const MOCK_SCHEMA = {
  tool: 'claude-fork',
  version: '0.1.0',
  commands: {
    list: { description: 'List sessions', response: {} },
    fork: { description: 'Fork a session', response: {} },
  },
};

function mockSchemaCall(): void {
  // Schema is fetched on first validateResponse call
  mockedExecSync.mockImplementation((cmd: any) => {
    if (typeof cmd === 'string' && cmd.includes('schema')) {
      return JSON.stringify(MOCK_SCHEMA);
    }
    return '';
  });
}

// --- listSessions ---

test('listSessions parses valid JSON response', () => {
  const mockResponse = {
    command: 'list',
    user: 'root',
    sessions: [
      {
        sessionId: '6a76ff6f-ca1e-4be9-b596-b2c0ae588d91',
        project: '/root',
        encodedCwd: '-root',
        jsonlPath: '/root/.claude/projects/-root/6a76ff6f.jsonl',
        sizeBytes: 4200000,
        sizeHuman: '4.2MB',
        records: 1200,
        status: 'active',
        pid: 3352832,
        compacted: false,
        hasCompanion: true,
        companionFiles: 12,
        lastModified: '2026-04-01T12:45:00Z',
        createdAt: '2026-03-28T15:57:38Z',
      },
    ],
    warnings: [],
  };

  mockedExecSync.mockImplementation((cmd: any) => {
    if (typeof cmd === 'string' && cmd.includes('schema')) return JSON.stringify(MOCK_SCHEMA);
    return JSON.stringify(mockResponse);
  });

  const result = listSessions();
  expect(result.command).toBe('list');
  expect(result.user).toBe('root');
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0].sessionId).toBe('6a76ff6f-ca1e-4be9-b596-b2c0ae588d91');
  expect(result.sessions[0].status).toBe('active');
});

test('listSessions passes --user flag', () => {
  mockedExecSync.mockImplementation((cmd: any) => {
    if (typeof cmd === 'string' && cmd.includes('schema')) return JSON.stringify(MOCK_SCHEMA);
    return JSON.stringify({ command: 'list', user: 'greg', sessions: [], warnings: [] });
  });

  const result = listSessions('greg');
  expect(result.user).toBe('greg');

  // Verify the command included --user greg
  const calls = mockedExecSync.mock.calls;
  const listCall = calls.find(c => typeof c[0] === 'string' && c[0].includes('list'));
  expect(listCall).toBeDefined();
  expect(listCall![0]).toContain('--user greg');
});

// --- dryRunFork ---

test('dryRunFork parses dry-run response', () => {
  const mockResponse = {
    command: 'fork',
    status: 'dry-run',
    wouldDo: {
      source: '/root/.claude/projects/-root/abc.jsonl',
      target: '/root/.claude/projects/-srv-proj/def.jsonl',
      cwdRewrite: { from: ['/root'], to: '/srv/proj', recordsAffected: 100 },
      userChange: null,
      createDir: true,
      companionFiles: 5,
    },
    checks: {
      sourceExists: true,
      sourceActive: false,
      sourceActivePid: null,
      sourceCompacted: false,
      sourceRecords: 200,
      sourceSizeHuman: '1MB',
      targetDirExists: false,
      targetHasClaudeMd: true,
      targetUserHasClaude: true,
      targetCleanupProtected: true,
    },
    warnings: [],
  };

  mockedExecSync.mockImplementation((cmd: any) => {
    if (typeof cmd === 'string' && cmd.includes('schema')) return JSON.stringify(MOCK_SCHEMA);
    return JSON.stringify(mockResponse);
  });

  const result = dryRunFork('abc', '/srv/proj');
  expect(result.status).toBe('dry-run');
  if (result.status === 'dry-run') {
    expect(result.checks.sourceExists).toBe(true);
    expect(result.wouldDo.cwdRewrite.from).toEqual(['/root']);
    expect(result.wouldDo.createDir).toBe(true);
  }
});

test('dryRunFork passes --user flag', () => {
  mockedExecSync.mockImplementation((cmd: any) => {
    if (typeof cmd === 'string' && cmd.includes('schema')) return JSON.stringify(MOCK_SCHEMA);
    return JSON.stringify({ command: 'fork', status: 'dry-run', wouldDo: {}, checks: {}, warnings: [] });
  });

  dryRunFork('abc', '/srv/proj', 'greg');

  const calls = mockedExecSync.mock.calls;
  const forkCall = calls.find(c => typeof c[0] === 'string' && c[0].includes('fork') && !c[0].toString().includes('schema'));
  expect(forkCall).toBeDefined();
  expect(forkCall![0]).toContain('--user greg');
  expect(forkCall![0]).toContain('--dry-run');
});

// --- executeCrossFork ---

test('executeCrossFork parses success response', () => {
  const mockResponse = {
    command: 'fork',
    status: 'success',
    source: {
      sessionId: 'abc-123',
      project: '/root',
      sizeBytes: 4200000,
      records: 1200,
      compacted: false,
    },
    fork: {
      sessionId: 'new-uuid-456',
      project: '/srv/proj',
      user: 'root',
      jsonlPath: '/root/.claude/projects/-srv-proj/new-uuid-456.jsonl',
      sizeBytes: 4200000,
      recordsWritten: 1200,
      cwdFieldsRewritten: 1180,
      companionFilesCopied: 12,
      lastRecordCleaned: false,
    },
    resume: 'cd /srv/proj && claude --resume new-uuid-456',
    warnings: [],
  };

  mockedExecSync.mockImplementation((cmd: any) => {
    if (typeof cmd === 'string' && cmd.includes('schema')) return JSON.stringify(MOCK_SCHEMA);
    return JSON.stringify(mockResponse);
  });

  const result = executeCrossFork('abc-123', '/srv/proj');
  expect(result.status).toBe('success');
  if (result.status === 'success') {
    expect(result.fork.sessionId).toBe('new-uuid-456');
    expect(result.fork.recordsWritten).toBe(1200);
    expect(result.resume).toContain('--resume new-uuid-456');
  }
});

test('executeCrossFork parses error response from non-zero exit', () => {
  const mockError = {
    command: 'fork',
    status: 'error',
    exitCode: 1,
    error: 'Source session not found',
    detail: 'No JSONL matching deadbeef',
    suggestions: ['abc-123 (/root, 4.2MB)'],
  };

  mockedExecSync.mockImplementation((cmd: any) => {
    if (typeof cmd === 'string' && cmd.includes('schema')) return JSON.stringify(MOCK_SCHEMA);
    // Simulate non-zero exit: execSync throws with stdout attached
    const err = new Error('exit 1') as any;
    err.stdout = JSON.stringify(mockError);
    throw err;
  });

  const result = executeCrossFork('deadbeef', '/tmp/test');
  expect(result.status).toBe('error');
  if (result.status === 'error') {
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe('Source session not found');
    expect(result.suggestions).toHaveLength(1);
  }
});

// --- Non-JSON output ---

test('throws on empty output', () => {
  mockedExecSync.mockReturnValue('');
  expect(() => listSessions()).toThrow('empty output');
});

test('throws on non-JSON output', () => {
  mockedExecSync.mockReturnValue('Usage: claude-fork [command]');
  expect(() => listSessions()).toThrow('non-JSON');
});

// --- isToolAvailable ---

test('isToolAvailable returns true when help succeeds', () => {
  mockedExecSync.mockReturnValue('claude-fork — Fork Claude Code sessions');
  expect(isToolAvailable()).toBe(true);
});

test('isToolAvailable returns false when help fails', () => {
  mockedExecSync.mockImplementation(() => { throw new Error('not found'); });
  expect(isToolAvailable()).toBe(false);
});

// --- Schema validation ---

test('getToolSchema caches result', () => {
  mockedExecSync.mockReturnValue(JSON.stringify(MOCK_SCHEMA));

  const first = getToolSchema();
  const second = getToolSchema();
  expect(first).toBe(second); // same reference = cached
  // schema command called only once
  expect(mockedExecSync).toHaveBeenCalledTimes(1);
});

test('validates command field in response', () => {
  mockedExecSync.mockImplementation((cmd: any) => {
    if (typeof cmd === 'string' && cmd.includes('schema')) return JSON.stringify(MOCK_SCHEMA);
    // Return a response with wrong command field
    return JSON.stringify({ command: 'wrong', status: 'success' });
  });

  expect(() => listSessions()).toThrow('response mismatch');
});
