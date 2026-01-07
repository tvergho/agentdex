import { connect } from '../../db/index.js';
import { conversationRepo, fileEditsRepo, messageRepo } from '../../db/repository.js';
import {
  findRepoRoot,
  getCommitsOnBranch,
  getCurrentBranch,
  branchExists,
  getCommitDiff,
  getBranchDiff,
  type CommitInfo,
  type BranchDiff,
} from '../../git/index.js';
import type { Conversation, FileEdit } from '../../schema/index.js';
import { getSourceInfo } from '../../schema/index.js';
import { getRepoName } from '../../utils/export.js';

interface ReviewOptions {
  base?: string;
  limit?: string;
  json?: boolean;
  repo?: string;
  export?: string;
}

interface ConversationMatch {
  conversation: Conversation;
  commits: CommitInfo[];
  fileEdits: FileEdit[];
  allCodeLines: Set<string>;
  confidence: 'high' | 'medium' | 'low';
  matchReasons: string[];
  matchedLineCount: number;
}

interface LineAttribution {
  lineNumber: number;
  lineContent: string;
  conversationId: string;
  conversationTitle: string;
  fileEditPath: string;
}

interface CommitCoverage {
  commit: CommitInfo;
  totalLines: number;
  matchedLines: number;
  coveragePercent: number;
  matchedConversations: string[];
  lineAttributions: LineAttribution[];
}

interface BranchCoverage {
  totalLines: number;
  matchedLines: number;
  coveragePercent: number;
  matchedConversations: string[];
  lineAttributions: LineAttribution[];
}

interface ReviewResult {
  branch: string;
  baseBranch: string;
  repoPath: string;
  totalCommits: number;
  conversations: ConversationMatch[];
  unmatchedCommits: CommitInfo[];
  commitCoverage: CommitCoverage[];
  branchCoverage: BranchCoverage;
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return dateStr.split('T')[0] || '';
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len - 3) + '...';
}

function normalizeFilePath(path: string): string {
  const parts = path.split('/');
  const idx = parts.findIndex((p) => p === 'src' || p === 'frontend' || p === 'functions' || p === 'packages');
  if (idx >= 0) {
    return parts.slice(idx).join('/');
  }
  return parts.slice(-3).join('/');
}

const GENERIC_FILE_PATTERNS = [
  /\/types\//,
  /\/types\.ts$/,
  /\/index\.(ts|tsx|js|jsx)$/,
  /\/config\.(ts|tsx|js|jsx)$/,
  /\/constants\.(ts|tsx|js|jsx)$/,
  /\/utils\.(ts|tsx|js|jsx)$/,
  /\/helpers\.(ts|tsx|js|jsx)$/,
  /package\.json$/,
  /tsconfig\.json$/,
];

function isGenericFile(filePath: string): boolean {
  return GENERIC_FILE_PATTERNS.some((p) => p.test(filePath));
}

function extractAddedLines(diff: string): string[] {
  const lines: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1).trim();
      if (content.length > 0) {
        lines.push(content);
      }
    }
  }
  return lines;
}

function extractCodeBlockLines(content: string): string[] {
  const codeBlockRegex = /```(?:ts|typescript|js|javascript|tsx|jsx|python|py|bash|sh|sql|json|yaml|yml|css|html|xml|go|rust|java|c|cpp|csharp|ruby|php)?\n([\s\S]*?)```/g;
  const lines: string[] = [];
  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const code = match[1] || '';
    for (const line of code.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 5) {
        lines.push(trimmed);
      }
    }
  }
  return lines;
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'must', 'can', 'and', 'or', 'but', 'if', 'then', 'else',
    'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom', 'this', 'that',
    'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him',
    'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'for', 'to',
    'from', 'with', 'in', 'on', 'at', 'by', 'of', 'about', 'into', 'through',
    'add', 'update', 'fix', 'remove', 'change', 'make', 'get', 'set', 'new',
    'create', 'delete', 'use', 'using', 'work', 'working', 'some', 'more',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word));
}

