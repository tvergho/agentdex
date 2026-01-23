import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Conversation, Message } from '../../schema/index.js';
import { getSourceInfo } from '../../schema/index.js';
import { messageRepo } from '../../db/repository.js';
import { getCommitDiff, type CommitInfo, type BranchDiff } from '../../git/index.js';
import { generateReviewHtml } from './review-web/template.js';

interface ExportConversation {
  id: string;
  title: string;
  source: string;
  date: string;
  messageCount: number;
  messages: Message[];
  confidence: 'high' | 'medium' | 'low';
  matchReasons: string[];
}

interface LineAttribution {
  lineNumber: number;
  lineContent: string;
  conversationId: string;
  conversationTitle: string;
  fileEditPath: string;
}

interface ExportCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  filesChanged: string[];
  diff: string;
  coveragePercent: number;
  attributedConversations: string[];
  lineAttributions: LineAttribution[];
}

interface BranchDiffExport {
  rawDiff: string;
  filesChanged: string[];
  additions: number;
  deletions: number;
  lineAttributions: LineAttribution[];
}

export interface ExportData {
  branch: string;
  baseBranch: string;
  exportedAt: string;
  summary: {
    totalCommits: number;
    matchedCommits: number;
    unmatchedCommits: number;
    totalLines: number;
    matchedLines: number;
    overallCoveragePercent: number;
  };
  branchDiff: BranchDiffExport | null;
  commits: ExportCommit[];
  conversations: ExportConversation[];
}

export async function exportReviewData(
  repoPath: string,
  branch: string,
  baseBranch: string,
  commits: CommitInfo[],
  conversations: Array<{
    conversation: Conversation;
    commits: CommitInfo[];
    allCodeLines: Set<string>;
    confidence: 'high' | 'medium' | 'low';
    matchReasons: string[];
  }>,
  commitCoverage: Array<{
    commit: CommitInfo;
    totalLines: number;
    matchedLines: number;
    coveragePercent: number;
    matchedConversations: string[];
    lineAttributions: LineAttribution[];
  }>,
  branchDiff: BranchDiff | null
): Promise<ExportData> {
  const exportCommits: ExportCommit[] = [];

  for (const cov of commitCoverage) {
    const diff = await getCommitDiff(repoPath, cov.commit.hash);
    exportCommits.push({
      hash: cov.commit.hash,
      shortHash: cov.commit.shortHash,
      message: cov.commit.message,
      author: cov.commit.author,
      date: cov.commit.date.toISOString(),
      filesChanged: cov.commit.filesChanged,
      diff: diff?.rawDiff || '',
      coveragePercent: cov.coveragePercent,
      attributedConversations: cov.matchedConversations,
      lineAttributions: cov.lineAttributions,
    });
  }

  const exportConversations: ExportConversation[] = [];
  const seenConvIds = new Set<string>();

  for (const match of conversations) {
    if (seenConvIds.has(match.conversation.id)) continue;
    seenConvIds.add(match.conversation.id);

    const messages = await messageRepo.findByConversation(match.conversation.id);
    const sourceInfo = getSourceInfo(match.conversation.source);

    exportConversations.push({
      id: match.conversation.id,
      title: match.conversation.title,
      source: sourceInfo.name,
      date: match.conversation.updatedAt || match.conversation.createdAt || '',
      messageCount: match.conversation.messageCount,
      messages,
      confidence: match.confidence,
      matchReasons: match.matchReasons,
    });
  }

  let branchDiffExport: BranchDiffExport | null = null;
  
  if (branchDiff) {
    const branchDiffLines = extractAddedLinesWithPaths(branchDiff.rawDiff);
    const branchLineAttributions: LineAttribution[] = [];
    const attributedLineKeys = new Set<string>();

    for (const match of conversations) {
      for (const diffLine of branchDiffLines) {
        const lineKey = `${diffLine.filePath}:${diffLine.lineNumber}`;
        if (attributedLineKeys.has(lineKey)) continue;

        let matched = false;
        for (const codeLine of match.allCodeLines) {
          if (diffLine.content.includes(codeLine) || codeLine.includes(diffLine.content)) {
            matched = true;
            break;
          }
        }

        if (matched) {
          attributedLineKeys.add(lineKey);
          branchLineAttributions.push({
            lineNumber: diffLine.lineNumber,
            lineContent: diffLine.content,
            conversationId: match.conversation.id,
            conversationTitle: match.conversation.title,
            fileEditPath: diffLine.filePath,
          });
        }
      }
    }

    branchDiffExport = {
      rawDiff: branchDiff.rawDiff,
      filesChanged: branchDiff.filesChanged,
      additions: branchDiff.additions,
      deletions: branchDiff.deletions,
      lineAttributions: branchLineAttributions,
    };
  }

  const totalLines = branchDiffExport?.additions || commitCoverage.reduce((sum, c) => sum + c.totalLines, 0);
  const matchedLines = branchDiffExport?.lineAttributions.length || commitCoverage.reduce((sum, c) => sum + c.matchedLines, 0);

  return {
    branch,
    baseBranch,
    exportedAt: new Date().toISOString(),
    summary: {
      totalCommits: commits.length,
      matchedCommits: commitCoverage.filter((c) => c.coveragePercent > 0).length,
      unmatchedCommits: commitCoverage.filter((c) => c.coveragePercent === 0).length,
      totalLines,
      matchedLines,
      overallCoveragePercent: totalLines > 0 ? Math.round((matchedLines / totalLines) * 100) : 0,
    },
    branchDiff: branchDiffExport,
    commits: exportCommits,
    conversations: exportConversations,
  };
}

