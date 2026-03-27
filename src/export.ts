// src/export.ts

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

export interface ExportableSession {
  sessionId?: string;      // Claude session UUID (from JSONL filename)
  name: string;            // Display name
  runAsUser: string;       // User who owns the session files
  projectDir?: string;     // e.g., -home-greg
  jsonlPath?: string;      // Full path to the JSONL file
  metadataPath?: string;   // Full path to metadata JSON
  date?: Date;             // Last modified
  sizeBytes?: number;      // File size
  firstMessage?: string;   // First user message
}

/**
 * Find all JSONL session files for a user
 */
export function findUserSessions(username: string): ExportableSession[] {
  let home: string;
  try {
    home = execSync(`getent passwd ${username}`, { encoding: 'utf-8' }).trim().split(':')[5];
  } catch { return []; }

  const projectsDir = join(home, '.claude', 'projects');
  if (!existsSync(projectsDir)) return [];

  const sessions: ExportableSession[] = [];

  try {
    for (const dir of readdirSync(projectsDir)) {
      const dirPath = join(projectsDir, dir);
      let files: string[];
      try { files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }

      for (const file of files) {
        const filePath = join(dirPath, file);
        const sessionId = file.replace('.jsonl', '');

        try {
          const stat = statSync(filePath);

          // Read first few KB to find the first user message
          let firstMessage = '';
          try {
            const fd = openSync(filePath, 'r');
            const buf = Buffer.alloc(4096);
            const bytesRead = readSync(fd, buf, 0, 4096, 0);
            closeSync(fd);
            const content = buf.toString('utf-8', 0, bytesRead);
            for (const line of content.split('\n')) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line);
                // Look for user message content
                if (parsed.type === 'user' && parsed.message?.content) {
                  const c = parsed.message.content;
                  firstMessage = typeof c === 'string' ? c : (Array.isArray(c) ? c.find((x: any) => x.type === 'text')?.text || '' : '');
                  firstMessage = firstMessage.substring(0, 60);
                  break;
                }
                // Older queue-operation format
                if (parsed.type === 'queue-operation' && parsed.content) {
                  firstMessage = parsed.content.substring(0, 60);
                  break;
                }
              } catch {}
            }
          } catch {}

          sessions.push({
            sessionId,
            name: firstMessage || sessionId.substring(0, 8),
            runAsUser: username,
            projectDir: dir,
            jsonlPath: filePath,
            date: stat.mtime,
            sizeBytes: stat.size,
            firstMessage,
          });
        } catch {}
      }
    }
  } catch {}

  // Sort most recent first
  sessions.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
  return sessions;
}

/**
 * Create an export zip containing selected sessions
 * Returns the path to the zip file
 */
export function createExportZip(sessions: ExportableSession[], exportUser: string): string {
  const exportId = randomUUID().substring(0, 8);
  const exportDir = join(tmpdir(), `claude-export-${exportId}`);
  const sessionsDir = join(exportDir, 'sessions');
  const metadataDir = join(exportDir, 'metadata');

  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(metadataDir, { recursive: true });

  // Copy session files
  for (const session of sessions) {
    if (session.jsonlPath && existsSync(session.jsonlPath)) {
      const destDir = join(sessionsDir, session.projectDir || 'default');
      mkdirSync(destDir, { recursive: true });
      copyFileSync(session.jsonlPath, join(destDir, basename(session.jsonlPath)));
    }
    if (session.metadataPath && existsSync(session.metadataPath)) {
      copyFileSync(session.metadataPath, join(metadataDir, basename(session.metadataPath)));
    }
  }

  // Create install script
  const installScript = `#!/bin/bash
# Claude Session Export — Install Script
# Created: ${new Date().toISOString()}
# Exported by: ${exportUser}
# Sessions: ${sessions.length}

set -e

echo ""
echo "  Claude Session Export Installer"
echo "  ─────────────────────────────────"
echo ""

CLAUDE_DIR="\$HOME/.claude/projects"

if [ ! -d "\$CLAUDE_DIR" ]; then
  echo "  Creating \$CLAUDE_DIR..."
  mkdir -p "\$CLAUDE_DIR"
fi

# Copy session files
for dir in sessions/*/; do
  dirname=\$(basename "\$dir")
  echo "  Installing sessions from \$dirname..."
  mkdir -p "\$CLAUDE_DIR/\$dirname"
  cp -n "\$dir"*.jsonl "\$CLAUDE_DIR/\$dirname/" 2>/dev/null || true
done

echo ""
echo "  Installed \$(find sessions -name '*.jsonl' | wc -l) session(s)"
echo ""
echo "  To resume a session:"
echo "    claude --resume"
echo ""
echo "  Done!"
`;

  writeFileSync(join(exportDir, 'install.sh'), installScript, { mode: 0o755 });

  // Create the zip
  const zipPath = join(tmpdir(), `claude-export-${exportId}.zip`);
  execSync(`cd ${exportDir} && zip -r ${zipPath} .`, { stdio: 'pipe' });

  // Clean up export dir
  execSync(`rm -rf ${exportDir}`, { stdio: 'pipe' });

  return zipPath;
}