function textSimilarity(text1: string, text2: string): number {
  const keywords1 = new Set(extractKeywords(text1));
  const keywords2 = new Set(extractKeywords(text2));

  if (keywords1.size === 0 || keywords2.size === 0) return 0;

  let matches = 0;
  for (const kw of keywords1) {
    if (keywords2.has(kw)) matches++;
  }

  const union = new Set([...keywords1, ...keywords2]);
  return matches / union.size;
}

const MAX_HOURS_AFTER_CONVERSATION = 168;
const MIN_HOURS_BEFORE_CONVERSATION = -12;

interface MatchScore {
  fileScore: number;
  timeScore: number;
  codeScore: number;
  titleScore: number;
  total: number;
}

function calculateTimeScore(hoursBefore: number): number {
  if (hoursBefore < MIN_HOURS_BEFORE_CONVERSATION || hoursBefore > MAX_HOURS_AFTER_CONVERSATION) {
    return 0;
  }
  if (hoursBefore <= 24) return 1.0;
  if (hoursBefore <= 48) return 0.9;
  if (hoursBefore <= 72) return 0.7;
  if (hoursBefore <= 120) return 0.5;
  return 0.3;
}

function scoreToConfidence(score: MatchScore): 'high' | 'medium' | 'low' {
  if (score.total >= 2.5) return 'high';
  if (score.total >= 1.5) return 'medium';
  return 'low';
}

