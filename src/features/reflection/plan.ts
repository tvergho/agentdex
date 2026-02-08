/**
 * Deterministic task generation from survey results.
 * No LLM needed — generates tasks based on project structure.
 */

import type { DirectoryInfo, ReflectionOptions, ReflectionTask, SurveyResult } from './types.js';

// Max directory tasks — only the highest-priority dirs get their own CLAUDE.md.
// Root CLAUDE.md already covers project-wide patterns; dir tasks are for dirs
// with distinct tech stacks or conventions (frontend, backend, etc.).
const MAX_DIR_TASKS = 2;

// Directories most likely to have meaningful conversation history, in priority order
const DIR_PRIORITY = [
  'frontend', 'src', 'backend', 'server', 'api', 'app', 'web',
  'functions', 'services', 'packages', 'apps', 'libs',
];

/**
 * Score directories by likelihood of having meaningful conversation data.
 * Higher = more likely to be important.
 */
function scoreDirPriority(dir: DirectoryInfo): number {
  const isNested = dir.relativePath.includes('/');
  const topName = dir.relativePath.split('/')[0]!;
  const idx = DIR_PRIORITY.indexOf(topName);

  if (!isNested && idx >= 0) {
    // Top-level dir matching priority list (frontend, functions, etc.) — highest
    return 100 - idx;
  }
  // Everything else (non-priority top-level, nested monorepo packages) — low
  // These rarely justify their own CLAUDE.md; root file covers them.
  return 5;
}

export function planTasks(survey: SurveyResult, options: ReflectionOptions): ReflectionTask[] {
  // No conversations → nothing to analyze
  if (survey.conversationCount === 0) return [];

  const tasks: ReflectionTask[] = [];

  // 1. Always: root CLAUDE.md (coding conventions, architecture, commands, pitfalls)
  tasks.push({
    id: 'rules',
    kind: 'rules',
    label: 'Root CLAUDE.md (patterns & conventions)',
    targetFiles: ['CLAUDE.md'],
    context: {
      kind: 'rules',
      existingClaudeMd: survey.existingClaudeMd,
    },
  });

  // 2. Always: skills extraction
  tasks.push({
    id: 'skills',
    kind: 'skills',
    label: 'Skill files (.claude/skills/)',
    targetFiles: ['.claude/skills/'],
    context: { kind: 'skills' },
  });

  // 3. Conditionally: per-directory CLAUDE.md for the most important subdirectories
  const sortedDirs = [...survey.majorDirectories].sort(
    (a, b) => scoreDirPriority(b) - scoreDirPriority(a),
  );
  const selectedDirs = sortedDirs.slice(0, MAX_DIR_TASKS);

  for (const dir of selectedDirs) {
    tasks.push({
      id: `dir:${dir.relativePath}`,
      kind: 'directory',
      label: `${dir.relativePath}/CLAUDE.md`,
      targetFiles: [`${dir.relativePath}/CLAUDE.md`],
      context: {
        kind: 'directory',
        relativePath: dir.relativePath,
        packageName: dir.packageName,
      },
    });
  }

  // 4. Conditionally: PR reviews (if GitHub repo detected and not disabled)
  if (survey.githubRepo && !options.noPrs) {
    tasks.push({
      id: 'pr-reviews',
      kind: 'pr-reviews',
      label: 'PR review patterns',
      targetFiles: ['CLAUDE.md'],
      context: {
        kind: 'pr-reviews',
        githubRepo: survey.githubRepo,
        prData: survey.prSurveyData,
      },
    });
  }

  return tasks;
}
