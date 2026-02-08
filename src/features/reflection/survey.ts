/**
 * Programmatic project survey — no LLM needed.
 * Resolves project root, detects GitHub repo, reads existing CLAUDE.md,
 * counts conversations, and scans for major subdirectories.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findRepoRoot, getRemoteUrl } from '../../git/index.js';
import { parseGitHubRepo, fetchPRList, fetchPRDetail, fetchPRDiff } from '../../mcp/pr-reviews.js';
import type { ReflectionOptions, SurveyResult, DirectoryInfo, PRSurveyData } from './types.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.output',
  'coverage', '.turbo', '.cache', '__pycache__', '.venv', 'venv', '.tox',
  '.svelte-kit', '.parcel-cache', '.expo', 'out',
]);

const MONOREPO_PARENTS = new Set(['packages', 'apps', 'libs', 'modules', 'services']);

export async function resolveProjectRoot(project?: string): Promise<string> {
  if (project) return project;
  const repoRoot = await findRepoRoot(process.cwd());
  if (repoRoot) return repoRoot;
  return process.cwd();
}

/**
 * Scan for subdirectories with their own package.json (indicating distinct sub-projects).
 * Also checks one level deeper for monorepo patterns (packages/core/, apps/web/).
 */
export function detectMajorDirectories(projectRoot: string): DirectoryInfo[] {
  const dirs: DirectoryInfo[] = [];

  try {
    const entries = readdirSync(projectRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

      const dirPath = join(projectRoot, entry.name);
      const pkgPath = join(dirPath, 'package.json');
      const hasPackageJson = existsSync(pkgPath);

      if (hasPackageJson) {
        dirs.push({
          relativePath: entry.name,
          hasPackageJson: true,
          packageName: readPackageName(pkgPath),
        });
      }

      // Check one level deeper for monorepo patterns
      if (MONOREPO_PARENTS.has(entry.name)) {
        try {
          const subEntries = readdirSync(dirPath, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (!subEntry.isDirectory() || SKIP_DIRS.has(subEntry.name)) continue;
            const subPkgPath = join(dirPath, subEntry.name, 'package.json');
            if (existsSync(subPkgPath)) {
              dirs.push({
                relativePath: `${entry.name}/${subEntry.name}`,
                hasPackageJson: true,
                packageName: readPackageName(subPkgPath),
              });
            }
          }
        } catch {
          // Permission errors, etc.
        }
      }
    }
  } catch {
    // Permission errors, etc.
  }

  return dirs;
}