interface ExtractedLine {
  content: string;
  filePath: string;
  lineNumber: number;
}

function extractAddedLinesWithPaths(diff: string): ExtractedLine[] {
  const results: ExtractedLine[] = [];
  let currentFile = '';
  let lineNumber = 0;
  
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (match && match[1]) {
        lineNumber = parseInt(match[1], 10) - 1;
      }
      continue;
    }
    
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNumber++;
      const content = line.slice(1).trim();
      if (content.length > 0) {
        results.push({ content, filePath: currentFile, lineNumber });
      }
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      lineNumber++;
    }
  }
  
  return results;
}

function escapeMarkdown(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatMessage(msg: Message): string {
  const role = msg.role === 'user' ? '👤 User' : '🤖 Assistant';
  const lines = [`### ${role}\n`];

  if (msg.content) {
    lines.push(escapeMarkdown(msg.content));
  }

  return lines.join('\n');
}

export function writeMarkdownExport(data: ExportData, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });

  const indexLines: string[] = [
    `# Branch Review: ${data.branch}`,
    '',
    `**Base:** ${data.baseBranch}`,
    `**Exported:** ${new Date(data.exportedAt).toLocaleString()}`,
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Commits | ${data.summary.totalCommits} |`,
    `| Matched Commits | ${data.summary.matchedCommits} |`,
    `| Unmatched Commits | ${data.summary.unmatchedCommits} |`,
    `| Code Coverage | ${data.summary.overallCoveragePercent}% (${data.summary.matchedLines}/${data.summary.totalLines} lines) |`,
    '',
    '## Commits',
    '',
  ];

  for (const commit of data.commits) {
    const coverageBar = '█'.repeat(Math.floor(commit.coveragePercent / 10)) +
      '░'.repeat(10 - Math.floor(commit.coveragePercent / 10));

    indexLines.push(`### [\`${commit.shortHash}\`](commits/${commit.shortHash}.md) ${commit.message}`);
    indexLines.push('');
    indexLines.push(`- **Author:** ${commit.author}`);
    indexLines.push(`- **Date:** ${new Date(commit.date).toLocaleString()}`);
    indexLines.push(`- **Coverage:** ${coverageBar} ${commit.coveragePercent}%`);

    if (commit.attributedConversations.length > 0) {
      const convLinks = commit.attributedConversations.map((id) => {
        const conv = data.conversations.find((c) => c.id === id);
        const title = conv?.title || id.slice(0, 8);
        return `[${title.slice(0, 30)}](conversations/${id.slice(0, 12)}.md)`;
      });
      indexLines.push(`- **Conversations:** ${convLinks.join(', ')}`);
    }

    indexLines.push('');
  }

  indexLines.push('## Conversations');
  indexLines.push('');

  for (const conv of data.conversations) {
    indexLines.push(`- [${conv.title}](conversations/${conv.id.slice(0, 12)}.md) (${conv.source}, ${conv.messageCount} messages)`);
  }

  writeFileSync(join(outputDir, 'README.md'), indexLines.join('\n'));

  const commitsDir = join(outputDir, 'commits');
  mkdirSync(commitsDir, { recursive: true });

  for (const commit of data.commits) {
    const commitLines: string[] = [
      `# Commit: ${commit.shortHash}`,
      '',
      `**Message:** ${commit.message}`,
      `**Author:** ${commit.author}`,
      `**Date:** ${new Date(commit.date).toLocaleString()}`,
      `**Coverage:** ${commit.coveragePercent}%`,
      '',
    ];

    if (commit.attributedConversations.length > 0) {
      commitLines.push('## Attributed Conversations');
      commitLines.push('');
      for (const convId of commit.attributedConversations) {
        const conv = data.conversations.find((c) => c.id === convId);
        if (conv) {
          commitLines.push(`- [${conv.title}](../conversations/${conv.id.slice(0, 12)}.md)`);
        }
      }
      commitLines.push('');
    }

    commitLines.push('## Files Changed');
    commitLines.push('');
    for (const file of commit.filesChanged) {
      commitLines.push(`- \`${file}\``);
    }
    commitLines.push('');

    commitLines.push('## Diff');
    commitLines.push('');
    commitLines.push('```diff');
    commitLines.push(commit.diff);
    commitLines.push('```');

    writeFileSync(join(commitsDir, `${commit.shortHash}.md`), commitLines.join('\n'));
  }

  const convsDir = join(outputDir, 'conversations');
  mkdirSync(convsDir, { recursive: true });

  for (const conv of data.conversations) {
    const convLines: string[] = [
      `# ${conv.title}`,
      '',
      `**Source:** ${conv.source}`,
      `**Date:** ${new Date(conv.date).toLocaleString()}`,
      `**Messages:** ${conv.messageCount}`,
      '',
      '---',
      '',
    ];

    for (const msg of conv.messages) {
      convLines.push(formatMessage(msg));
      convLines.push('');
      convLines.push('---');
      convLines.push('');
    }

    writeFileSync(join(convsDir, `${conv.id.slice(0, 12)}.md`), convLines.join('\n'));
  }

  const jsonPath = join(outputDir, 'data.json');
  const jsonData = JSON.stringify(data, null, 2);
  writeFileSync(jsonPath, jsonData);

  const htmlPath = join(outputDir, 'index.html');
  const trimmedData = {
    ...data,
    conversations: data.conversations.map((conv) => ({
      ...conv,
      messages: conv.messages.slice(0, 20).map((msg) => ({
        ...msg,
        content: msg.content?.slice(0, 2000) || '',
      })),
    })),
    commits: data.commits.slice(0, 50).map((c) => ({ ...c, diff: '' })),
  };
  const htmlContent = generateReviewHtml(JSON.stringify(trimmedData));
  writeFileSync(htmlPath, htmlContent);

  console.log(`\n✓ Exported to ${outputDir}/`);
  console.log(`  - index.html (interactive web viewer)`);
  console.log(`  - README.md (overview)`);
  console.log(`  - commits/ (${data.commits.length} files)`);
  console.log(`  - conversations/ (${data.conversations.length} files)`);
  console.log(`  - data.json (structured data)`);
}
