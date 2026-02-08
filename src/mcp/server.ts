/**
 * MCP Server for dex - exposes conversation search and retrieval tools
 *
 * Tools (namespaced as dex_* by MCP clients):
 * - stats: Get overview statistics about indexed conversations
 * - list: Browse conversations by metadata filters
 * - search: Search conversations by content
 * - get: Retrieve conversation content in various formats
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connect } from '../db/index';
import {
  conversationRepo,
  messageRepo,
  filesRepo,
  search,
  searchByFilePath,
  getFileMatchesForConversations,
} from '../db/repository';
import {
  getSummaryStats,
  getStreakInfo,
  getOverviewStats,
  getStatsBySource,
  getProjectStats,
  getDailyActivity,
  createPeriodFilter,
} from '../db/analytics';
import type { Conversation, Message } from '../schema/index';
import { findRepoRoot, getRemoteUrl } from '../git/index';
import { parseGitHubRepo, fetchPRList, fetchPRDetail } from './pr-reviews';

// Strip tool outputs from message content
function stripToolOutputs(content: string): string {
  const toolBlockPattern = /\n---\n\*\*[^*]+\*\*[^\n]*\n(`{3,4})[\s\S]*?\1\n---\n?/g;
  return content.replace(toolBlockPattern, '\n').trim();
}

// Create outline format
function formatOutline(messages: Message[]): string {
  return messages.map((msg) => {
    const firstLine = msg.content.split('\n')[0]?.slice(0, 60) || '';
    const tokenCount = (msg.inputTokens || 0) + (msg.outputTokens || 0) +
      (msg.cacheCreationTokens || 0) + (msg.cacheReadTokens || 0);
    const tokenStr = tokenCount > 0 ? `${Math.round(tokenCount / 1000 * 10) / 10}K tokens` : 'tokens N/A';
    const roleLabel = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
    return `[${roleLabel}] ${firstLine}${firstLine.length >= 60 ? '...' : ''} (${tokenStr})`;
  }).join('\n');
}

export async function startMcpServer(): Promise<void> {
  // Connect to database
  await connect();

  const server = new McpServer({
    name: 'dex',
    version: '0.3.2',
  });

  // ============ stats ============
  server.tool(
    'stats',
    'Get overview statistics about indexed conversations. Returns total counts, date range, sources breakdown, top projects, and average tokens.',
    {
      period_days: z.number().optional().default(30).describe('Time period in days (default: 30)'),
    },
    async ({ period_days }) => {
      const periodFilter = createPeriodFilter(period_days);

      const [overview, sources, streak, projectStats, daily] = await Promise.all([
        getOverviewStats(periodFilter),
        getStatsBySource(periodFilter),
        getStreakInfo(),
        getProjectStats(periodFilter),
        getDailyActivity(periodFilter),
      ]);

      const dates = daily.map(d => d.date).sort();
      const earliest = dates[0] || '';
      const latest = dates[dates.length - 1] || '';

      const sourcesRecord: Record<string, number> = {};
      for (const s of sources) {
        sourcesRecord[s.source] = s.conversations;
      }

      const topProjects = projectStats.slice(0, 20).map(p => p.projectName);
      const avgTokens = overview.conversations > 0
        ? Math.round((overview.totalInputTokens + overview.totalOutputTokens) / overview.conversations)
        : 0;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total_conversations: overview.conversations,
            total_messages: overview.messages,
            date_range: { earliest, latest },
            sources: sourcesRecord,
            projects: topProjects,
            avg_tokens_per_conversation: avgTokens,
            period_days,
            totals: {
              input_tokens: overview.totalInputTokens,
              output_tokens: overview.totalOutputTokens,
              lines_added: overview.totalLinesAdded,
              lines_removed: overview.totalLinesRemoved,
            },
            streak: {
              current: streak.current,
              longest: streak.longest,
            },
          }, null, 2),
        }],
      };
    }
  );

  // ============ list ============
  server.tool(
    'list',
    'Browse conversations by metadata filters. Returns a paginated list of conversations with their metadata.',
    {
      project: z.string().optional().describe('Filter by project/workspace path (substring match)'),
      source: z.enum(['cursor', 'claude-code', 'codex', 'opencode']).optional().describe('Filter by source'),
      branch: z.string().optional().describe('Filter by git branch name (exact match)'),
      from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      to: z.string().optional().describe('End date (YYYY-MM-DD)'),
      limit: z.number().optional().default(20).describe('Maximum results (default: 20)'),
      offset: z.number().optional().default(0).describe('Skip first N results for pagination'),
    },
    async ({ project, source, branch, from, to, limit, offset }) => {
      const { conversations, total } = await conversationRepo.list({
        project,
        source,
        branch,
        fromDate: from,
        toDate: to,
        limit,
        offset,
      });

      const results = conversations.map((conv) => ({
        id: conv.id,
        title: conv.title,
        project: conv.workspacePath || conv.projectName || '',
        branch: conv.gitBranch || undefined,
        source: conv.source,
        date: conv.createdAt || conv.updatedAt || '',
        message_count: conv.messageCount,
        estimated_tokens:
          (conv.totalInputTokens || 0) +
          (conv.totalOutputTokens || 0) +
          (conv.totalCacheCreationTokens || 0) +
          (conv.totalCacheReadTokens || 0),
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ conversations: results, total }, null, 2),
        }],
      };
    }
  );

  // ============ search ============
  server.tool(
    'search',
    'Search conversations by content using full-text and semantic hybrid search. Returns matching conversations with snippets.',
    {
      query: z.string().describe('Search query (required for content search)'),
      file: z.string().optional().describe('Filter by file path involvement'),
      project: z.string().optional().describe('Filter by project/workspace path (substring match)'),
      branch: z.string().optional().describe('Filter by git branch name (exact match)'),
      source: z.enum(['cursor', 'claude-code', 'codex', 'opencode']).optional().describe('Filter by source'),
      from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      to: z.string().optional().describe('End date (YYYY-MM-DD)'),
      limit: z.number().optional().default(10).describe('Maximum results (default: 10)'),
      offset: z.number().optional().default(0).describe('Skip first N results for pagination'),
    },
    async ({ query, file, project, branch, source, from, to, limit, offset }) => {
      type SearchResult = {
        conversation: Conversation;
        totalMatches: number;
        snippet: string;
        messageIndex: number;
        adjacentContext?: { role: 'user' | 'assistant' | 'system'; snippet: string; messageIndex: number };
      };

      let allResults: SearchResult[] = [];
      let total = 0;

      const applyFilters = (items: SearchResult[]): SearchResult[] => {
        let filtered = items;
        if (source) {
          filtered = filtered.filter((r) => r.conversation.source === source);
        }
        if (branch) {
          filtered = filtered.filter((r) => r.conversation.gitBranch === branch);
        }
        if (project) {
          const projectLower = project.toLowerCase();
          filtered = filtered.filter((r) => {
            const workspacePath = (r.conversation.workspacePath || '').toLowerCase();
            const projectName = (r.conversation.projectName || '').toLowerCase();
            return workspacePath.includes(projectLower) || projectName.includes(projectLower);
          });
        }
        if (from) {
          const fromTime = new Date(from).getTime();
          filtered = filtered.filter((r) => {
            const created = r.conversation.createdAt;
            return created && new Date(created).getTime() >= fromTime;
          });
        }
        if (to) {
          const toTime = new Date(to).getTime() + 86400000;
          filtered = filtered.filter((r) => {
            const created = r.conversation.createdAt;
            return created && new Date(created).getTime() < toTime;
          });
        }
        return filtered;
      };

      if (file && !query) {
        const fileResults = await searchByFilePath(file, limit + offset + 100);
        const convIdToMatches = new Map<string, typeof fileResults>();
        for (const match of fileResults) {
          const existing = convIdToMatches.get(match.conversationId) ?? [];
          existing.push(match);
          convIdToMatches.set(match.conversationId, existing);
        }

        const conversations = await Promise.all(
          Array.from(convIdToMatches.keys()).map((id) => conversationRepo.findById(id))
        );

        allResults = applyFilters(conversations
          .filter((conv): conv is NonNullable<typeof conv> => conv !== null)
          .map((conv) => {
            const matches = convIdToMatches.get(conv.id) ?? [];
            return {
              conversation: conv,
              totalMatches: matches.length,
              snippet: matches.slice(0, 3).map((m) => m.filePath.split('/').pop()).join(', '),
              messageIndex: 0,
            };
          }));
      } else if (file && query) {
        const result = await search(query, limit + offset + 100);
        const convIds = new Set(result.results.map((r) => r.conversation.id));
        const fileMatchMap = await getFileMatchesForConversations(convIds, file);

        allResults = applyFilters(result.results
          .filter((r) => (fileMatchMap.get(r.conversation.id) ?? []).length > 0)
          .map((r) => ({
            conversation: r.conversation,
            totalMatches: r.totalMatches,
            snippet: r.bestMatch.snippet,
            messageIndex: r.bestMatch.messageIndex,
            adjacentContext: r.bestMatch.adjacentContext,
          })));
      } else {
        const result = await search(query, limit + offset + 100);
        allResults = applyFilters(result.results.map((r) => ({
          conversation: r.conversation,
          totalMatches: r.totalMatches,
          snippet: r.bestMatch.snippet,
          messageIndex: r.bestMatch.messageIndex,
          adjacentContext: r.bestMatch.adjacentContext,
        })));
      }

      total = allResults.length;
      const paginatedResults = allResults.slice(offset, offset + limit);

      const output = {
        results: paginatedResults.map((r) => ({
          id: r.conversation.id,
          title: r.conversation.title,
          project: r.conversation.workspacePath || r.conversation.projectName || '',
          branch: r.conversation.gitBranch || undefined,
          source: r.conversation.source,
          date: r.conversation.createdAt || r.conversation.updatedAt || '',
          snippet: r.snippet.slice(0, 300),
          message_index: r.messageIndex,
          // Adjacent context shows the other side of the conversation (e.g., assistant response after user query)
          adjacent_context: r.adjacentContext ? {
            role: r.adjacentContext.role,
            snippet: r.adjacentContext.snippet.slice(0, 300),
            message_index: r.adjacentContext.messageIndex,
          } : undefined,
          estimated_tokens:
            (r.conversation.totalInputTokens || 0) +
            (r.conversation.totalOutputTokens || 0) +
            (r.conversation.totalCacheCreationTokens || 0) +
            (r.conversation.totalCacheReadTokens || 0),
        })),
        total,
      };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(output, null, 2),
        }],
      };
    }
  );

  // ============ get ============
  server.tool(
    'get',
    'Retrieve conversation content in various formats. Supports expanding around specific messages and token limits.',
    {
      ids: z.array(z.string()).describe('Conversation IDs to retrieve (batch support)'),
      format: z.enum(['full', 'stripped', 'user_only', 'outline']).optional().default('stripped')
        .describe('Content format: stripped (no tool outputs, default), full (everything), user_only (user messages), outline (summary)'),
      expand: z.object({
        message_index: z.number().describe('Center on this message index'),
        before: z.number().optional().default(2).describe('Messages before (default: 2)'),
        after: z.number().optional().default(2).describe('Messages after (default: 2)'),
      }).optional().describe('Expand around specific message instead of full conversation'),
      max_tokens: z.number().optional().describe('Token budget — truncates to fit. Use with tail=true to read the END of long conversations'),
      tail: z.boolean().optional().default(false).describe('When true with max_tokens, takes messages from the END instead of beginning. Useful for reading conclusions/fixes in long conversations.'),
    },
    async ({ ids, format, expand, max_tokens, tail }) => {
      // Hard cap on total response size to prevent blowing the caller's context window.
      // ~80K tokens ≈ 320K chars. If exceeded, remaining IDs are listed but not fetched.
      const TOTAL_CHAR_BUDGET = 320_000;
      let totalCharsUsed = 0;
      const skippedIds: string[] = [];

      const conversations: Array<{
        id: string;
        title: string;
        project: string;
        branch?: string;
        source: string;
        messages: Array<{ index: number; role: string; content: string; tokens?: number }>;
        files?: string[];
        total_tokens: number;
        has_more_before?: boolean;
        has_more_after?: boolean;
      }> = [];

      for (const id of ids) {
        // Check if we've already used most of the budget
        if (totalCharsUsed > TOTAL_CHAR_BUDGET) {
          skippedIds.push(id);
          continue;
        }
        const conversation = await conversationRepo.findById(id);
        if (!conversation) continue;

        let messages = await messageRepo.findByConversation(id);
        const files = await filesRepo.findByConversation(id);

        let hasMoreBefore = false;
        let hasMoreAfter = false;

        if (expand) {
          const startIdx = Math.max(0, expand.message_index - (expand.before ?? 2));
          const endIdx = Math.min(messages.length, expand.message_index + (expand.after ?? 2) + 1);
          hasMoreBefore = startIdx > 0;
          hasMoreAfter = endIdx < messages.length;
          messages = messages.slice(startIdx, endIdx);
        }

        let formattedMessages: Array<{ index: number; role: string; content: string; tokens?: number }>;

        if (format === 'outline') {
          formattedMessages = [{
            index: 0,
            role: 'outline',
            content: formatOutline(messages),
          }];
        } else {
          formattedMessages = messages
            .filter((msg) => format !== 'user_only' || msg.role === 'user')
            .map((msg) => {
              let content = msg.content;
              if (format === 'stripped') {
                content = stripToolOutputs(content);
              }

              const tokens = (msg.inputTokens || 0) + (msg.outputTokens || 0) +
                (msg.cacheCreationTokens || 0) + (msg.cacheReadTokens || 0);

              return {
                index: msg.messageIndex,
                role: msg.role,
                content,
                tokens: tokens > 0 ? tokens : undefined,
              };
            });
        }

        const totalTokens = (conversation.totalInputTokens || 0) +
          (conversation.totalOutputTokens || 0) +
          (conversation.totalCacheCreationTokens || 0) +
          (conversation.totalCacheReadTokens || 0);

        if (max_tokens && format !== 'outline') {
          // Tail mode: iterate from the end to capture conclusions/fixes
          const source = tail ? [...formattedMessages].reverse() : formattedMessages;
          let runningTokens = 0;
          const truncatedMessages: typeof formattedMessages = [];

          for (const msg of source) {
            const msgTokens = msg.tokens || Math.ceil(msg.content.length / 4);
            if (runningTokens + msgTokens > max_tokens) {
              const remainingBudget = max_tokens - runningTokens;
              if (remainingBudget > 100) {
                const charBudget = remainingBudget * 4;
                truncatedMessages.push({
                  ...msg,
                  content: tail
                    ? '... (truncated)\n' + msg.content.slice(-charBudget)
                    : msg.content.slice(0, charBudget) + '\n... (truncated)',
                });
              }
              break;
            }
            runningTokens += msgTokens;
            truncatedMessages.push(msg);
          }

          // Restore chronological order for tail mode
          formattedMessages = tail ? truncatedMessages.reverse() : truncatedMessages;
          if (tail) hasMoreBefore = true;
        }

        const convEntry = {
          id: conversation.id,
          title: conversation.title,
          project: conversation.workspacePath || conversation.projectName || '',
          branch: conversation.gitBranch || undefined,
          source: conversation.source,
          messages: formattedMessages,
          files: files.length > 0 ? files.map((f) => f.filePath) : undefined,
          total_tokens: totalTokens,
          has_more_before: hasMoreBefore || undefined,
          has_more_after: hasMoreAfter || undefined,
        };

        // Estimate chars for this conversation entry
        const entryChars = formattedMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
        totalCharsUsed += entryChars;
        conversations.push(convEntry);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: Record<string, any> = { conversations };
      if (skippedIds.length > 0) {
        result.skipped_ids = skippedIds;
        result.skipped_message = `Response budget exceeded (~80K tokens). ${skippedIds.length} conversation(s) were not included. Fetch them in a separate call.`;
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // ============ pr_reviews ============
  server.tool(
    'pr_reviews',
    'Browse and read GitHub PR review comments. List mode (omit number/numbers): returns PR titles, review decisions, comment counts. Detail mode: pass a single number OR an array of numbers to fetch multiple PRs in one call.',
    {
      repo: z.string().optional().describe('owner/repo format. Auto-detected from git remote if omitted.'),
      number: z.number().optional().describe('Single PR number for detail view. Omit for list mode.'),
      numbers: z.array(z.number()).optional().describe('Multiple PR numbers to fetch in one batch call. More efficient than calling one at a time.'),
      state: z.enum(['open', 'closed', 'merged', 'all']).optional().default('merged').describe('PR state filter (default: merged)'),
      days: z.number().optional().default(90).describe('Lookback window in days (default: 90)'),
      limit: z.number().optional().default(30).describe('Maximum PRs to return (default: 30)'),
      offset: z.number().optional().default(0).describe('Skip first N results for pagination'),
      min_chars: z.number().optional().default(50).describe('Minimum comment/review body length to include (default: 50)'),
    },
    async ({ repo, number, numbers, state, days, limit, offset, min_chars }) => {
      // Resolve repo: use provided, or auto-detect from git remote
      let resolvedRepo = repo;
      if (!resolvedRepo) {
        const repoRoot = await findRepoRoot(process.cwd());
        if (repoRoot) {
          const remoteUrl = await getRemoteUrl(repoRoot);
          if (remoteUrl) {
            const parsed = parseGitHubRepo(remoteUrl);
            if (parsed) {
              resolvedRepo = `${parsed.owner}/${parsed.repo}`;
            }
          }
        }
      }

      if (!resolvedRepo) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'Could not determine GitHub repo. Provide repo parameter as owner/repo.' }),
          }],
        };
      }

      try {
        if (numbers !== undefined && numbers.length > 0) {
          // Batch detail mode — fetch multiple PRs in parallel
          const results = await Promise.all(
            numbers.map((n) => fetchPRDetail(resolvedRepo!, n, min_chars)
              .catch((err) => ({ pr: { number: n, title: '', body: '', author: '', url: '' }, reviews: [], comments: [], error: String(err) }))),
          );
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(results, null, 2),
            }],
          };
        } else if (number !== undefined) {
          // Single detail mode
          const result = await fetchPRDetail(resolvedRepo, number, min_chars);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            }],
          };
        } else {
          // List mode
          const result = await fetchPRList(resolvedRepo, days, limit, offset, state, min_chars);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            }],
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Failed to fetch PR data: ${message}` }),
          }],
        };
      }
    }
  );

  // Start the server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