async function findConversationsForBranch(
  repoPath: string,
  commits: CommitInfo[],
  allConversations: Conversation[],
  branchDiff: BranchDiff | null
): Promise<ReviewResult> {
  const commitsByFile = new Map<string, CommitInfo[]>();
  for (const commit of commits) {
    for (const file of commit.filesChanged) {
      const normalized = normalizeFilePath(file);
      const list = commitsByFile.get(normalized) || [];
      list.push(commit);
      commitsByFile.set(normalized, list);
    }
  }

  const commitDiffs = new Map<string, string[]>();
  const allCommitMessages = commits.map((c) => c.message).join(' ');

  for (const commit of commits) {
    const diff = await getCommitDiff(repoPath, commit.hash);
    if (diff) {
      commitDiffs.set(commit.hash, extractAddedLines(diff.rawDiff));
    }
  }

  const matches: ConversationMatch[] = [];
  const matchedCommitHashes = new Set<string>();

  for (const conv of allConversations) {
    const convTime = conv.updatedAt ? new Date(conv.updatedAt).getTime() : 0;
    if (!convTime) continue;

    const fileEdits = await fileEditsRepo.findByConversation(conv.id);
    if (fileEdits.length === 0) continue;

    const messages = await messageRepo.findByConversation(conv.id);
    const allCodeLines = new Set<string>();
    
    for (const edit of fileEdits) {
      if (edit.newContent && edit.newContent.length > 5) {
        for (const line of edit.newContent.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length > 5) allCodeLines.add(trimmed);
        }
      }
    }
    
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.content) {
        for (const line of extractCodeBlockLines(msg.content)) {
          allCodeLines.add(line);
        }
      }
    }

    const matchedCommits: CommitInfo[] = [];
    const matchReasons: string[] = [];
    const matchedSpecificFiles: string[] = [];
    const matchedGenericFiles: string[] = [];
    let hasCodeMatch = false;
    let bestTimeScore = 0;
    let matchedLineCount = 0;

    for (const edit of fileEdits) {
      const editNormalized = normalizeFilePath(edit.filePath);
      const relatedCommits = commitsByFile.get(editNormalized);

      if (!relatedCommits) continue;

      for (const commit of relatedCommits) {
        const commitTime = commit.date.getTime();
        const hoursBefore = (commitTime - convTime) / (1000 * 60 * 60);
        const timeScore = calculateTimeScore(hoursBefore);

        if (timeScore === 0) continue;

        bestTimeScore = Math.max(bestTimeScore, timeScore);

        if (!matchedCommits.find((c) => c.hash === commit.hash)) {
          matchedCommits.push(commit);
          matchedCommitHashes.add(commit.hash);
        }

        const fileName = edit.filePath.split('/').pop() || '';
        const fileIsGeneric = isGenericFile(edit.filePath);

        if (fileIsGeneric) {
          if (!matchedGenericFiles.includes(fileName)) {
            matchedGenericFiles.push(fileName);
          }
        } else {
          if (!matchedSpecificFiles.includes(fileName)) {
            matchedSpecificFiles.push(fileName);
          }
        }

        const diffLines = commitDiffs.get(commit.hash) || [];
        for (const diffLine of diffLines) {
          for (const codeLine of allCodeLines) {
            if (diffLine.includes(codeLine) || codeLine.includes(diffLine)) {
              hasCodeMatch = true;
              matchedLineCount++;
              break;
            }
          }
        }
      }
    }

    if (matchedCommits.length === 0) continue;

    const titleSimilarity = textSimilarity(conv.title, allCommitMessages);

    const specificFileScore = Math.min(matchedSpecificFiles.length * 0.5, 1.5);
    const genericFileScore = Math.min(matchedGenericFiles.length * 0.1, 0.3);

    const score: MatchScore = {
      fileScore: specificFileScore + genericFileScore,
      timeScore: bestTimeScore,
      codeScore: hasCodeMatch ? 1.0 : 0,
      titleScore: titleSimilarity > 0.2 ? titleSimilarity * 2 : 0,
      total: 0,
    };
    score.total = score.fileScore + score.timeScore + score.codeScore + score.titleScore;

    const totalFiles = matchedSpecificFiles.length + matchedGenericFiles.length;
    if (totalFiles > 0) {
      if (matchedSpecificFiles.length > 0) {
        matchReasons.push(`${matchedSpecificFiles.length} files`);
      } else {
        matchReasons.push(`${matchedGenericFiles.length} shared files`);
      }
    }
    if (hasCodeMatch) {
      matchReasons.unshift('code match');
    }
    if (titleSimilarity > 0.2) {
      matchReasons.push('title match');
    }

    const hasEditContent = fileEdits.some((e) => e.newContent && e.newContent.length > 0);
    const hasOnlyGenericFiles = matchedSpecificFiles.length === 0 && matchedGenericFiles.length > 0;

    if (hasEditContent && !hasCodeMatch) {
      continue;
    }

    if (!hasEditContent && hasOnlyGenericFiles) {
      continue;
    }

    if (!hasEditContent && matchedSpecificFiles.length < 2) {
      continue;
    }

    const confidence = scoreToConfidence(score);

    matches.push({
      conversation: conv,
      commits: matchedCommits,
      fileEdits,
      allCodeLines,
      confidence,
      matchReasons,
      matchedLineCount,
    });
  }

  matches.sort((a, b) => {
    const confOrder = { high: 0, medium: 1, low: 2 };
    if (confOrder[a.confidence] !== confOrder[b.confidence]) {
      return confOrder[a.confidence] - confOrder[b.confidence];
    }
    return b.commits.length - a.commits.length;
  });

  const unmatchedCommits = commits.filter((c) => !matchedCommitHashes.has(c.hash));

  const commitCoverage: CommitCoverage[] = commits.map((commit) => {
    const diffLines = commitDiffs.get(commit.hash) || [];
    const totalLines = diffLines.length;

    let matchedLines = 0;
    const matchedConvIds: string[] = [];
    const lineAttributions: LineAttribution[] = [];
    const attributedLineContents = new Set<string>();

    for (const match of matches) {
      if (!match.commits.find((c) => c.hash === commit.hash)) continue;

      for (let i = 0; i < diffLines.length; i++) {
        const diffLine = diffLines[i];
        if (!diffLine) continue;
        if (attributedLineContents.has(diffLine)) continue;

        let matched = false;
        for (const codeLine of match.allCodeLines) {
          if (diffLine.includes(codeLine) || codeLine.includes(diffLine)) {
            matched = true;
            break;
          }
        }

        if (matched) {
          matchedLines++;
          attributedLineContents.add(diffLine);
          if (!matchedConvIds.includes(match.conversation.id)) {
            matchedConvIds.push(match.conversation.id);
          }
          lineAttributions.push({
            lineNumber: i,
            lineContent: diffLine,
            conversationId: match.conversation.id,
            conversationTitle: match.conversation.title,
            fileEditPath: '',
          });
        }
      }
    }

    return {
      commit,
      totalLines,
      matchedLines: Math.min(matchedLines, totalLines),
      coveragePercent: totalLines > 0 ? Math.round((Math.min(matchedLines, totalLines) / totalLines) * 100) : 0,
      matchedConversations: matchedConvIds,
      lineAttributions,
    };
  });

  // Calculate branch-level coverage using the net branch diff (what shows in a PR)
  // This is more accurate than summing commit diffs because it excludes merged PRs
  let branchCoverage: BranchCoverage;
  
  if (branchDiff) {
    const branchDiffLines = extractAddedLines(branchDiff.rawDiff);
    const branchTotalLines = branchDiffLines.length;
    let branchMatchedLines = 0;
    const branchMatchedConvIds: string[] = [];
    const branchLineAttributions: LineAttribution[] = [];
    const branchAttributedLineContents = new Set<string>();

    for (const match of matches) {
      for (let i = 0; i < branchDiffLines.length; i++) {
        const diffLine = branchDiffLines[i];
        if (!diffLine) continue;
        if (branchAttributedLineContents.has(diffLine)) continue;

        let matched = false;
        for (const codeLine of match.allCodeLines) {
          if (diffLine.includes(codeLine) || codeLine.includes(diffLine)) {
            matched = true;
            break;
          }
        }

        if (matched) {
          branchMatchedLines++;
          branchAttributedLineContents.add(diffLine);
          if (!branchMatchedConvIds.includes(match.conversation.id)) {
            branchMatchedConvIds.push(match.conversation.id);
          }
          branchLineAttributions.push({
            lineNumber: i,
            lineContent: diffLine,
            conversationId: match.conversation.id,
            conversationTitle: match.conversation.title,
            fileEditPath: '',
          });
        }
      }
    }

    branchCoverage = {
      totalLines: branchTotalLines,
      matchedLines: Math.min(branchMatchedLines, branchTotalLines),
      coveragePercent: branchTotalLines > 0 
        ? Math.round((Math.min(branchMatchedLines, branchTotalLines) / branchTotalLines) * 100) 
        : 0,
      matchedConversations: branchMatchedConvIds,
      lineAttributions: branchLineAttributions,
    };
  } else {
    // Fallback to commit-sum approach if branch diff unavailable
    const totalLines = commitCoverage.reduce((sum, c) => sum + c.totalLines, 0);
    const matchedLines = commitCoverage.reduce((sum, c) => sum + c.matchedLines, 0);
    branchCoverage = {
      totalLines,
      matchedLines,
      coveragePercent: totalLines > 0 ? Math.round((matchedLines / totalLines) * 100) : 0,
      matchedConversations: [...new Set(commitCoverage.flatMap(c => c.matchedConversations))],
      lineAttributions: commitCoverage.flatMap(c => c.lineAttributions),
    };
  }

  return {
    branch: '',
    baseBranch: '',
    repoPath,
    totalCommits: commits.length,
    conversations: matches,
    unmatchedCommits,
    commitCoverage,
    branchCoverage,
  };
}

