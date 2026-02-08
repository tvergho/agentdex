/**
 * Types for the dex reflect feature
 */

export interface ReflectionOptions {
  /** Workspace path prefix (auto-detected from cwd if omitted) */
  project?: string;
  /** Time window in days, default 90 */
  days?: number;
  /** Filter by source (cursor, claude-code, codex, opencode) */
  source?: string;
  /** Custom output directory (overrides auto-detection) */
  output?: string;
  /** Print to stdout without writing files */
  dryRun?: boolean;
  /** Structured JSON output */
  json?: boolean;
  /** Regenerate from scratch (ignore existing CLAUDE.md) */
  force?: boolean;
  /** Override model (e.g. 'claude-opus-4-6', 'gpt-5.1-codex-high') */
  model?: string;
  /** Auto-detected GitHub repo in owner/repo format */
  githubRepo?: string;
  /** Skip PR review analysis */
  noPrs?: boolean;
  /** Progress callback for parallel task execution */
  onProgress?: ProgressCallback;
}

export interface GeneratedFile {
  /** Relative path from project root (e.g. "CLAUDE.md", "src/backend/CLAUDE.md") */
  path: string;
  content: string;
}

export interface ReflectionResult {
  files: GeneratedFile[];
  /** Human-readable summary of what was generated */
  summary: string;
  /** Resolved absolute project path */
  projectRoot: string;
}

// --- Survey types ---

export interface SurveyResult {
  projectRoot: string;
  conversationCount: number;
  githubRepo: string | null;
  existingClaudeMd: string | null;
  majorDirectories: DirectoryInfo[];
  /** Pre-fetched PR review data (if GitHub repo detected) */
  prSurveyData?: PRSurveyData;
}

export interface DirectoryInfo {
  relativePath: string;
  hasPackageJson: boolean;
  packageName?: string;
}

// --- Task types ---

export type TaskKind = 'rules' | 'skills' | 'directory' | 'pr-reviews';

export interface ReflectionTask {
  id: string;
  kind: TaskKind;
  label: string;
  targetFiles: string[];
  context: TaskContext;
}

export type TaskContext =
  | { kind: 'rules'; existingClaudeMd: string | null }
  | { kind: 'skills' }
  | { kind: 'directory'; relativePath: string; packageName?: string }
  | { kind: 'pr-reviews'; githubRepo: string; prData?: PRSurveyData };

// --- PR materialization types ---

export interface PRSurveyData {
  /** Directory containing materialized PR files (for debugging/caching) */
  dir: string;
  /** Number of PRs materialized */
  count: number;
  /** Concatenated review/comment content for direct injection into prompt */
  inlineContent: string;
}

// --- Result types ---

export interface TaskResult {
  taskId: string;
  status: 'success' | 'error';
  files: GeneratedFile[];
  summary: string;
  error?: string;
  durationMs: number;
}

export type ProgressCallback = (
  taskId: string,
  status: 'started' | 'completed' | 'failed',
  detail?: string,
) => void;
