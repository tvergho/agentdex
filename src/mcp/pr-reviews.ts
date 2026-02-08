/**
 * GitHub PR review fetching logic for the pr_reviews MCP tool.
 * Shells out to `gh` CLI (must be installed and authenticated).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GH_BIN = '/opt/homebrew/bin/gh';

export interface PRListItem {
  number: number;
  title: string;
  author: string;
  createdAt: string;
  mergedAt: string | null;
  reviewDecision: string;
  commentCount: number;
  reviewCount: number;
  files: number;
  additions: number;
  deletions: number;
}

export interface PRListResult {
  prs: PRListItem[];
  total_shown: number;
  has_more: boolean;
}

export interface PRReview {
  author: string;
  state: string;
  body: string;
}

export interface PRComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface PRDetailResult {
  pr: {
    number: number;
    title: string;
    body: string;
    author: string;
    url: string;
  };
  reviews: PRReview[];
  comments: PRComment[];
}

const BOT_PATTERNS = [/\[bot\]$/, /^copilot-/];

function isBot(login: string): boolean {
  return BOT_PATTERNS.some((p) => p.test(login));
}

/**
 * Parse a GitHub remote URL into owner/repo.
 * Handles HTTPS, SSH, and with/without .git suffix.
 */
export function parseGitHubRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const match = remoteUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Fetch a paginated list of PRs with review activity.
 */
export async function fetchPRList(
  repo: string,
  days: number,
  limit: number,
  offset: number,
  state: string,
  minChars: number,
): Promise<PRListResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Build search qualifier based on state
  const stateQualifier = state === 'merged' ? `merged:>${cutoffStr}` : `created:>${cutoffStr}`;

  const args = [
    'pr', 'list',
    '--repo', repo,
    '--state', state === 'merged' ? 'merged' : state,
    '--limit', String(limit + offset),
    '--search', stateQualifier,
    '--json', 'number,title,author,createdAt,mergedAt,reviewDecision,comments,reviews,files,additions,deletions',
  ];

  const { stdout } = await execFileAsync(GH_BIN, args, { maxBuffer: 10 * 1024 * 1024 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any[] = JSON.parse(stdout);

  // Filter and map
  const allPrs: PRListItem[] = raw
    .filter((pr) => !isBot(pr.author?.login || ''))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author?.login || 'unknown',
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt || null,
      reviewDecision: pr.reviewDecision || 'NONE',
      commentCount: (pr.comments || []).filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any) => (c.body || '').length >= minChars && !isBot(c.author?.login || ''),
      ).length,
      reviewCount: (pr.reviews || []).filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r: any) => !isBot(r.author?.login || '') && ((r.body || '').length >= minChars || r.state === 'CHANGES_REQUESTED'),
      ).length,
      files: (pr.files || []).length,
      additions: pr.additions || 0,
      deletions: pr.deletions || 0,
    }));

  // Apply offset
  const prs = allPrs.slice(offset, offset + limit);

  return {
    prs,
    total_shown: prs.length,
    has_more: allPrs.length > offset + limit,
  };
}

/**
 * Fetch the diff for a single PR.
 */
export async function fetchPRDiff(
  repo: string,
  number: number,
): Promise<string> {
  const args = [
    'pr', 'diff', String(number),
    '--repo', repo,
  ];

  const { stdout } = await execFileAsync(GH_BIN, args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/**
 * Fetch detailed PR content including review bodies and comments.
 */
export async function fetchPRDetail(
  repo: string,
  number: number,
  minChars: number,
): Promise<PRDetailResult> {
  const args = [
    'pr', 'view', String(number),
    '--repo', repo,
    '--json', 'number,title,body,author,url,reviews,comments,files',
  ];

  const { stdout } = await execFileAsync(GH_BIN, args, { maxBuffer: 10 * 1024 * 1024 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pr: any = JSON.parse(stdout);

  // Filter reviews: exclude bots, approval-only with empty body, short bodies
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reviews: PRReview[] = (pr.reviews || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((r: any) => {
      if (isBot(r.author?.login || '')) return false;
      const body = (r.body || '').trim();
      // Keep CHANGES_REQUESTED even with empty body (the state itself is informative)
      if (r.state === 'CHANGES_REQUESTED') return true;
      // Skip approval-only with no meaningful body
      if (r.state === 'APPROVED' && body.length < minChars) return false;
      return body.length >= minChars;
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => ({
      author: r.author?.login || 'unknown',
      state: r.state,
      body: (r.body || '').trim(),
    }));

  // Filter comments: exclude bots and short comments
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const comments: PRComment[] = (pr.comments || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((c: any) => {
      if (isBot(c.author?.login || '')) return false;
      return (c.body || '').length >= minChars;
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((c: any) => ({
      author: c.author?.login || 'unknown',
      body: (c.body || '').trim(),
      createdAt: c.createdAt,
    }));

  return {
    pr: {
      number: pr.number,
      title: pr.title,
      body: (pr.body || '').trim(),
      author: pr.author?.login || 'unknown',
      url: pr.url,
    },
    reviews,
    comments,
  };
}