function printPlainOutput(result: ReviewResult): void {
  console.log(`\n📂 Branch: ${result.branch}`);
  console.log(`   Base: ${result.baseBranch}`);
  console.log(`   ${result.totalCommits} commits\n`);
  console.log('─'.repeat(60));

  if (result.conversations.length > 0) {
    console.log(`\nConversations that produced this work:\n`);

    for (const match of result.conversations) {
      const conv = match.conversation;
      const sourceInfo = getSourceInfo(conv.source);
      const confidenceIcon = match.confidence === 'high' ? '🟢' : match.confidence === 'medium' ? '🟡' : '⚪';

      console.log(`${confidenceIcon} "${truncate(conv.title, 50)}" (${sourceInfo.name})`);
      console.log(`   ${formatDate(conv.updatedAt)} · ${conv.messageCount} messages · ${match.fileEdits.length} file edits`);

      if (match.commits.length > 0) {
        const commitStrs = match.commits.slice(0, 3).map((c) => c.shortHash);
        const moreCount = match.commits.length - 3;
        console.log(`   Commits: ${commitStrs.join(', ')}${moreCount > 0 ? ` +${moreCount} more` : ''}`);
      }

      console.log(`   ${match.matchReasons.join(' · ')}`);
      console.log(`   ID: ${conv.id}`);
      console.log('');
    }
  } else {
    console.log('\nNo matching conversations found.\n');
  }

  const { branchCoverage } = result;
  if (branchCoverage.totalLines > 0) {
    console.log('─'.repeat(60));
    console.log(`\nBranch diff coverage (PR diff):\n`);
    const bar = '█'.repeat(Math.floor(branchCoverage.coveragePercent / 10)) + 
                '░'.repeat(10 - Math.floor(branchCoverage.coveragePercent / 10));
    console.log(`   ${bar} ${branchCoverage.coveragePercent}% (${branchCoverage.matchedLines}/${branchCoverage.totalLines} lines)`);
    console.log(`\n   ${branchCoverage.coveragePercent}% of PR diff attributable to AI conversations`);
  }

  const coveredCommits = result.commitCoverage.filter((c) => c.coveragePercent > 0);
  if (coveredCommits.length > 0) {
    console.log('─'.repeat(60));
    console.log(`\nPer-commit coverage:\n`);
    for (const cov of coveredCommits.slice(0, 10)) {
      const bar = '█'.repeat(Math.floor(cov.coveragePercent / 10)) + '░'.repeat(10 - Math.floor(cov.coveragePercent / 10));
      console.log(`   ${cov.commit.shortHash} ${bar} ${cov.coveragePercent}% (${cov.matchedLines}/${cov.totalLines} lines)`);
      console.log(`            ${truncate(cov.commit.message, 50)}`);
    }
    if (coveredCommits.length > 10) {
      console.log(`   ... and ${coveredCommits.length - 10} more commits with coverage`);
    }
  }

  if (result.unmatchedCommits.length > 0) {
    console.log('─'.repeat(60));
    console.log(`\nCommits without matching conversations (${result.unmatchedCommits.length}):\n`);
    for (const commit of result.unmatchedCommits.slice(0, 5)) {
      console.log(`   ${commit.shortHash} - ${truncate(commit.message, 45)} (${commit.author})`);
    }
    if (result.unmatchedCommits.length > 5) {
      console.log(`   ... and ${result.unmatchedCommits.length - 5} more`);
    }
  }

  console.log('');
}