function readPackageName(pkgPath: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.name === 'string' ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Count conversations for this project in the dex database.
 * Returns -1 on any error (DB not initialized, etc.).
 */
async function countConversations(
  projectRoot: string,
  options: ReflectionOptions,
): Promise<number> {
  try {
    const { conversationRepo } = await import('../../db/repository.js');

    const fromDate = options.days
      ? new Date(Date.now() - options.days * 24 * 60 * 60 * 1000).toISOString()
      : undefined;

    const result = await conversationRepo.list({
      project: projectRoot,
      source: options.source,
      fromDate,
      limit: 1,
    });

    return result.total;
  } catch {
    // DB not initialized — assume there might be conversations
    return -1;
  }
}

// Max diff size to include per PR (truncate large diffs to save tokens)
const MAX_DIFF_CHARS = 15_000;

/**
 * Materialize PRs with reviews, comments, and diffs to filesystem.
 * Fetches up to 50 merged PRs, writes each as a markdown file so the
 * LLM can agentically read through them without MCP tool calls.
 *
 * Directory structure:
 *   ~/.dex/pr-cache/{owner}/{repo}/
 *     _index.md       — summary table of all PRs
 *     pr-123.md       — full detail + diff for PR #123
 */
async function materializePRs(
  repo: string,
  days: number,
): Promise<PRSurveyData | undefined> {
  try {
    const list = await fetchPRList(repo, days, 50, 0, 'merged', 20);
    if (list.prs.length === 0) return undefined;

    // Sort by review activity
    const sorted = [...list.prs].sort(
      (a, b) => (b.reviewCount + b.commentCount) - (a.reviewCount + a.commentCount),
    );

    // Keep PRs with any review activity
    const withActivity = sorted.filter((pr) => pr.reviewCount + pr.commentCount > 0);
    if (withActivity.length === 0) return undefined;

    // Set up output directory
    const dir = join(homedir(), '.dex', 'pr-cache', ...repo.split('/'));
    // Clean previous run
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });

    // Fetch details + diffs in parallel (batches of 10 to avoid rate limits)
    const BATCH = 10;
    const allResults: { pr: typeof withActivity[0]; detail: Awaited<ReturnType<typeof fetchPRDetail>> | null; diff: string | null }[] = [];

    for (let i = 0; i < withActivity.length; i += BATCH) {
      const batch = withActivity.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (pr) => {
          const [detail, diff] = await Promise.all([
            fetchPRDetail(repo, pr.number, 20).catch(() => null),
            fetchPRDiff(repo, pr.number).catch(() => null),
          ]);
          return { pr, detail, diff };
        }),
      );
      allResults.push(...results);
    }

    // Write individual PR files
    let written = 0;
    for (const { pr, detail, diff } of allResults) {
      const lines: string[] = [];
      lines.push(`# PR #${pr.number}: ${pr.title}`);
      lines.push('');
      lines.push(`- **Author:** ${pr.author}`);
      lines.push(`- **Review Decision:** ${pr.reviewDecision}`);
      lines.push(`- **Files Changed:** ${pr.files} (+${pr.additions} -${pr.deletions})`);
      lines.push(`- **Created:** ${pr.createdAt}`);
      if (pr.mergedAt) lines.push(`- **Merged:** ${pr.mergedAt}`);
      lines.push('');

      if (detail) {
        if (detail.pr.body) {
          lines.push('## Description');
          lines.push('');
          lines.push(detail.pr.body);
          lines.push('');
        }

        if (detail.reviews.length > 0) {
          lines.push('## Reviews');
          lines.push('');
          for (const review of detail.reviews) {
            lines.push(`### ${review.author} (${review.state})`);
            if (review.body) {
              lines.push('');
              lines.push(review.body);
            }
            lines.push('');
          }
        }

        if (detail.comments.length > 0) {
          lines.push('## Comments');
          lines.push('');
          for (const comment of detail.comments) {
            lines.push(`### ${comment.author}`);
            lines.push('');
            lines.push(comment.body);
            lines.push('');
          }
        }
      }

      if (diff) {
        lines.push('## Diff');
        lines.push('');
        lines.push('```diff');
        if (diff.length > MAX_DIFF_CHARS) {
          lines.push(diff.slice(0, MAX_DIFF_CHARS));
          lines.push(`\n... (truncated, ${diff.length} chars total)`);
        } else {
          lines.push(diff);
        }
        lines.push('```');
      }

      writeFileSync(join(dir, `pr-${pr.number}.md`), lines.join('\n'));
      written++;
    }

    // Write index file
    const indexLines: string[] = [];
    indexLines.push(`# PR Reviews: ${repo}`);
    indexLines.push('');
    indexLines.push(`${written} PRs with review activity (last ${days} days)`);
    indexLines.push('');
    indexLines.push('| # | Title | Author | Decision | Reviews | Comments | Files |');
    indexLines.push('|---|-------|--------|----------|---------|----------|-------|');
    for (const { pr } of allResults) {
      indexLines.push(`| ${pr.number} | ${pr.title} | ${pr.author} | ${pr.reviewDecision} | ${pr.reviewCount} | ${pr.commentCount} | ${pr.files} |`);
    }
    indexLines.push('');
    indexLines.push('## Files');
    indexLines.push('');
    for (const { pr } of allResults) {
      indexLines.push(`- \`pr-${pr.number}.md\` — ${pr.title}`);
    }

    writeFileSync(join(dir, '_index.md'), indexLines.join('\n'));

    // Build inline content (reviews + comments only, no diffs) for prompt injection.
    // This lets the LLM analyze in a single turn without any tool calls.
    const inlineParts: string[] = [];
    for (const { pr, detail } of allResults) {
      if (!detail) continue;
      const hasReviews = detail.reviews.length > 0;
      const hasComments = detail.comments.length > 0;
      if (!hasReviews && !hasComments) continue;

      const parts: string[] = [];
      parts.push(`## PR #${pr.number}: ${pr.title}`);
      parts.push(`Author: ${pr.author} | Decision: ${pr.reviewDecision} | Files: ${pr.files} (+${pr.additions} -${pr.deletions})`);
      if (detail.pr.body) {
        // Truncate long PR descriptions
        const body = detail.pr.body.length > 500 ? detail.pr.body.slice(0, 500) + '...' : detail.pr.body;
        parts.push(`Description: ${body}`);
      }
      parts.push('');

      for (const review of detail.reviews) {
        parts.push(`**Review by ${review.author} (${review.state}):**`);
        if (review.body) parts.push(review.body);
        parts.push('');
      }

      for (const comment of detail.comments) {
        parts.push(`**Comment by ${comment.author}:**`);
        parts.push(comment.body);
        parts.push('');
      }

      inlineParts.push(parts.join('\n'));
    }

    const inlineContent = inlineParts.join('\n---\n\n');

    return { dir, count: written, inlineContent };
  } catch {
    // gh CLI not available or auth issue — skip
    return undefined;
  }
}

export async function surveyProject(options: ReflectionOptions): Promise<SurveyResult> {
  const projectRoot = await resolveProjectRoot(options.project);

  // Auto-detect GitHub repo
  let githubRepo: string | null = options.githubRepo || null;
  if (!options.noPrs && !githubRepo) {
    const remoteUrl = await getRemoteUrl(projectRoot);
    if (remoteUrl) {
      const parsed = parseGitHubRepo(remoteUrl);
      if (parsed) {
        githubRepo = `${parsed.owner}/${parsed.repo}`;
      }
    }
  }

  // Read existing CLAUDE.md
  let existingClaudeMd: string | null = null;
  if (!options.force) {
    const claudeMdPath = join(projectRoot, 'CLAUDE.md');
    if (existsSync(claudeMdPath)) {
      existingClaudeMd = readFileSync(claudeMdPath, 'utf-8');
    }
  }

  // Count conversations and materialize PR data in parallel
  const days = options.days ?? 90;
  const [conversationCount, prSurveyData] = await Promise.all([
    countConversations(projectRoot, options),
    githubRepo && !options.noPrs
      ? materializePRs(githubRepo, days)
      : Promise.resolve(undefined),
  ]);

  // Detect directories
  const majorDirectories = detectMajorDirectories(projectRoot);

  return {
    projectRoot,
    conversationCount,
    githubRepo,
    existingClaudeMd,
    majorDirectories,
    prSurveyData,
  };
}
