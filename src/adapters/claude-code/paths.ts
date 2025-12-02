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
 * Claude Code uses `-` as a path separator, e.g.:
 * "-Users-tylervergho-Documents-GitHub-dex" -> "/Users/tylervergho/Documents/GitHub/dex"
 */
function desanitizeProjectPath(sanitized: string): string {
  // Replace leading `-` with `/` and all other `-` with `/`
  // Handle Windows paths that start with drive letter (e.g., "C-Users-...")
  if (/^[A-Z]-/.test(sanitized)) {
    // Windows path: "C-Users-foo" -> "C:/Users/foo"
    return sanitized.replace(/^([A-Z])-/, '$1:/').replace(/-/g, '/');
  }
  // Unix path: "-Users-foo" -> "/Users/foo"
  return sanitized.replace(/^-/, '/').replace(/-/g, '/');
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
 * Get the mtime of the projects directory (quick check for changes).
 * Returns null if directory doesn't exist.
 */
export function getProjectsRootMtime(): number | null {
  const rootPath = getClaudeCodeRootPath();
  const projectsDir = join(rootPath, 'projects');
  try {
    return statSync(projectsDir).mtimeMs;
  } catch {
    return null;
  }
}