function printJsonOutput(result: ReviewResult): void {
  const output = {
    branch: result.branch,
    baseBranch: result.baseBranch,
    repoPath: result.repoPath,
    totalCommits: result.totalCommits,
    conversations: result.conversations.map((match) => ({
      id: match.conversation.id,
      title: match.conversation.title,
      source: match.conversation.source,
      date: match.conversation.updatedAt,
      messageCount: match.conversation.messageCount,
      fileEditCount: match.fileEdits.length,
      confidence: match.confidence,
      matchReasons: match.matchReasons,
      commits: match.commits.map((c) => ({
        hash: c.hash,
        shortHash: c.shortHash,
        message: c.message,
      })),
      filesEdited: [...new Set(match.fileEdits.map((e) => e.filePath))],
    })),
    unmatchedCommits: result.unmatchedCommits.map((c) => ({
      hash: c.hash,
      shortHash: c.shortHash,
      message: c.message,
      author: c.author,
      date: c.date.toISOString(),
    })),
    commitCoverage: result.commitCoverage.map((c) => ({
      hash: c.commit.hash,
      shortHash: c.commit.shortHash,
      message: c.commit.message,
      totalLines: c.totalLines,
      matchedLines: c.matchedLines,
      coveragePercent: c.coveragePercent,
      matchedConversations: c.matchedConversations,
    })),
    branchCoverage: {
      totalLines: result.branchCoverage.totalLines,
      matchedLines: result.branchCoverage.matchedLines,
      coveragePercent: result.branchCoverage.coveragePercent,
      matchedConversations: result.branchCoverage.matchedConversations,
    },
    summary: {
      matchedConversations: result.conversations.length,
      matchedCommits: result.totalCommits - result.unmatchedCommits.length,
      unmatchedCommits: result.unmatchedCommits.length,
      totalLines: result.branchCoverage.totalLines,
      matchedLines: result.branchCoverage.matchedLines,
      overallCoveragePercent: result.branchCoverage.coveragePercent,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

export async function reviewCommand(branch: string | undefined, options: ReviewOptions): Promise<void> {
  const repoPath = options.repo || process.cwd();
  const baseBranch = options.base || 'main';
  const limit = parseInt(options.limit || '100', 10);

  const gitRoot = await findRepoRoot(repoPath);
  if (!gitRoot) {
    console.error(`Error: ${repoPath} is not inside a git repository`);
    process.exit(1);
  }

  let targetBranch = branch || (await getCurrentBranch(gitRoot));
  if (!targetBranch) {
    console.error('Error: Could not determine current branch');
    process.exit(1);
  }

  let targetExists = await branchExists(gitRoot, targetBranch);
  if (!targetExists && !targetBranch.startsWith('origin/')) {
    const remoteBranch = `origin/${targetBranch}`;
    if (await branchExists(gitRoot, remoteBranch)) {
      targetBranch = remoteBranch;
      targetExists = true;
    }
  }
  if (!targetExists) {
    console.error(`Error: Branch '${targetBranch}' does not exist`);
    process.exit(1);
  }

  if (!options.json) {
    console.log(`Analyzing branch: ${targetBranch}`);
  }

  const commits = await getCommitsOnBranch(gitRoot, targetBranch, baseBranch, limit);

  if (commits.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ branch: targetBranch, baseBranch, conversations: [], message: 'No commits found' }));
    } else {
      console.log(`No commits found on ${targetBranch} relative to ${baseBranch}`);
    }
    return;
  }

  if (!options.json) {
    console.log(`Found ${commits.length} commits, finding related conversations...`);
  }

  await connect();

  const branchConversations = await conversationRepo.findByGitBranch(targetBranch);

  const repoName = getRepoName(gitRoot);
  const { conversations: repoNameConversations } = await conversationRepo.list({
    limit: 10000,
    project: repoName,
  });

  const allConversations = [...branchConversations];
  for (const conv of repoNameConversations) {
    if (!allConversations.find((c) => c.id === conv.id)) {
      allConversations.push(conv);
    }
  }

  const branchDiff = await getBranchDiff(gitRoot, targetBranch, baseBranch);
  const result = await findConversationsForBranch(gitRoot, commits, allConversations, branchDiff);
  result.branch = targetBranch;
  result.baseBranch = baseBranch;

  if (options.export) {
    const { exportReviewData, writeMarkdownExport } = await import('./review-export.js');
    const exportData = await exportReviewData(
      gitRoot,
      targetBranch,
      baseBranch,
      commits,
      result.conversations,
      result.commitCoverage,
      branchDiff
    );
    writeMarkdownExport(exportData, options.export);
  } else if (options.json) {
    printJsonOutput(result);
  } else {
    printPlainOutput(result);
  }
}
