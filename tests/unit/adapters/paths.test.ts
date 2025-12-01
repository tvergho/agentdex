/**
 * Tests for adapter path modules
 * Tests path resolution and detection functions for each adapter
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, existsSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Cursor paths
import {
  getCursorGlobalDbPath,
  getGlobalDatabase,
} from '../../../src/adapters/cursor/paths';

// Claude Code paths
import {
  getClaudeCodeRootPath,
  discoverProjects as discoverClaudeCodeProjects,
  detectClaudeCode,
} from '../../../src/adapters/claude-code/paths';

// Codex paths
import {
  getCodexRootPath,
  discoverSessions as discoverCodexSessions,
  detectCodex,
} from '../../../src/adapters/codex/paths';

// OpenCode paths
import {
  getOpenCodeRootPath,
  getOpenCodeStoragePath,
  discoverProjects as discoverOpenCodeProjects,
  detectOpenCode,
} from '../../../src/adapters/opencode/paths';

// Store original HOME for cleanup
const originalHome = process.env.HOME;
let tempDir: string;

beforeEach(() => {
  tempDir = join('/tmp', `dex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  // Override HOME to use temp directory for path resolution
  process.env.HOME = tempDir;
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============ Cursor Paths ============

describe('Cursor paths', () => {
  describe('getCursorGlobalDbPath', () => {
    it('returns a path containing Cursor and state.vscdb', () => {
      const dbPath = getCursorGlobalDbPath();
      expect(dbPath).toContain('Cursor');
      expect(dbPath).toContain('state.vscdb');
    });

    it('expands home directory', () => {
      const dbPath = getCursorGlobalDbPath();
      expect(dbPath).not.toContain('~');
      expect(dbPath.startsWith('/')).toBe(true);
    });
  });

  describe('getGlobalDatabase', () => {
    it('returns null when database does not exist', () => {
      const result = getGlobalDatabase();
      expect(result).toBeNull();
    });

    it('returns database info when file exists', () => {
      // Create mock database file at expected location
      const dbPath = getCursorGlobalDbPath();
      mkdirSync(join(dbPath, '..'), { recursive: true });
      writeFileSync(dbPath, 'mock database content');

      const result = getGlobalDatabase();
      expect(result).not.toBeNull();
      expect(result!.dbPath).toBe(dbPath);
      expect(result!.mtime).toBeGreaterThan(0);
    });
  });
});

// ============ Claude Code Paths ============

describe('Claude Code paths', () => {
  describe('getClaudeCodeRootPath', () => {
    it('returns path under home directory', () => {
      const rootPath = getClaudeCodeRootPath();
      expect(rootPath).toBe(join(tempDir, '.claude'));
    });
  });

  describe('detectClaudeCode', () => {
    it('returns false when projects directory does not exist', () => {
      expect(detectClaudeCode()).toBe(false);
    });

    it('returns true when projects directory exists', () => {
      mkdirSync(join(tempDir, '.claude', 'projects'), { recursive: true });
      expect(detectClaudeCode()).toBe(true);
    });
  });

  describe('discoverProjects', () => {
    it('returns empty array when no projects exist', () => {
      const projects = discoverClaudeCodeProjects();
      expect(projects).toEqual([]);
    });

    it('returns empty array when projects dir exists but is empty', () => {
      mkdirSync(join(tempDir, '.claude', 'projects'), { recursive: true });
      const projects = discoverClaudeCodeProjects();
      expect(projects).toEqual([]);
    });

    it('discovers projects with session files', () => {
      const projectDir = join(tempDir, '.claude', 'projects', '-Users-test-myproject');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'session-123.jsonl'), '{"type": "user"}');

      const projects = discoverClaudeCodeProjects();
      expect(projects.length).toBe(1);
      expect(projects[0]!.projectPath).toBe('-Users-test-myproject');
      expect(projects[0]!.workspacePath).toBe('/Users/test/myproject');
    });

    it('skips directories without session files', () => {
      const projectDir = join(tempDir, '.claude', 'projects', '-Users-test-empty');
      mkdirSync(projectDir, { recursive: true });
      // No .jsonl files

      const projects = discoverClaudeCodeProjects();
      expect(projects).toEqual([]);
    });

    it('skips agent- prefixed files', () => {
      const projectDir = join(tempDir, '.claude', 'projects', '-Users-test-project');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'agent-config.jsonl'), '{}');

      const projects = discoverClaudeCodeProjects();
      expect(projects).toEqual([]);
    });

    it('handles Windows-style paths', () => {
      const projectDir = join(tempDir, '.claude', 'projects', 'C-Users-test-project');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'session.jsonl'), '{}');

      const projects = discoverClaudeCodeProjects();
      expect(projects.length).toBe(1);
      expect(projects[0]!.workspacePath).toBe('C:/Users/test/project');
    });
  });
});

// ============ Codex Paths ============

describe('Codex paths', () => {
  describe('getCodexRootPath', () => {
    it('returns path under home directory', () => {
      delete process.env.CODEX_HOME;
      const rootPath = getCodexRootPath();
      expect(rootPath).toBe(join(tempDir, '.codex'));
    });

    it('respects CODEX_HOME environment variable', () => {
      process.env.CODEX_HOME = '/custom/codex/path';
      const rootPath = getCodexRootPath();
      expect(rootPath).toBe('/custom/codex/path');
      delete process.env.CODEX_HOME;
    });
  });

  describe('detectCodex', () => {
    it('returns false when sessions directory does not exist', () => {
      delete process.env.CODEX_HOME;
      expect(detectCodex()).toBe(false);
    });

    it('returns true when sessions directory exists', () => {
      delete process.env.CODEX_HOME;
      mkdirSync(join(tempDir, '.codex', 'sessions'), { recursive: true });
      expect(detectCodex()).toBe(true);
    });
  });

  describe('discoverSessions', () => {
    beforeEach(() => {
      delete process.env.CODEX_HOME;
    });

    it('returns empty array when no sessions exist', () => {
      const sessions = discoverCodexSessions();
      expect(sessions).toEqual([]);
    });

    it('discovers rollout session files', () => {
      const sessionDir = join(tempDir, '.codex', 'sessions', '2025', '01', '15');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'rollout-2025-01-15T10-30-00-abc123-def456.jsonl'),
        '{}'
      );

      const sessions = discoverCodexSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.sessionId).toBe('abc123-def456');
    });

    it('skips non-rollout files', () => {
      const sessionDir = join(tempDir, '.codex', 'sessions', '2025', '01');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'config.json'), '{}');

      const sessions = discoverCodexSessions();
      expect(sessions).toEqual([]);
    });

    it('discovers sessions across multiple date directories', () => {
      const sessionDir1 = join(tempDir, '.codex', 'sessions', '2025', '01', '01');
      const sessionDir2 = join(tempDir, '.codex', 'sessions', '2025', '01', '02');
      mkdirSync(sessionDir1, { recursive: true });
      mkdirSync(sessionDir2, { recursive: true });
      writeFileSync(join(sessionDir1, 'rollout-2025-01-01T10-00-00-aaa111.jsonl'), '{}');
      writeFileSync(join(sessionDir2, 'rollout-2025-01-02T10-00-00-bbb222.jsonl'), '{}');

      const sessions = discoverCodexSessions();
      expect(sessions.length).toBe(2);
    });
  });
});

// ============ OpenCode Paths ============

describe('OpenCode paths', () => {
  describe('getOpenCodeRootPath', () => {
    it('returns path under home directory', () => {
      const rootPath = getOpenCodeRootPath();
      expect(rootPath).toBe(join(tempDir, '.local', 'share', 'opencode'));
    });
  });

  describe('getOpenCodeStoragePath', () => {
    it('returns storage path', () => {
      const storagePath = getOpenCodeStoragePath();
      expect(storagePath).toBe(join(tempDir, '.local', 'share', 'opencode', 'storage'));
    });
  });

  describe('detectOpenCode', () => {
    it('returns false when session directory does not exist', () => {
      expect(detectOpenCode()).toBe(false);
    });

    it('returns true when session directory exists', () => {
      mkdirSync(join(tempDir, '.local', 'share', 'opencode', 'storage', 'session'), { recursive: true });
      expect(detectOpenCode()).toBe(true);
    });
  });

  describe('discoverProjects', () => {
    it('returns empty array when no projects exist', () => {
      const projects = discoverOpenCodeProjects();
      expect(projects).toEqual([]);
    });

    it('discovers projects with session files', () => {
      const storagePath = join(tempDir, '.local', 'share', 'opencode', 'storage');
      const projectId = 'abc123hash';
      
      // Create session directory with session file
      const sessionDir = join(storagePath, 'session', projectId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'ses_001.json'), '{}');
      
      // Create project directory with metadata
      const projectDir = join(storagePath, 'project');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, `${projectId}.json`),
        JSON.stringify({ worktree: '/Users/test/myproject' })
      );

      const projects = discoverOpenCodeProjects();
      expect(projects.length).toBe(1);
      expect(projects[0]!.projectId).toBe(projectId);
      expect(projects[0]!.workspacePath).toBe('/Users/test/myproject');
    });

    it('skips global project', () => {
      const storagePath = join(tempDir, '.local', 'share', 'opencode', 'storage');
      const globalDir = join(storagePath, 'session', 'global');
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(globalDir, 'ses_001.json'), '{}');

      const projects = discoverOpenCodeProjects();
      expect(projects).toEqual([]);
    });

    it('uses project ID as fallback workspace path', () => {
      const storagePath = join(tempDir, '.local', 'share', 'opencode', 'storage');
      const projectId = 'xyz789';
      
      // Create session directory without project metadata
      const sessionDir = join(storagePath, 'session', projectId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'ses_001.json'), '{}');

      const projects = discoverOpenCodeProjects();
      expect(projects.length).toBe(1);
      expect(projects[0]!.workspacePath).toBe(`/${projectId}`);
    });

    it('skips directories without session files', () => {
      const storagePath = join(tempDir, '.local', 'share', 'opencode', 'storage');
      const sessionDir = join(storagePath, 'session', 'emptyproject');
      mkdirSync(sessionDir, { recursive: true });
      // No ses_*.json files

      const projects = discoverOpenCodeProjects();
      expect(projects).toEqual([]);
    });
  });
});

