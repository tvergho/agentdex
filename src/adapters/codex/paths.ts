import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { getPlatform, expandPath } from '../../utils/platform.js';

export interface CodexSession {
  sessionId: string; // UUID from filename
  filePath: string; // Full path to the JSONL file
  workspacePath?: string; // Extracted from session_meta.cwd
  mtime: number;
}

// Platform-specific Codex data locations
// All platforms use ~/.codex, but can be overridden with $CODEX_HOME
const CODEX_PATHS = {
  darwin: '~/.codex',
  win32: '~/.codex',
  linux: '~/.codex',
};

export function getCodexRootPath(): string {
  // Check for CODEX_HOME environment variable override
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) {
    return expandPath(codexHome);
  }

  const platform = getPlatform();
  const path = CODEX_PATHS[platform];
  return expandPath(path);
}

/**
 * Extract session ID from rollout filename.
 * Format: rollout-YYYY-MM-DDTHH-MM-SS-{uuid}.jsonl
 */
function extractSessionId(filename: string): string | null {
  // Match the UUID at the end of the filename
  const match = filename.match(/rollout-[\d-T]+-([a-f0-9-]+)\.jsonl$/);
  if (match?.[1]) {
    return match[1];
  }
  return null;
}

/**
 * Discover all Codex session files.
 * Sessions are stored in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
export function discoverSessions(): CodexSession[] {
  const rootPath = getCodexRootPath();
  const sessionsDir = join(rootPath, 'sessions');

  if (!existsSync(sessionsDir)) {
    return [];
  }

  const sessions: CodexSession[] = [];

  // Recursively find all rollout-*.jsonl files
  function scanDirectory(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          // Recurse into subdirectories (year/month/day structure)
          scanDirectory(fullPath);
        } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          const sessionId = extractSessionId(entry.name);
          if (!sessionId) continue;

          try {
            const stats = statSync(fullPath);
            sessions.push({
              sessionId,
              filePath: fullPath,
              mtime: stats.mtimeMs,
            });
          } catch {
            // Skip files we can't stat
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  scanDirectory(sessionsDir);

  return sessions;
}

/**
 * Check if Codex data exists on this machine.
 */
export function detectCodex(): boolean {
  const rootPath = getCodexRootPath();
  const sessionsDir = join(rootPath, 'sessions');
  return existsSync(sessionsDir);
}

/**
 * Get the mtime of the sessions directory (quick check for changes).
 * Returns null if directory doesn't exist.
 */
export function getSessionsRootMtime(): number | null {
  const rootPath = getCodexRootPath();
  const sessionsDir = join(rootPath, 'sessions');
  try {
    return statSync(sessionsDir).mtimeMs;
  } catch {
    return null;
  }
}
