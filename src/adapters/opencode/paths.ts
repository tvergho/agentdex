import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { getPlatform, expandPath } from '../../utils/platform.js';

export interface OpenCodeProject {
  projectId: string; // Hash ID (e.g., "84eb18e7a2ded4eb43fb9b60d3b6d797415413ef")
  workspacePath: string; // Desanitized workspace path from project.json
  projectDir: string; // Full path to project sessions directory
  mtime: number;
}

export interface OpenCodeSession {
  sessionId: string;
  projectId: string;
  workspacePath: string;
  sessionFile: string; // Full path to session JSON file
  messageDir: string; // Full path to message directory
  mtime: number;
}

// Platform-specific OpenCode data locations
// OpenCode stores data in ~/.local/share/opencode/storage
const OPENCODE_PATHS = {
  darwin: '~/.local/share/opencode',
  win32: '~/.local/share/opencode', // Windows also uses this path
  linux: '~/.local/share/opencode',
};

export function getOpenCodeRootPath(): string {
  const platform = getPlatform();
  const path = OPENCODE_PATHS[platform];
  return expandPath(path);
}

export function getOpenCodeStoragePath(): string {
  return join(getOpenCodeRootPath(), 'storage');
}

/**
 * Read a project's metadata from its JSON file.
 */
function readProjectJson(projectDir: string, projectId: string): { worktree?: string } | null {
  const projectFile = join(projectDir, `${projectId}.json`);
  if (!existsSync(projectFile)) {
    // Try reading any JSON file in the directory
    try {
      const files = readdirSync(projectDir).filter(f => f.endsWith('.json'));
      if (files.length > 0) {
        const content = readFileSync(join(projectDir, files[0]!), 'utf-8');
        return JSON.parse(content);
      }
    } catch {
      return null;
    }
    return null;
  }

  try {
    const content = readFileSync(projectFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Discover all OpenCode projects with conversation data.
 */
export function discoverProjects(): OpenCodeProject[] {
  const storagePath = getOpenCodeStoragePath();
  const sessionDir = join(storagePath, 'session');
  const projectDir = join(storagePath, 'project');

  if (!existsSync(sessionDir)) {
    return [];
  }

  const projects: OpenCodeProject[] = [];

  try {
    const entries = readdirSync(sessionDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'global') continue; // Skip global project
      if (entry.name.startsWith('.')) continue; // Skip hidden dirs

      const projectSessionDir = join(sessionDir, entry.name);

      // Check if this directory has any session JSON files
      const sessionFiles = readdirSync(projectSessionDir).filter(
        (f) => f.endsWith('.json') && f.startsWith('ses_')
      );

      if (sessionFiles.length === 0) continue;

      // Get the most recent mtime from any session file
      let latestMtime = 0;
      for (const file of sessionFiles) {
        try {
          const stats = statSync(join(projectSessionDir, file));
          if (stats.mtimeMs > latestMtime) {
            latestMtime = stats.mtimeMs;
          }
        } catch {
          // Skip files we can't stat
        }
      }

      // Read project metadata to get workspace path
      const projectMeta = readProjectJson(projectDir, entry.name);
      const workspacePath = projectMeta?.worktree || `/${entry.name}`;

      projects.push({
        projectId: entry.name,
        workspacePath,
        projectDir: projectSessionDir,
        mtime: latestMtime,
      });
    }
  } catch {
    // If we can't read the sessions directory, return empty
    return [];
  }

  return projects;
}

/**
 * Discover all sessions for a specific project.
 */
export function discoverSessions(project: OpenCodeProject): OpenCodeSession[] {
  const storagePath = getOpenCodeStoragePath();
  const messageBaseDir = join(storagePath, 'message');
  const sessions: OpenCodeSession[] = [];

  try {
    const sessionFiles = readdirSync(project.projectDir).filter(
      (f) => f.endsWith('.json') && f.startsWith('ses_')
    );

    for (const sessionFile of sessionFiles) {
      const sessionId = sessionFile.replace('.json', '');
      const sessionFilePath = join(project.projectDir, sessionFile);
      const messageDir = join(messageBaseDir, sessionId);

      // Get mtime from session file
      let mtime = 0;
      try {
        const stats = statSync(sessionFilePath);
        mtime = stats.mtimeMs;
      } catch {
        // Skip files we can't stat
      }

      sessions.push({
        sessionId,
        projectId: project.projectId,
        workspacePath: project.workspacePath,
        sessionFile: sessionFilePath,
        messageDir,
        mtime,
      });
    }
  } catch {
    // If we can't read the sessions directory, return empty
    return [];
  }

  return sessions;
}

/**
 * Check if OpenCode data exists on this machine.
 */
export function detectOpenCode(): boolean {
  const storagePath = getOpenCodeStoragePath();
  const sessionDir = join(storagePath, 'session');
  return existsSync(sessionDir);
}

/**
 * Get the most recent mtime across OpenCode storage.
 * Checks session files in each project since those update when sessions change.
 */
export function getSessionRootMtime(): number | null {
  const storagePath = getOpenCodeStoragePath();
  const sessionDir = join(storagePath, 'session');

  if (!existsSync(sessionDir)) return null;

  let maxMtime = 0;

  try {
    const projectDirs = readdirSync(sessionDir, { withFileTypes: true });
    for (const entry of projectDirs) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      const projectPath = join(sessionDir, entry.name);
      try {
        const files = readdirSync(projectPath);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            maxMtime = Math.max(maxMtime, statSync(join(projectPath, file)).mtimeMs);
          } catch {}
        }
      } catch {}
    }
  } catch {}

  return maxMtime > 0 ? maxMtime : null;
}
