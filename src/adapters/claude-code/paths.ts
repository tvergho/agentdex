import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { getPlatform, expandPath } from '../../utils/platform.js';

export interface ClaudeCodeProject {
  projectPath: string; // Sanitized project path (directory name)
  workspacePath: string; // Desanitized workspace path
  sessionsDir: string; // Full path to sessions directory
  mtime: number;
}

// Platform-specific Claude Code data locations
const CLAUDE_CODE_PATHS = {
  darwin: '~/.claude',
  win32: '~/.claude', // Windows also uses ~/.claude (home dir)
  linux: '~/.claude',
};

export function getClaudeCodeRootPath(): string {
  const platform = getPlatform();
  const path = CLAUDE_CODE_PATHS[platform];
  return expandPath(path);
}

/**
 * Desanitize a project path from the directory name format.
 * Claude Code encoding: / -> -, literal - -> --, . -> -
 * e.g.: "-Users-foo-bar--baz" -> "/Users/foo/bar-baz"
 * Note: We cannot distinguish . from / (both become -), so paths with dots
 * may be slightly off. The cwd from JSONL entries should be preferred.
 */
function desanitizeProjectPath(sanitized: string): string {
  // Handle Windows paths that start with drive letter (e.g., "C-Users-...")
  if (/^[A-Z]-/.test(sanitized)) {
    return sanitized
      .replace(/--/g, '\x00')  // Preserve literal hyphens
      .replace(/^([A-Z])-/, '$1:/')
      .replace(/-/g, '/')
      .replace(/\x00/g, '-');  // Restore literal hyphens
  }
  // Unix path: "-Users-foo--bar" -> "/Users/foo-bar"
  return sanitized
    .replace(/--/g, '\x00')  // Preserve literal hyphens
    .replace(/^-/, '/')
    .replace(/-/g, '/')
    .replace(/\x00/g, '-');  // Restore literal hyphens
}

/**
 * Discover all Claude Code projects with conversation data.
 */
export function discoverProjects(): ClaudeCodeProject[] {
  const rootPath = getClaudeCodeRootPath();
  const projectsDir = join(rootPath, 'projects');

  if (!existsSync(projectsDir)) {
    return [];
  }

  const projects: ClaudeCodeProject[] = [];

  try {
    const entries = readdirSync(projectsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue; // Skip hidden dirs

      const sessionsDir = join(projectsDir, entry.name);

      // Check if this directory has any .jsonl session files
      const sessionFiles = readdirSync(sessionsDir).filter(
        (f) => f.endsWith('.jsonl') && !f.startsWith('agent-')
      );

      if (sessionFiles.length === 0) continue;

      // Get the most recent mtime from any session file
      let latestMtime = 0;
      for (const file of sessionFiles) {
        try {
          const stats = statSync(join(sessionsDir, file));
          if (stats.mtimeMs > latestMtime) {
            latestMtime = stats.mtimeMs;
          }
        } catch {
          // Skip files we can't stat
        }
      }

      projects.push({
        projectPath: entry.name,
        workspacePath: desanitizeProjectPath(entry.name),
        sessionsDir,
        mtime: latestMtime,
      });
    }
  } catch {
    // If we can't read the projects directory, return empty
    return [];
  }

  return projects;
}

/**
 * Check if Claude Code data exists on this machine.
 */
export function detectClaudeCode(): boolean {
  const rootPath = getClaudeCodeRootPath();
  const projectsDir = join(rootPath, 'projects');
  return existsSync(projectsDir);
}

/**
 * Get the most recent mtime across all project directories (quick check for changes).
 * This checks both the root projects dir AND each project subdirectory,
 * because updating a file inside a subdirectory doesn't change the parent's mtime.
 * Returns null if directory doesn't exist.
 */
export function getProjectsRootMtime(): number | null {
  const rootPath = getClaudeCodeRootPath();
  const projectsDir = join(rootPath, 'projects');
  try {
    let maxMtime = statSync(projectsDir).mtimeMs;

    // Also check each project subdirectory's mtime
    // This catches updates to existing sessions within a project
    const entries = readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const subDirMtime = statSync(join(projectsDir, entry.name)).mtimeMs;
          if (subDirMtime > maxMtime) {
            maxMtime = subDirMtime;
          }
        } catch {
          // Ignore inaccessible directories
        }
      }
    }

    return maxMtime;
  } catch {
    return null;
  }
}
