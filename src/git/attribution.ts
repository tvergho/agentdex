import type { CommitInfo, CommitDiff } from './index.js';
import { getCommitDiff, getCommitInfo, findRepoRoot } from './index.js';
import type { Message, Conversation } from '../schema/index.js';

export interface AttributedCommit {
  commit: CommitInfo;
  diff: CommitDiff | null;
  matchedMessages: MessageMatch[];
  confidence: 'high' | 'medium' | 'low';
  matchType: 'exact' | 'content' | 'time';
}

export interface MessageMatch {
  message: Message;
  conversation: Conversation;
  matchReason: string;
}

export interface AttributionResult {
  repoPath: string;
  branch: string;
  commits: AttributedCommit[];
  unattributedCommits: CommitInfo[];
  conversationsAnalyzed: number;
}

interface MessageWithConversation {
  message: Message;
  conversation: Conversation;
}

export async function attributeCommits(
  repoPath: string,
  commits: CommitInfo[],
  conversations: Conversation[],
  messages: Message[]
): Promise<AttributionResult> {
  const messagesByConversation = new Map<string, MessageWithConversation[]>();
  for (const msg of messages) {
    const conv = conversations.find((c) => c.id === msg.conversationId);
    if (!conv) continue;

    const list = messagesByConversation.get(msg.conversationId) || [];
    list.push({ message: msg, conversation: conv });
    messagesByConversation.set(msg.conversationId, list);
  }

  const result: AttributionResult = {
    repoPath,
    branch: '',
    commits: [],
    unattributedCommits: [],
    conversationsAnalyzed: conversations.length,
  };

  for (const commit of commits) {
    const diff = await getCommitDiff(repoPath, commit.hash);
    const attributed = await matchCommitToMessages(
      commit,
      diff,
      conversations,
      messages,
      messagesByConversation
    );

    if (attributed) {
      result.commits.push(attributed);
    } else {
      result.unattributedCommits.push(commit);
    }
  }

  return result;
}

async function matchCommitToMessages(
  commit: CommitInfo,
  diff: CommitDiff | null,
  conversations: Conversation[],
  messages: Message[],
  messagesByConversation: Map<string, MessageWithConversation[]>
): Promise<AttributedCommit | null> {
  const matches: MessageMatch[] = [];
  let confidence: AttributedCommit['confidence'] = 'low';
  let matchType: AttributedCommit['matchType'] = 'time';

  const exactHashMatches = findExactHashMatches(commit, conversations, messages);
  if (exactHashMatches.length > 0) {
    matches.push(...exactHashMatches);
    confidence = 'high';
    matchType = 'exact';
  }

  if (matches.length === 0 && diff) {
    const contentMatches = findContentMatches(commit, diff, messages, conversations);
    if (contentMatches.length > 0) {
      matches.push(...contentMatches);
      confidence = contentMatches.length >= 2 ? 'medium' : 'low';
      matchType = 'content';
    }
  }

  if (matches.length === 0) {
    const timeMatches = findTimeMatches(commit, conversations, messages);
    if (timeMatches.length > 0) {
      matches.push(...timeMatches);
      confidence = 'low';
      matchType = 'time';
    }
  }

  if (matches.length === 0) {
    return null;
  }

  return {
    commit,
    diff,
    matchedMessages: matches,
    confidence,
    matchType,
  };
}

function findExactHashMatches(
  commit: CommitInfo,
  conversations: Conversation[],
  messages: Message[]
): MessageMatch[] {
  const matches: MessageMatch[] = [];

  for (const conv of conversations) {
    if (conv.gitCommitHash === commit.hash) {
      const convMessages = messages.filter((m) => m.conversationId === conv.id);
      if (convMessages.length > 0) {
        matches.push({
          message: convMessages[0]!,
          conversation: conv,
          matchReason: `Conversation started at commit ${commit.shortHash}`,
        });
      }
    }
  }

  for (const msg of messages) {
    if (msg.gitSnapshot === commit.hash) {
      const conv = conversations.find((c) => c.id === msg.conversationId);
      if (conv) {
        matches.push({
          message: msg,
          conversation: conv,
          matchReason: `Message snapshot matches commit ${commit.shortHash}`,
        });
      }
    }
  }

  return matches;
}

function findContentMatches(
  commit: CommitInfo,
  diff: CommitDiff,
  messages: Message[],
  conversations: Conversation[]
): MessageMatch[] {
  const changedFiles = new Set(diff.files.map((f) => f.path));
  const fileNames = new Set(
    diff.files.map((f) => f.path.split('/').pop() || '').filter((n) => n.length > 0)
  );

  interface ScoredMatch {
    message: Message;
    conversation: Conversation;
    score: number;
    reasons: string[];
  }

  const scoredMatches: ScoredMatch[] = [];
  const seenConversations = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    let matchScore = 0;
    const matchReasons: string[] = [];
    const matchedFiles = new Set<string>();

    for (const filePath of changedFiles) {
      if (msg.content.includes(filePath)) {
        matchScore += 3;
        const fileName = filePath.split('/').pop() || '';
        matchedFiles.add(fileName);
      }
    }

    for (const fileName of fileNames) {
      if (!matchedFiles.has(fileName) && msg.content.includes(fileName)) {
        matchScore += 1;
        matchedFiles.add(fileName);
      }
    }

    if (matchedFiles.size > 0) {
      matchReasons.push(`References ${Array.from(matchedFiles).slice(0, 3).join(', ')}`);
    }

    const diffLines = diff.rawDiff.split('\n');
    for (const line of diffLines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const addedCode = line.slice(1).trim();
        if (addedCode.length > 30 && msg.content.includes(addedCode)) {
          matchScore += 5;
          matchReasons.push('Contains added code');
          break;
        }
      }
    }

    if (matchScore >= 3) {
      const conv = conversations.find((c) => c.id === msg.conversationId);
      if (conv) {
        scoredMatches.push({
          message: msg,
          conversation: conv,
          score: matchScore,
          reasons: matchReasons,
        });
      }
    }
  }

  scoredMatches.sort((a, b) => b.score - a.score);

  const matches: MessageMatch[] = [];
  for (const match of scoredMatches) {
    if (seenConversations.has(match.conversation.id)) continue;
    seenConversations.add(match.conversation.id);

    matches.push({
      message: match.message,
      conversation: match.conversation,
      matchReason: match.reasons.join(', '),
    });

    if (matches.length >= 3) break;
  }

  return matches;
}

function findTimeMatches(
  commit: CommitInfo,
  conversations: Conversation[],
  messages: Message[]
): MessageMatch[] {
  const matches: MessageMatch[] = [];
  const commitTime = commit.date.getTime();
  const windowMs = 30 * 60 * 1000;

  for (const conv of conversations) {
    if (!conv.updatedAt) continue;

    const convTime = new Date(conv.updatedAt).getTime();
    const timeDiff = Math.abs(commitTime - convTime);

    if (timeDiff <= windowMs) {
      const convMessages = messages
        .filter((m) => m.conversationId === conv.id && m.role === 'assistant')
        .sort((a, b) => {
          if (!a.timestamp || !b.timestamp) return 0;
          return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        });

      if (convMessages.length > 0) {
        const minutesDiff = Math.round(timeDiff / 60000);
        matches.push({
          message: convMessages[0]!,
          conversation: conv,
          matchReason: `Conversation active ${minutesDiff} min ${commitTime > convTime ? 'after' : 'before'} commit`,
        });
      }
    }
  }

  return matches;
}

export async function resolveWorkspaceRepo(workspacePath: string): Promise<string | null> {
  return findRepoRoot(workspacePath);
}
