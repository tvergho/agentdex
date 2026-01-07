import simpleGit, { type SimpleGit } from 'simple-git';
import { existsSync, statSync } from 'fs';
import { dirname, join } from 'path';

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  authorEmail: string;
  date: Date;
  filesChanged: string[];
}

export interface CommitDiff {
  hash: string;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    isBinary: boolean;
  }>;
  rawDiff: string;
}

let cachedGit: SimpleGit | null = null;
let cachedRepoRoot: string | null = null;

function getGit(repoPath: string): SimpleGit {
  if (cachedGit && cachedRepoRoot === repoPath) {
    return cachedGit;
  }
  cachedGit = simpleGit(repoPath);
  cachedRepoRoot = repoPath;
  return cachedGit;
}

export async function findRepoRoot(startPath: string): Promise<string | null> {
  let current = startPath;

  if (!existsSync(current)) {
    return null;
  }

  const stats = statSync(current);
  if (!stats.isDirectory()) {
    current = dirname(current);
  }

  while (current !== '/') {
    const gitDir = join(current, '.git');
    if (existsSync(gitDir)) {
      return current;
    }
    current = dirname(current);
  }

  return null;
}

export async function isGitRepository(path: string): Promise<boolean> {
  const root = await findRepoRoot(path);
  return root !== null;
}

export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const git = getGit(repoPath);
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    return branch.trim() || null;
  } catch {
    return null;
  }
}

async function findBaseBranch(repoPath: string, preferredBase: string): Promise<string | null> {
  const candidates = [
    `origin/${preferredBase}`,
    preferredBase,
    'origin/main',
    'main',
    'origin/master',
    'master',
    'origin/dev',
    'dev',
  ];

  for (const candidate of candidates) {
    if (await branchExists(repoPath, candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function getCommitsOnBranch(
  repoPath: string,
  branch: string,
  baseBranch = 'main',
  limit = 100
): Promise<CommitInfo[]> {
  const git = getGit(repoPath);

  try {
    const targetExists = await branchExists(repoPath, branch);
    if (!targetExists) {
      return [];
    }

    const resolvedBase = await findBaseBranch(repoPath, baseBranch);

    let logArgs: string[];
    if (resolvedBase && branch !== resolvedBase && branch !== baseBranch) {
      logArgs = [`${resolvedBase}..${branch}`, `-n${limit}`];
    } else {
      logArgs = [branch, `-n${limit}`];
    }

    const rawLog = await git.raw([
      'log',
      ...logArgs,
      '--format=%H%n%s%n%an%n%ae%n%aI%n---COMMIT_END---',
    ]);

    if (!rawLog.trim()) {
      return [];
    }

    const commitBlocks = rawLog.split('---COMMIT_END---').filter((b) => b.trim());
    const commits: CommitInfo[] = [];

    for (const block of commitBlocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 5) continue;

      const hash = lines[0] || '';
      const message = lines[1] || '';
      const author = lines[2] || '';
      const authorEmail = lines[3] || '';
      const dateStr = lines[4] || '';

      if (!hash) continue;

      const filesResult = await git.raw([
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        hash,
      ]);

      commits.push({
        hash,
        shortHash: hash.slice(0, 7),
        message,
        author,
        authorEmail,
        date: new Date(dateStr),
        filesChanged: filesResult
          .trim()
          .split('\n')
          .filter((f) => f.length > 0),
      });
    }

    return commits;
  } catch {
    return [];
  }
}

export async function getCommitDiff(repoPath: string, commitHash: string): Promise<CommitDiff | null> {
  const git = getGit(repoPath);

  try {
    const numstatResult = await git.raw(['diff-tree', '--numstat', '--root', '-r', commitHash]);
    const diffResult = await git.raw(['show', '--format=', commitHash]);

    const lines = numstatResult.trim().split('\n').filter((l) => l.length > 0);
    const files: CommitDiff['files'] = [];

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const [addStr, delStr, path] = parts;
      if (!path) continue;

      const isBinary = addStr === '-' && delStr === '-';
      files.push({
        path,
        additions: isBinary ? 0 : parseInt(addStr || '0', 10),
        deletions: isBinary ? 0 : parseInt(delStr || '0', 10),
        isBinary,
      });
    }

    return {
      hash: commitHash,
      files,
      rawDiff: diffResult,
    };
  } catch {
    return null;
  }
}

export async function getCommitInfo(repoPath: string, commitHash: string): Promise<CommitInfo | null> {
  const git = getGit(repoPath);

  try {
    const log = await git.log({
      from: commitHash,
      to: commitHash,
      maxCount: 1,
    });

    if (log.all.length === 0) {
      return null;
    }

    const entry = log.all[0];
    if (!entry) return null;

    const filesResult = await git.raw([
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      commitHash,
    ]);

    return {
      hash: entry.hash,
      shortHash: entry.hash.slice(0, 7),
      message: entry.message,
      author: entry.author_name,
      authorEmail: entry.author_email,
      date: new Date(entry.date),
      filesChanged: filesResult
        .trim()
        .split('\n')
        .filter((f) => f.length > 0),
    };
  } catch {
    return null;
  }
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const git = getGit(repoPath);

  try {
    await git.revparse(['--verify', branch]);
    return true;
  } catch {
    return false;
  }
}

export async function listBranches(repoPath: string): Promise<string[]> {
  const git = getGit(repoPath);

  try {
    const result = await git.branch(['-a']);
    return result.all;
  } catch {
    return [];
  }
}

export async function getCommitsBetween(
  repoPath: string,
  fromHash: string,
  toHash: string
): Promise<CommitInfo[]> {
  const git = getGit(repoPath);

  try {
    const log = await git.log({
      from: fromHash,
      to: toHash,
    });

    const commits: CommitInfo[] = [];

    for (const entry of log.all) {
      const filesResult = await git.raw([
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        entry.hash,
      ]);

      commits.push({
        hash: entry.hash,
        shortHash: entry.hash.slice(0, 7),
        message: entry.message,
        author: entry.author_name,
        authorEmail: entry.author_email,
        date: new Date(entry.date),
        filesChanged: filesResult
          .trim()
          .split('\n')
          .filter((f) => f.length > 0),
      });
    }

    return commits;
  } catch {
    return [];
  }
}

export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  const git = getGit(repoPath);

  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    return origin?.refs?.fetch || origin?.refs?.push || null;
  } catch {
    return null;
  }
}

export interface BranchDiff {
  branch: string;
  baseBranch: string;
  filesChanged: string[];
  rawDiff: string;
  additions: number;
  deletions: number;
}

export async function getBranchDiff(
  repoPath: string,
  branch: string,
  baseBranch: string
): Promise<BranchDiff | null> {
  const git = getGit(repoPath);

  try {
    const resolvedBase = await findBaseBranch(repoPath, baseBranch);
    if (!resolvedBase) return null;

    const mergeBase = await git.raw(['merge-base', resolvedBase, branch]);
    const baseCommit = mergeBase.trim();

    const rawDiff = await git.raw(['diff', baseCommit, branch]);
    const numstat = await git.raw(['diff', '--numstat', baseCommit, branch]);

    const files: string[] = [];
    let additions = 0;
    let deletions = 0;

    for (const line of numstat.trim().split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const [addStr, delStr, path] = parts;
      if (!path) continue;

      files.push(path);
      if (addStr !== '-') additions += parseInt(addStr || '0', 10);
      if (delStr !== '-') deletions += parseInt(delStr || '0', 10);
    }

    return {
      branch,
      baseBranch: resolvedBase,
      filesChanged: files,
      rawDiff,
      additions,
      deletions,
    };
  } catch {
    return null;
  }
}
