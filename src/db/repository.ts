import {
  getConversationsTable,
  getMessagesTable,
  getFreshMessagesTable,
  getToolCallsTable,
  getSyncStateTable,
  getFilesTable,
  getMessageFilesTable,
  getFileEditsTable,
  getBillingEventsTable,
  withConnectionRecovery,
  isTransientError,
  isFragmentNotFoundError,
  repairFtsIndex,
  stripToolOutputs,
} from './index';
import {
  Source,
  type Conversation,
  type Message,
  type ToolCall,
  type SyncState,
  type SourceRef,
  type MessageMatch,
  type ConversationResult,
  type SearchResponse,
  type ConversationFile,
  type MessageFile,
  type AdjacentContext,
  type BillingEvent,
  FileEdit,
} from '../schema/index';
import { EMBEDDING_DIMENSIONS, embedQuery } from '../embeddings/index';
import { rerankers } from '@lancedb/lancedb';

// Helper to safely parse JSON with fallback
function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  try {
    return JSON.parse(value as string) as T;
  } catch {
    return fallback;
  }
}

// Default SourceRef for missing/corrupt data
const defaultSourceRef: SourceRef = {
  source: Source.Cursor,
  originalId: '',
  dbPath: '',
};

// Helper to group array by key
function groupBy<T>(array: T[], keyFn: (item: T) => string): Record<string, T[]> {
  return array.reduce(
    (acc, item) => {
      const key = keyFn(item);
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key]!.push(item);
      return acc;
    },
    {} as Record<string, T[]>
  );
}

// ============ Row Mapping Helpers ============

function conversationToRow(conv: Conversation): Record<string, unknown> {
  return {
    id: conv.id,
    source: conv.source,
    title: conv.title,
    subtitle: conv.subtitle ?? '',
    workspace_path: conv.workspacePath ?? '',
    project_name: conv.projectName ?? '',
    model: conv.model ?? '',
    mode: conv.mode ?? '',
    created_at: conv.createdAt ?? '',
    updated_at: conv.updatedAt ?? '',
    message_count: conv.messageCount,
    source_ref_json: JSON.stringify(conv.sourceRef),
    total_input_tokens: conv.totalInputTokens ?? 0,
    total_output_tokens: conv.totalOutputTokens ?? 0,
    total_cache_creation_tokens: conv.totalCacheCreationTokens ?? 0,
    total_cache_read_tokens: conv.totalCacheReadTokens ?? 0,
    total_lines_added: conv.totalLinesAdded ?? 0,
    total_lines_removed: conv.totalLinesRemoved ?? 0,
    compact_count: conv.compactCount ?? 0,
    git_branch: conv.gitBranch ?? '',
    git_commit_hash: conv.gitCommitHash ?? '',
    git_repository_url: conv.gitRepositoryUrl ?? '',
  };
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    source: row.source as Conversation['source'],
    title: row.title as string,
    subtitle: (row.subtitle as string) || undefined,
    workspacePath: (row.workspace_path as string) || undefined,
    projectName: (row.project_name as string) || undefined,
    model: (row.model as string) || undefined,
    mode: (row.mode as string) || undefined,
    createdAt: (row.created_at as string) || undefined,
    updatedAt: (row.updated_at as string) || undefined,
    messageCount: (row.message_count as number) || 0,
    sourceRef: safeJsonParse<SourceRef>(row.source_ref_json, defaultSourceRef),
    totalInputTokens: (row.total_input_tokens as number) || undefined,
    totalOutputTokens: (row.total_output_tokens as number) || undefined,
    totalCacheCreationTokens: (row.total_cache_creation_tokens as number) || undefined,
    totalCacheReadTokens: (row.total_cache_read_tokens as number) || undefined,
    totalLinesAdded: (row.total_lines_added as number) || undefined,
    totalLinesRemoved: (row.total_lines_removed as number) || undefined,
    compactCount: (row.compact_count as number) || undefined,
    gitBranch: (row.git_branch as string) || undefined,
    gitCommitHash: (row.git_commit_hash as string) || undefined,
    gitRepositoryUrl: (row.git_repository_url as string) || undefined,
  };
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    role: row.role as Message['role'],
    content: row.content as string,
    timestamp: (row.timestamp as string) || undefined,
    messageIndex: (row.message_index as number) || 0,
    inputTokens: (row.input_tokens as number) || undefined,
    outputTokens: (row.output_tokens as number) || undefined,
    cacheCreationTokens: (row.cache_creation_tokens as number) || undefined,
    cacheReadTokens: (row.cache_read_tokens as number) || undefined,
    totalLinesAdded: (row.total_lines_added as number) || undefined,
    totalLinesRemoved: (row.total_lines_removed as number) || undefined,
    isCompactSummary: (row.is_compact_summary as boolean) || undefined,
    gitSnapshot: (row.git_snapshot as string) || undefined,
  };
}

export const CORRUPTED_MARKERS = new Set([
  'id', 'timestamp', 'model', 'kind', 'cost', 'csv_source',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'total_tokens',
  'conversation_id', 'ARROW1', 'ARROW', '',
]);

/**
 * Validate a billing event row from LanceDB.
 * Corrupted rows have Arrow schema metadata in data columns.
 * Returns true if the row appears valid.
 */
export function isValidBillingEvent(row: Record<string, unknown>): boolean {
  const timestamp = row.timestamp as string;
  const model = row.model as string;
  const csvSource = row.csv_source as string;

  // Check timestamp format: should start with YYYY- (4 digits + hyphen)
  if (!timestamp || !/^\d{4}-/.test(timestamp)) {
    return false;
  }

  // Check model is not a column name or Arrow marker
  if (model && CORRUPTED_MARKERS.has(model)) {
    return false;
  }

  // Check csv_source is not a column name or Arrow marker
  if (csvSource && CORRUPTED_MARKERS.has(csvSource)) {
    return false;
  }

  // Check for binary garbage in csv_source (Arrow offsets)
  if (csvSource && /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(csvSource)) {
    return false;
  }

  return true;
}

// Extract snippet around match positions
function extractSnippet(
  content: string,
  query: string,
  contextChars = 200
): { snippet: string; highlightRanges: [number, number][] } {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const terms = lowerQuery.split(/\s+/).filter((t) => t.length > 0);

  // First, try to find the full phrase match
  const fullPhrasePos = lowerContent.indexOf(lowerQuery);

  // Find all individual term positions as fallback
  const positions: number[] = [];
  for (const term of terms) {
    let pos = 0;
    while ((pos = lowerContent.indexOf(term, pos)) !== -1) {
      positions.push(pos);
      pos += 1;
    }
  }

  if (positions.length === 0 && fullPhrasePos === -1) {
    // No matches found, return start of content
    const snippet = content.slice(0, contextChars * 2);
    return {
      snippet: snippet + (content.length > contextChars * 2 ? '...' : ''),
      highlightRanges: [],
    };
  }

  // Prefer full phrase position, otherwise use first individual term match
  positions.sort((a, b) => a - b);
  const firstMatch = fullPhrasePos !== -1 ? fullPhrasePos : positions[0]!;

  // Calculate snippet bounds
  const start = Math.max(0, firstMatch - contextChars);
  const end = Math.min(content.length, firstMatch + contextChars);

  const snippet = content.slice(start, end);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';

  // Adjust highlight ranges for snippet offset
  const highlightRanges: [number, number][] = [];
  for (const term of terms) {
    let pos = 0;
    const snippetLower = snippet.toLowerCase();
    while ((pos = snippetLower.indexOf(term, pos)) !== -1) {
      highlightRanges.push([pos + prefix.length, pos + prefix.length + term.length]);
      pos += 1;
    }
  }

  return {
    snippet: prefix + snippet + suffix,
    highlightRanges,
  };
}

// Threshold for "short" messages that should include adjacent context
const SHORT_MESSAGE_THRESHOLD = 150;
// Maximum length for adjacent context snippets
const ADJACENT_SNIPPET_LENGTH = 200;

/**
 * Create a simple snippet from the beginning of a message (for adjacent context).
 * Unlike extractSnippet, this doesn't center around search terms.
 */
function createAdjacentSnippet(content: string, maxLength = ADJACENT_SNIPPET_LENGTH): string {
  const cleaned = content.replace(/\n+/g, ' ').trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  // Try to break at a word boundary
  const truncated = cleaned.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.7) {
    return truncated.slice(0, lastSpace) + '…';
  }
  return truncated + '…';
}

// ============ Conversation Repository ============

export const conversationRepo = {
  async exists(id: string): Promise<boolean> {
    const table = await getConversationsTable();
    const results = await table.query().where(`id = '${id}'`).limit(1).toArray();
    return results.length > 0;
  },

  async upsert(conv: Conversation): Promise<void> {
    const table = await getConversationsTable();
    const existing = await table
      .query()
      .where(`id = '${conv.id}'`)
      .limit(1)
      .toArray();

    if (existing.length > 0) {
      await table.delete(`id = '${conv.id}'`);
    }
    await table.add([conversationToRow(conv)]);
  },

  /**
   * Get the set of conversation IDs that already exist in the database.
   * Used for incremental sync to skip existing conversations.
   */
  async getExistingIds(candidateIds: string[]): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();

    const table = await getConversationsTable();
    const allExisting = await table.query().select(['id']).toArray();
    const existingIds = new Set(allExisting.map((row) => row.id as string));

    // Return only the IDs that exist from the candidate list
    return new Set(candidateIds.filter((id) => existingIds.has(id)));
  },

  /**
   * Get existing conversation metadata for update detection.
   * Returns a map of conversation ID -> { messageCount, updatedAt }
   * Used to detect conversations that have been updated with new messages.
   */
  async getExistingConversationMetadata(
    candidateIds: string[]
  ): Promise<Map<string, { messageCount: number; updatedAt: string | undefined }>> {
    if (candidateIds.length === 0) return new Map();

    const table = await getConversationsTable();
    const allExisting = await table
      .query()
      .select(['id', 'message_count', 'updated_at'])
      .toArray();

    const metadata = new Map<string, { messageCount: number; updatedAt: string | undefined }>();
    for (const row of allExisting) {
      const id = row.id as string;
      // Only include IDs that are in the candidate list
      if (candidateIds.includes(id)) {
        metadata.set(id, {
          messageCount: (row.message_count as number) || 0,
          updatedAt: (row.updated_at as string) || undefined,
        });
      }
    }

    return metadata;
  },

  /**
   * Get a map of originalId -> updatedAt for all conversations from a specific source.
   * Used for fast incremental sync - we can compare source timestamps against stored ones
   * without doing full extraction.
   */
  async getTimestampsBySource(
    source: string
  ): Promise<Map<string, number | undefined>> {
    const table = await getConversationsTable();
    const results = await table
      .query()
      .where(`source = '${source}'`)
      .select(['source_ref', 'updated_at'])
      .toArray();

    const timestamps = new Map<string, number | undefined>();
    for (const row of results) {
      const sourceRef = safeJsonParse<SourceRef>(row.source_ref, defaultSourceRef);
      if (sourceRef.originalId) {
        const updatedAt = row.updated_at as string | undefined;
        // Convert ISO string to epoch ms for comparison with source timestamps
        const epochMs = updatedAt ? new Date(updatedAt).getTime() : undefined;
        timestamps.set(sourceRef.originalId, epochMs);
      }
    }

    return timestamps;
  },

  async bulkUpsert(conversations: Conversation[]): Promise<void> {
    if (conversations.length === 0) return;

    const table = await getConversationsTable();

    // Get all existing IDs in one query
    const allExisting = await table.query().select(['id']).toArray();
    const existingIds = new Set(allExisting.map((row) => row.id as string));

    // Find IDs that need deletion
    const idsToDelete = conversations
      .filter((conv) => existingIds.has(conv.id))
      .map((conv) => conv.id);

    // Bulk delete existing (in batches to avoid query length limits)
    const BATCH_SIZE = 100;
    for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
      const batch = idsToDelete.slice(i, i + BATCH_SIZE);
      const whereClause = batch.map((id) => `id = '${id}'`).join(' OR ');
      await table.delete(whereClause);
    }

    // Convert all conversations to rows and bulk insert
    await table.add(conversations.map(conversationToRow));
  },

  async findById(id: string): Promise<Conversation | null> {
    return withConnectionRecovery(async () => {
      const table = await getConversationsTable();
      const results = await table.query().where(`id = '${id}'`).limit(1).toArray();

      if (results.length === 0) return null;
      return rowToConversation(results[0]!);
    });
  },

  async list(opts: {
    limit?: number;
    offset?: number;
    source?: string;
    model?: string;
    project?: string;
    fromDate?: string;
    toDate?: string;
  } = {}): Promise<{ conversations: Conversation[]; total: number }> {
    return withConnectionRecovery(async () => {
      const table = await getConversationsTable();

      // Fetch all to sort properly (LanceDB doesn't support ORDER BY)
      const results = await table.query().toArray();

      // Filter by source and/or model if specified
      let filtered = results;
      if (opts.source) {
        filtered = filtered.filter((row) => (row.source as string) === opts.source);
      }
      if (opts.model) {
        const modelLower = opts.model.toLowerCase();
        filtered = filtered.filter((row) => {
          const model = (row.model as string) || '';
          return model.toLowerCase().includes(modelLower);
        });
      }
      if (opts.project) {
        const projectLower = opts.project.toLowerCase();
        filtered = filtered.filter((row) => {
          const workspacePath = ((row.workspace_path as string) || '').toLowerCase();
          const projectName = ((row.project_name as string) || '').toLowerCase();
          return workspacePath.includes(projectLower) || projectName.includes(projectLower);
        });
      }
      if (opts.fromDate) {
        const from = new Date(opts.fromDate).getTime();
        filtered = filtered.filter((row) => {
          const created = row.created_at as string;
          return created && new Date(created).getTime() >= from;
        });
      }
      if (opts.toDate) {
        const to = new Date(opts.toDate).getTime() + 86400000; // Include end date
        filtered = filtered.filter((row) => {
          const created = row.created_at as string;
          return created && new Date(created).getTime() < to;
        });
      }

      // Sort by updated_at descending (most recent first)
      filtered.sort((a, b) => {
        const aDate = (a.updated_at as string) || '';
        const bDate = (b.updated_at as string) || '';
        return bDate.localeCompare(aDate);
      });

      // Save total before pagination
      const total = filtered.length;

      // Apply offset and limit after sorting
      const offset = opts.offset || 0;
      const limited = opts.limit
        ? filtered.slice(offset, offset + opts.limit)
        : filtered.slice(offset);

      return { conversations: limited.map(rowToConversation), total };
    });
  },

  async count(): Promise<number> {
    return withConnectionRecovery(async () => {
      const table = await getConversationsTable();
      const results = await table.query().select(['id']).toArray();
      return results.length;
    });
  },

  async delete(id: string): Promise<void> {
    await withConnectionRecovery(async () => {
      const table = await getConversationsTable();
      await table.delete(`id = '${id}'`);
    });
  },

  async deleteBySource(source: string, workspacePath?: string): Promise<void> {
    await withConnectionRecovery(async () => {
      const table = await getConversationsTable();
      if (workspacePath) {
        await table.delete(`source = '${source}' AND workspace_path = '${workspacePath}'`);
      } else {
        await table.delete(`source = '${source}'`);
      }
    });
  },

  /**
   * Find conversations with "Untitled" title
   */
  async findUntitled(limit = 100): Promise<Conversation[]> {
    const table = await getConversationsTable();
    const results = await table.query().toArray();

    // Filter for untitled conversations
    const untitled = results.filter((row) => {
      const title = (row.title as string) || '';
      return title === 'Untitled' || title.trim() === '';
    });

    // Sort by updated_at descending and limit
    untitled.sort((a, b) => {
      const aDate = (a.updated_at as string) || '';
      const bDate = (b.updated_at as string) || '';
      return bDate.localeCompare(aDate);
    });

    return untitled.slice(0, limit).map(rowToConversation);
  },

  async countUntitled(): Promise<number> {
    const table = await getConversationsTable();
    const results = await table.query().select(['title']).toArray();

    return results.filter((row) => {
      const title = (row.title as string) || '';
      return title === 'Untitled' || title.trim() === '';
    }).length;
  },

  /**
   * Count untitled conversations for a specific source
   */
  async countUntitledBySource(source: string): Promise<number> {
    const table = await getConversationsTable();
    const results = await table.query().select(['title', 'source']).toArray();

    return results.filter((row) => {
      const title = (row.title as string) || '';
      const rowSource = row.source as string;
      return (title === 'Untitled' || title.trim() === '') && rowSource === source;
    }).length;
  },

  /**
   * Find untitled conversations for a specific source
   */
  async findUntitledBySource(source: string, limit = 100): Promise<Conversation[]> {
    const table = await getConversationsTable();
    const results = await table.query().toArray();

    // Filter for untitled conversations from specific source
    const untitled = results.filter((row) => {
      const title = (row.title as string) || '';
      const rowSource = row.source as string;
      return (title === 'Untitled' || title.trim() === '') && rowSource === source;
    });

    // Sort by updated_at descending and limit
    untitled.sort((a, b) => {
      const aDate = (a.updated_at as string) || '';
      const bDate = (b.updated_at as string) || '';
      return bDate.localeCompare(aDate);
    });

    return untitled.slice(0, limit).map(rowToConversation);
  },

  async updateTitle(id: string, title: string): Promise<void> {
    await withConnectionRecovery(async () => {
      const table = await getConversationsTable();
      await table.update({
        where: `id = '${id}'`,
        values: { title },
      });
    });
  },

  async findByFilters(opts: {
    source?: string;
    workspacePath?: string;
    fromDate?: string;
    toDate?: string;
    ids?: string[];
  } = {}): Promise<Conversation[]> {
    const table = await getConversationsTable();
    const allResults = await table.query().toArray();

    let results = allResults;

    // Apply filters in memory (LanceDB has issues with complex WHERE clauses)
    if (opts.source) {
      results = results.filter((row) => (row.source as string) === opts.source);
    }
    if (opts.workspacePath) {
      results = results.filter((row) => {
        const wp = row.workspace_path as string;
        return wp && wp.includes(opts.workspacePath!);
      });
    }
    if (opts.fromDate) {
      const from = new Date(opts.fromDate).getTime();
      results = results.filter((row) => {
        const created = row.created_at as string;
        return created && new Date(created).getTime() >= from;
      });
    }
    if (opts.toDate) {
      const to = new Date(opts.toDate).getTime();
      results = results.filter((row) => {
        const created = row.created_at as string;
        return created && new Date(created).getTime() <= to;
      });
    }
    if (opts.ids && opts.ids.length > 0) {
      const idSet = new Set(opts.ids);
      results = results.filter((row) => idSet.has(row.id as string));
    }

    return results.map(rowToConversation);
  },

  async findByGitBranch(branch: string): Promise<Conversation[]> {
    return withConnectionRecovery(async () => {
      const table = await getConversationsTable();
      const results = await table.query().toArray();

      const filtered = results.filter((row) => {
        const rowBranch = (row.git_branch as string) || '';
        return rowBranch === branch;
      });

      filtered.sort((a, b) => {
        const aDate = (a.updated_at as string) || '';
        const bDate = (b.updated_at as string) || '';
        return bDate.localeCompare(aDate);
      });

      return filtered.map(rowToConversation);
    });
  },
};

// ============ Message Repository ============

export const messageRepo = {
  async count(): Promise<number> {
    return withConnectionRecovery(async () => {
      const table = await getMessagesTable();
      return table.countRows();
    });
  },

  async getExistingIdsByConversation(conversationId: string): Promise<Set<string>> {
    const table = await getMessagesTable();
    const allResults = await table.query().toArray();
    const ids = allResults
      .filter((row) => (row.conversation_id as string) === conversationId)
      .map((row) => row.id as string);
    return new Set(ids);
  },

  async getExistingIds(candidateIds: string[]): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();
    const table = await getMessagesTable();
    const results = await table.query().select(['id']).toArray();
    const allIds = new Set(results.map((row) => row.id as string));
    return new Set(candidateIds.filter((id) => allIds.has(id)));
  },

  async bulkInsert(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;

    const table = await getMessagesTable();
    const rows = messages.map((msg) => ({
      id: msg.id,
      conversation_id: msg.conversationId,
      role: msg.role,
      content: msg.content,
      indexed_content: stripToolOutputs(msg.content),
      timestamp: msg.timestamp ?? '',
      message_index: msg.messageIndex,
      vector: new Array(EMBEDDING_DIMENSIONS).fill(0),
      input_tokens: msg.inputTokens ?? 0,
      output_tokens: msg.outputTokens ?? 0,
      cache_creation_tokens: msg.cacheCreationTokens ?? 0,
      cache_read_tokens: msg.cacheReadTokens ?? 0,
      total_lines_added: msg.totalLinesAdded ?? 0,
      total_lines_removed: msg.totalLinesRemoved ?? 0,
      is_compact_summary: msg.isCompactSummary ?? false,
      git_snapshot: msg.gitSnapshot ?? '',
    }));

    await table.add(rows);
  },

  async bulkInsertNew(messages: Message[], existingIds: Set<string>): Promise<number> {
    const newMessages = messages.filter((msg) => !existingIds.has(msg.id));
    if (newMessages.length === 0) return 0;

    const table = await getMessagesTable();
    const rows = newMessages.map((msg) => ({
      id: msg.id,
      conversation_id: msg.conversationId,
      role: msg.role,
      content: msg.content,
      indexed_content: stripToolOutputs(msg.content),
      timestamp: msg.timestamp ?? '',
      message_index: msg.messageIndex,
      vector: new Array(EMBEDDING_DIMENSIONS).fill(0),
      input_tokens: msg.inputTokens ?? 0,
      output_tokens: msg.outputTokens ?? 0,
      cache_creation_tokens: msg.cacheCreationTokens ?? 0,
      cache_read_tokens: msg.cacheReadTokens ?? 0,
      total_lines_added: msg.totalLinesAdded ?? 0,
      total_lines_removed: msg.totalLinesRemoved ?? 0,
      is_compact_summary: msg.isCompactSummary ?? false,
      git_snapshot: msg.gitSnapshot ?? '',
    }));

    await table.add(rows);
    return newMessages.length;
  },

  async updateVector(messageId: string, vector: number[]): Promise<void> {
    const table = await getMessagesTable();
    // Use LanceDB's update() to preserve FTS index
    await table.update({
      where: `id = '${messageId}'`,
      values: { vector },
    });
  },

  async findByConversation(conversationId: string): Promise<Message[]> {
    return withConnectionRecovery(async () => {
      const table = await getMessagesTable();
      const results = await table
        .query()
        .where(`conversation_id = '${conversationId}'`)
        .toArray();

      return results.map(rowToMessage).sort((a, b) => a.messageIndex - b.messageIndex);
    });
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    await withConnectionRecovery(async () => {
      const table = await getMessagesTable();
      await table.delete(`conversation_id = '${conversationId}'`);
    });
  },

  async deleteByConversationIds(conversationIds: string[]): Promise<void> {
    if (conversationIds.length === 0) return;
    await withConnectionRecovery(async () => {
      const table = await getMessagesTable();
      // Use IN clause for bulk delete
      const idList = conversationIds.map((id) => `'${id}'`).join(', ');
      await table.delete(`conversation_id IN (${idList})`);
    });
  },

  async search(query: string, limit = 50): Promise<{ matches: MessageMatch[]; mode: 'hybrid' | 'fts' | 'basic' }> {
    // Wrap entire search in retry to handle transient errors during embedding
    // Use getFreshMessagesTable to avoid stale table references after cleanup
    return withConnectionRecovery(async () => {
      const table = await getFreshMessagesTable();

      // Try hybrid search with RRF (Reciprocal Rank Fusion)
      // Combines FTS keyword matching with vector semantic search
      try {
        const queryVector = await embedQuery(query);
        const reranker = await rerankers.RRFReranker.create();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const results = await (table.search(queryVector) as any)
          .fullTextSearch(query)
          .rerank(reranker)
          .select(['id', 'conversation_id', 'role', 'content', 'message_index'])
          .limit(limit)
          .toArray() as Record<string, unknown>[];

        const matches = results
          .filter((row: Record<string, unknown>) => {
            const content = row.content as string;
            return content && content.trim().length > 0;
          })
          .map((row: Record<string, unknown>, index: number) => {
            const content = row.content as string;
            const { snippet, highlightRanges } = extractSnippet(content, query);

            // After reranking, use rank-based score (results are already sorted by relevance)
            const score = 1 / (index + 1);

            return {
              messageId: row.id as string,
              conversationId: row.conversation_id as string,
              role: row.role as MessageMatch['role'],
              content,
              snippet,
              highlightRanges,
              score,
              messageIndex: row.message_index as number,
            };
          });
        return { matches, mode: 'hybrid' as const };
      } catch (err) {
        // Check for corrupted FTS index (fragment not found) - repair and rethrow to retry
        if (isFragmentNotFoundError(err)) {
          console.error('[search] Detected corrupted FTS index, repairing...');
          await repairFtsIndex();
          throw err; // Rethrow so withConnectionRecovery will retry with repaired index
        }
        // Re-throw other transient errors so withConnectionRecovery can handle them
        if (isTransientError(err)) throw err;
        // Log why hybrid search failed before falling back
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[search] Hybrid search failed, falling back to FTS: ${errMsg}`);
      }

      // Fallback: FTS-only search
      try {
        const ftsResults = await table
          .search(query, 'fts')
          .select(['id', 'conversation_id', 'role', 'content', 'message_index', '_score'])
          .limit(limit)
          .toArray();

        const matches = ftsResults
          .filter((row) => {
            const content = row.content as string;
            return content && content.trim().length > 0;
          })
          .map((row, rank) => {
            const content = row.content as string;
            const { snippet, highlightRanges } = extractSnippet(content, query);

            return {
              messageId: row.id as string,
              conversationId: row.conversation_id as string,
              role: row.role as MessageMatch['role'],
              content,
              snippet,
              highlightRanges,
              score: (row._score as number) ?? 1 / (rank + 1),
              messageIndex: row.message_index as number,
            };
          });
        return { matches, mode: 'fts' as const };
      } catch (err) {
        // Check for corrupted FTS index (fragment not found) - repair and rethrow to retry
        if (isFragmentNotFoundError(err)) {
          console.error('[search] Detected corrupted FTS index, repairing...');
          await repairFtsIndex();
          throw err; // Rethrow so withConnectionRecovery will retry with repaired index
        }
        // Re-throw other transient errors so withConnectionRecovery can handle them
        if (isTransientError(err)) throw err;
        // FTS index might be invalid, fall back to substring matching
      }

      // Last resort: basic substring matching
      const allMessages = await table
        .query()
        .select(['id', 'conversation_id', 'role', 'content', 'message_index'])
        .limit(5000)
        .toArray();

      const queryLower = query.toLowerCase();
      const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);

      const matches = allMessages
        .filter((row) => {
          const content = row.content as string;
          if (!content) return false;
          const contentLower = content.toLowerCase();
          return queryTerms.some((term) => contentLower.includes(term));
        })
        .slice(0, limit)
        .map((row, rank) => {
          const content = row.content as string;
          const contentLower = content.toLowerCase();
          const matchCount = queryTerms.filter((term) => contentLower.includes(term)).length;
          const { snippet, highlightRanges } = extractSnippet(content, query);

          return {
            messageId: row.id as string,
            conversationId: row.conversation_id as string,
            role: row.role as MessageMatch['role'],
            content,
            snippet,
            highlightRanges,
            score: matchCount / queryTerms.length,
            messageIndex: row.message_index as number,
          };
        });
      return { matches, mode: 'basic' as const };
    });
  },
};

// ============ Tool Call Repository ============

export const toolCallRepo = {
  async bulkInsert(toolCalls: ToolCall[]): Promise<void> {
    if (toolCalls.length === 0) return;

    const table = await getToolCallsTable();
    const rows = toolCalls.map((tc) => ({
      id: tc.id,
      message_id: tc.messageId,
      conversation_id: tc.conversationId,
      type: tc.type,
      input: tc.input,
      output: tc.output ?? '',
      file_path: tc.filePath ?? '',
    }));

    await table.add(rows);
  },

  async getExistingIds(candidateIds: string[]): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();
    const table = await getToolCallsTable();
    const results = await table.query().select(['id']).toArray();
    const allIds = new Set(results.map((row) => row.id as string));
    return new Set(candidateIds.filter((id) => allIds.has(id)));
  },

  async bulkInsertNew(toolCalls: ToolCall[], existingIds: Set<string>): Promise<number> {
    const newToolCalls = toolCalls.filter((tc) => !existingIds.has(tc.id));
    if (newToolCalls.length === 0) return 0;

    const table = await getToolCallsTable();
    const rows = newToolCalls.map((tc) => ({
      id: tc.id,
      message_id: tc.messageId,
      conversation_id: tc.conversationId,
      type: tc.type,
      input: tc.input,
      output: tc.output ?? '',
      file_path: tc.filePath ?? '',
    }));

    await table.add(rows);
    return newToolCalls.length;
  },

  async findByFile(filePath: string): Promise<ToolCall[]> {
    return withConnectionRecovery(async () => {
      const table = await getToolCallsTable();
      const results = await table
        .query()
        .where(`file_path = '${filePath}'`)
        .toArray();

      return results.map((row) => ({
        id: row.id as string,
        messageId: row.message_id as string,
        conversationId: row.conversation_id as string,
        type: row.type as string,
        input: row.input as string,
        output: (row.output as string) || undefined,
        filePath: (row.file_path as string) || undefined,
      }));
    });
  },

  async findByConversation(conversationId: string): Promise<ToolCall[]> {
    return withConnectionRecovery(async () => {
      const table = await getToolCallsTable();
      const results = await table
        .query()
        .where(`conversation_id = '${conversationId}'`)
        .toArray();

      return results.map((row) => ({
        id: row.id as string,
        messageId: row.message_id as string,
        conversationId: row.conversation_id as string,
        type: row.type as string,
        input: row.input as string,
        output: (row.output as string) || undefined,
        filePath: (row.file_path as string) || undefined,
      }));
    });
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    await withConnectionRecovery(async () => {
      const table = await getToolCallsTable();
      await table.delete(`conversation_id = '${conversationId}'`);
    });
  },

  async deleteByConversationIds(conversationIds: string[]): Promise<void> {
    if (conversationIds.length === 0) return;
    await withConnectionRecovery(async () => {
      const table = await getToolCallsTable();
      const idList = conversationIds.map((id) => `'${id}'`).join(', ');
      await table.delete(`conversation_id IN (${idList})`);
    });
  },
};

// ============ Sync State Repository ============

export const syncStateRepo = {
  async get(source: string, dbPath: string): Promise<SyncState | null> {
    const table = await getSyncStateTable();
    const results = await table
      .query()
      .where(`source = '${source}' AND db_path = '${dbPath}'`)
      .limit(1)
      .toArray();

    if (results.length === 0) return null;

    const row = results[0]!;
    return {
      source: row.source as SyncState['source'],
      workspacePath: row.workspace_path as string,
      dbPath: row.db_path as string,
      lastSyncedAt: row.last_synced_at as string,
      lastMtime: row.last_mtime as number,
    };
  },

  async set(state: SyncState): Promise<void> {
    // Use retry logic to handle commit conflicts from concurrent operations
    await withConnectionRecovery(async () => {
      const table = await getSyncStateTable();

      // Delete existing if any
      await table.delete(`source = '${state.source}' AND db_path = '${state.dbPath}'`);

      await table.add([
        {
          source: state.source,
          workspace_path: state.workspacePath,
          db_path: state.dbPath,
          last_synced_at: state.lastSyncedAt,
          last_mtime: state.lastMtime,
        },
      ]);
    });
  },
};

// ============ Conversation Files Repository ============

export const filesRepo = {
  async bulkInsert(files: ConversationFile[]): Promise<void> {
    if (files.length === 0) return;

    const table = await getFilesTable();
    const rows = files.map((f) => ({
      id: f.id,
      conversation_id: f.conversationId,
      file_path: f.filePath,
      role: f.role,
    }));

    await table.add(rows);
  },

  async getExistingIds(candidateIds: string[]): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();
    const table = await getFilesTable();
    const results = await table.query().select(['id']).toArray();
    const allIds = new Set(results.map((row) => row.id as string));
    return new Set(candidateIds.filter((id) => allIds.has(id)));
  },

  async bulkInsertNew(files: ConversationFile[], existingIds: Set<string>): Promise<number> {
    const newFiles = files.filter((f) => !existingIds.has(f.id));
    if (newFiles.length === 0) return 0;

    const table = await getFilesTable();
    const rows = newFiles.map((f) => ({
      id: f.id,
      conversation_id: f.conversationId,
      file_path: f.filePath,
      role: f.role,
    }));

    await table.add(rows);
    return newFiles.length;
  },

  async findByConversation(conversationId: string): Promise<ConversationFile[]> {
    return withConnectionRecovery(async () => {
      const table = await getFilesTable();
      const results = await table
        .query()
        .where(`conversation_id = '${conversationId}'`)
        .toArray();

      return results.map((row) => ({
        id: row.id as string,
        conversationId: row.conversation_id as string,
        filePath: row.file_path as string,
        role: row.role as ConversationFile['role'],
      }));
    });
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    await withConnectionRecovery(async () => {
      const table = await getFilesTable();
      await table.delete(`conversation_id = '${conversationId}'`);
    });
  },

  async deleteByConversationIds(conversationIds: string[]): Promise<void> {
    if (conversationIds.length === 0) return;
    await withConnectionRecovery(async () => {
      const table = await getFilesTable();
      const idList = conversationIds.map((id) => `'${id}'`).join(', ');
      await table.delete(`conversation_id IN (${idList})`);
    });
  },
};

// ============ Message Files Repository ============

export const messageFilesRepo = {
  async bulkInsert(files: MessageFile[]): Promise<void> {
    if (files.length === 0) return;

    const table = await getMessageFilesTable();
    const rows = files.map((f) => ({
      id: f.id,
      message_id: f.messageId,
      conversation_id: f.conversationId,
      file_path: f.filePath,
      role: f.role,
    }));

    await table.add(rows);
  },

  async getExistingIds(candidateIds: string[]): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();
    const table = await getMessageFilesTable();
    const results = await table.query().select(['id']).toArray();
    const allIds = new Set(results.map((row) => row.id as string));
    return new Set(candidateIds.filter((id) => allIds.has(id)));
  },

  async bulkInsertNew(files: MessageFile[], existingIds: Set<string>): Promise<number> {
    const newFiles = files.filter((f) => !existingIds.has(f.id));
    if (newFiles.length === 0) return 0;

    const table = await getMessageFilesTable();
    const rows = newFiles.map((f) => ({
      id: f.id,
      message_id: f.messageId,
      conversation_id: f.conversationId,
      file_path: f.filePath,
      role: f.role,
    }));

    await table.add(rows);
    return newFiles.length;
  },

  async findByMessage(messageId: string): Promise<MessageFile[]> {
    return withConnectionRecovery(async () => {
      const table = await getMessageFilesTable();
      const results = await table
        .query()
        .where(`message_id = '${messageId}'`)
        .toArray();

      return results.map((row) => ({
        id: row.id as string,
        messageId: row.message_id as string,
        conversationId: row.conversation_id as string,
        filePath: row.file_path as string,
        role: row.role as MessageFile['role'],
      }));
    });
  },

  async findByConversation(conversationId: string): Promise<MessageFile[]> {
    return withConnectionRecovery(async () => {
      const table = await getMessageFilesTable();
      const results = await table
        .query()
        .where(`conversation_id = '${conversationId}'`)
        .toArray();

      return results.map((row) => ({
        id: row.id as string,
        messageId: row.message_id as string,
        conversationId: row.conversation_id as string,
        filePath: row.file_path as string,
        role: row.role as MessageFile['role'],
      }));
    });
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    await withConnectionRecovery(async () => {
      const table = await getMessageFilesTable();
      await table.delete(`conversation_id = '${conversationId}'`);
    });
  },

  async deleteByConversationIds(conversationIds: string[]): Promise<void> {
    if (conversationIds.length === 0) return;
    await withConnectionRecovery(async () => {
      const table = await getMessageFilesTable();
      const idList = conversationIds.map((id) => `'${id}'`).join(', ');
      await table.delete(`conversation_id IN (${idList})`);
    });
  },
};

// ============ File Edits Repository ============

export const fileEditsRepo = {
  async getExistingIdsByConversation(conversationId: string): Promise<Set<string>> {
    const table = await getFileEditsTable();
    const results = await table
      .query()
      .where(`conversation_id = '${conversationId}'`)
      .toArray();
    const ids = results.map((row) => row.id as string);
    return new Set(ids);
  },

  async getExistingIds(candidateIds: string[]): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();
    const table = await getFileEditsTable();
    const results = await table.query().select(['id']).toArray();
    const allIds = new Set(results.map((row) => row.id as string));
    return new Set(candidateIds.filter((id) => allIds.has(id)));
  },

  async bulkInsert(edits: FileEdit[]): Promise<void> {
    if (edits.length === 0) return;

    const table = await getFileEditsTable();
    const rows = edits.map((e) => ({
      id: e.id,
      message_id: e.messageId,
      conversation_id: e.conversationId,
      file_path: e.filePath,
      edit_type: e.editType,
      lines_added: e.linesAdded,
      lines_removed: e.linesRemoved,
      start_line: e.startLine ?? 0,
      end_line: e.endLine ?? 0,
      new_content: e.newContent ?? '',
    }));

    await table.add(rows);
  },

  async bulkInsertNew(edits: FileEdit[], existingIds: Set<string>): Promise<number> {
    const newEdits = edits.filter((e) => !existingIds.has(e.id));
    if (newEdits.length === 0) return 0;

    const table = await getFileEditsTable();
    const rows = newEdits.map((e) => ({
      id: e.id,
      message_id: e.messageId,
      conversation_id: e.conversationId,
      file_path: e.filePath,
      edit_type: e.editType,
      lines_added: e.linesAdded,
      lines_removed: e.linesRemoved,
      start_line: e.startLine ?? 0,
      end_line: e.endLine ?? 0,
      new_content: e.newContent ?? '',
    }));

    await table.add(rows);
    return newEdits.length;
  },

  async findByMessage(messageId: string): Promise<FileEdit[]> {
    return withConnectionRecovery(async () => {
      const table = await getFileEditsTable();
      const results = await table
        .query()
        .where(`message_id = '${messageId}'`)
        .toArray();

      return results.map((row) => ({
        id: row.id as string,
        messageId: row.message_id as string,
        conversationId: row.conversation_id as string,
        filePath: row.file_path as string,
        editType: row.edit_type as FileEdit['editType'],
        linesAdded: row.lines_added as number,
        linesRemoved: row.lines_removed as number,
        startLine: (row.start_line as number) || undefined,
        endLine: (row.end_line as number) || undefined,
        newContent: (row.new_content as string) || undefined,
      }));
    });
  },

  async findByConversation(conversationId: string): Promise<FileEdit[]> {
    return withConnectionRecovery(async () => {
      const table = await getFileEditsTable();
      const results = await table
        .query()
        .where(`conversation_id = '${conversationId}'`)
        .toArray();

      return results.map((row) => ({
        id: row.id as string,
        messageId: row.message_id as string,
        conversationId: row.conversation_id as string,
        filePath: row.file_path as string,
        editType: row.edit_type as FileEdit['editType'],
        linesAdded: row.lines_added as number,
        linesRemoved: row.lines_removed as number,
        startLine: (row.start_line as number) || undefined,
        endLine: (row.end_line as number) || undefined,
        newContent: (row.new_content as string) || undefined,
      }));
    });
  },

  async deleteByConversation(conversationId: string): Promise<void> {
    await withConnectionRecovery(async () => {
      const table = await getFileEditsTable();
      await table.delete(`conversation_id = '${conversationId}'`);
    });
  },

  async deleteByConversationIds(conversationIds: string[]): Promise<void> {
    if (conversationIds.length === 0) return;
    await withConnectionRecovery(async () => {
      const table = await getFileEditsTable();
      const idList = conversationIds.map((id) => `'${id}'`).join(', ');
      await table.delete(`conversation_id IN (${idList})`);
    });
  },
};

// ============ File Search ============

export interface FileSearchMatch {
  conversationId: string;
  filePath: string;
  role: 'edited' | 'context' | 'mentioned';
  score: number;
}

function scoreFileRole(role: string): number {
  const scores: Record<string, number> = { edited: 1.0, context: 0.5, mentioned: 0.3 };
  return scores[role] ?? 0.3;
}

/**
 * Search for conversations by file path pattern (case-insensitive substring match).
 * Returns matches from all file tables, deduplicated and ranked by role.
 */
export async function searchByFilePath(
  pattern: string,
  limit = 50
): Promise<FileSearchMatch[]> {
  const lowerPattern = pattern.toLowerCase();

  // Query all three file tables
  const [fileEditsTable, conversationFilesTable, messageFilesTable] = await Promise.all([
    getFileEditsTable(),
    getFilesTable(),
    getMessageFilesTable(),
  ]);

  const [fileEdits, conversationFiles, messageFiles] = await Promise.all([
    fileEditsTable.query().toArray(),
    conversationFilesTable.query().toArray(),
    messageFilesTable.query().toArray(),
  ]);

  // Collect matches with scores, using Map for deduplication
  // Key: conversationId:filePath, prioritize highest score
  const matchMap = new Map<string, FileSearchMatch>();

  const addMatch = (conversationId: string, filePath: string, role: 'edited' | 'context' | 'mentioned') => {
    const key = `${conversationId}:${filePath}`;
    const score = scoreFileRole(role);
    const existing = matchMap.get(key);
    if (!existing || score > existing.score) {
      matchMap.set(key, { conversationId, filePath, role, score });
    }
  };

  // File edits (role = 'edited')
  for (const row of fileEdits) {
    const filePath = row.file_path as string;
    if (filePath.toLowerCase().includes(lowerPattern)) {
      addMatch(row.conversation_id as string, filePath, 'edited');
    }
  }

  // Conversation files (use stored role)
  for (const row of conversationFiles) {
    const filePath = row.file_path as string;
    if (filePath.toLowerCase().includes(lowerPattern)) {
      const role = row.role as 'edited' | 'context' | 'mentioned';
      addMatch(row.conversation_id as string, filePath, role);
    }
  }

  // Message files (use stored role)
  for (const row of messageFiles) {
    const filePath = row.file_path as string;
    if (filePath.toLowerCase().includes(lowerPattern)) {
      const role = row.role as 'edited' | 'context' | 'mentioned';
      addMatch(row.conversation_id as string, filePath, role);
    }
  }

  // Sort by score descending, take top N
  const results = Array.from(matchMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return results;
}

/**
 * Get file matches for a set of conversation IDs.
 * Used to enrich search results with file match info.
 */
export async function getFileMatchesForConversations(
  conversationIds: Set<string>,
  pattern: string
): Promise<Map<string, FileSearchMatch[]>> {
  const lowerPattern = pattern.toLowerCase();
  const result = new Map<string, FileSearchMatch[]>();

  // Initialize empty arrays for all requested conversations
  for (const id of conversationIds) {
    result.set(id, []);
  }

  // Query all three file tables
  const [fileEditsTable, conversationFilesTable, messageFilesTable] = await Promise.all([
    getFileEditsTable(),
    getFilesTable(),
    getMessageFilesTable(),
  ]);

  const [fileEdits, conversationFiles, messageFiles] = await Promise.all([
    fileEditsTable.query().toArray(),
    conversationFilesTable.query().toArray(),
    messageFilesTable.query().toArray(),
  ]);

  // Per-conversation deduplication
  const matchMaps = new Map<string, Map<string, FileSearchMatch>>();
  for (const id of conversationIds) {
    matchMaps.set(id, new Map());
  }

  const addMatch = (conversationId: string, filePath: string, role: 'edited' | 'context' | 'mentioned') => {
    const convMap = matchMaps.get(conversationId);
    if (!convMap) return;

    const score = scoreFileRole(role);
    const existing = convMap.get(filePath);
    if (!existing || score > existing.score) {
      convMap.set(filePath, { conversationId, filePath, role, score });
    }
  };

  // File edits (role = 'edited')
  for (const row of fileEdits) {
    const conversationId = row.conversation_id as string;
    if (!conversationIds.has(conversationId)) continue;
    const filePath = row.file_path as string;
    if (filePath.toLowerCase().includes(lowerPattern)) {
      addMatch(conversationId, filePath, 'edited');
    }
  }

  // Conversation files
  for (const row of conversationFiles) {
    const conversationId = row.conversation_id as string;
    if (!conversationIds.has(conversationId)) continue;
    const filePath = row.file_path as string;
    if (filePath.toLowerCase().includes(lowerPattern)) {
      addMatch(conversationId, filePath, row.role as 'edited' | 'context' | 'mentioned');
    }
  }

  // Message files
  for (const row of messageFiles) {
    const conversationId = row.conversation_id as string;
    if (!conversationIds.has(conversationId)) continue;
    const filePath = row.file_path as string;
    if (filePath.toLowerCase().includes(lowerPattern)) {
      addMatch(conversationId, filePath, row.role as 'edited' | 'context' | 'mentioned');
    }
  }

  // Convert maps to sorted arrays
  for (const [convId, convMap] of matchMaps) {
    const matches = Array.from(convMap.values()).sort((a, b) => b.score - a.score);
    result.set(convId, matches);
  }

  return result;
}

// ============ Search Service ============

/**
 * Add adjacent context to matches (e.g., assistant response after a user question).
 * This helps users see the resolution/outcome, not just where the term appeared.
 */
async function enrichMatchesWithAdjacentContext(
  matches: MessageMatch[],
  conversationId: string
): Promise<MessageMatch[]> {
  if (matches.length === 0) return matches;

  // Fetch all messages for this conversation to find adjacent messages
  const allMessages = await messageRepo.findByConversation(conversationId);
  if (allMessages.length === 0) return matches;

  // Build a map of messageIndex -> message for quick lookup
  const messageByIndex = new Map(allMessages.map((m) => [m.messageIndex, m]));

  return matches.map((match) => {
    // For short user messages, include the following assistant response
    if (match.role === 'user' && match.content.length < SHORT_MESSAGE_THRESHOLD) {
      const nextMsg = messageByIndex.get(match.messageIndex + 1);
      if (nextMsg && nextMsg.role === 'assistant') {
        const adjacentContext: AdjacentContext = {
          role: 'assistant',
          snippet: createAdjacentSnippet(nextMsg.content),
          messageIndex: nextMsg.messageIndex,
        };
        return { ...match, adjacentContext };
      }
    }

    // For assistant messages, optionally include the preceding user question
    // This gives context for why the assistant said what it did
    if (match.role === 'assistant') {
      const prevMsg = messageByIndex.get(match.messageIndex - 1);
      if (prevMsg && prevMsg.role === 'user' && prevMsg.content.length < SHORT_MESSAGE_THRESHOLD * 2) {
        const adjacentContext: AdjacentContext = {
          role: 'user',
          snippet: createAdjacentSnippet(prevMsg.content),
          messageIndex: prevMsg.messageIndex,
        };
        return { ...match, adjacentContext };
      }
    }

    return match;
  });
}

export async function search(query: string, limit = 50): Promise<SearchResponse> {
  const startTime = Date.now();

  // 1. Search messages
  const { matches: messageMatches, mode: searchMode } = await messageRepo.search(query, limit);

  if (messageMatches.length === 0) {
    return {
      query,
      results: [],
      totalConversations: 0,
      totalMessages: 0,
      searchTimeMs: Date.now() - startTime,
      searchMode,
    };
  }

  // 2. Group by conversation
  const grouped = groupBy(messageMatches, (m) => m.conversationId);

  // 3. Fetch conversation metadata for each group
  const conversationIds = Object.keys(grouped);
  const conversations: Conversation[] = [];

  for (const id of conversationIds) {
    const conv = await conversationRepo.findById(id);
    if (conv) {
      conversations.push(conv);
    }
  }

  // 4. Build ConversationResult objects with enriched matches
  const results: ConversationResult[] = [];

  for (const conv of conversations) {
    const matches = grouped[conv.id] ?? [];
    if (matches.length === 0) continue;

    // Enrich matches with adjacent context (e.g., assistant response after user query)
    const enrichedMatches = await enrichMatchesWithAdjacentContext(matches, conv.id);
    const sortedMatches = [...enrichedMatches].sort((a, b) => b.score - a.score);
    const bestMatch = sortedMatches[0];

    if (!bestMatch) continue;

    results.push({
      conversation: conv,
      matches: sortedMatches,
      bestMatch,
      totalMatches: matches.length,
    });
  }

  // 5. Apply recency bias to ranking
  // Time-decay: recent conversations get a boost, older ones decay toward baseline
  // Formula: combinedScore = relevanceScore * (BASE_WEIGHT + RECENCY_WEIGHT * e^(-λ * days))
  // With λ=0.01: ~97% at 3 days, ~90% at 10 days, ~37% at 100 days
  const DECAY_LAMBDA = 0.01;
  const BASE_WEIGHT = 0.7; // Minimum weight from relevance alone
  const RECENCY_WEIGHT = 0.3; // Maximum boost from recency
  const now = Date.now();

  for (const result of results) {
    const updatedAt = result.conversation.updatedAt
      ? new Date(result.conversation.updatedAt).getTime()
      : 0;
    const daysOld = Math.max(0, (now - updatedAt) / (1000 * 60 * 60 * 24));
    const recencyFactor = Math.exp(-DECAY_LAMBDA * daysOld);

    // Apply recency boost to the result's effective score for ranking
    // Store original score for display, use boosted score for sorting
    (result as ConversationResult & { _rankScore: number })._rankScore =
      result.bestMatch.score * (BASE_WEIGHT + RECENCY_WEIGHT * recencyFactor);
  }

  // 6. Sort by recency-adjusted score
  results.sort((a, b) => {
    const aScore = (a as ConversationResult & { _rankScore?: number })._rankScore ?? a.bestMatch.score;
    const bScore = (b as ConversationResult & { _rankScore?: number })._rankScore ?? b.bestMatch.score;
    return bScore - aScore;
  });

  return {
    query,
    results,
    totalConversations: results.length,
    totalMessages: messageMatches.length,
    searchTimeMs: Date.now() - startTime,
    searchMode,
  };
}

// ============ Billing Events Repository ============

export const billingEventsRepo = {
  async bulkInsert(events: BillingEvent[]): Promise<void> {
    if (events.length === 0) return;

    await withConnectionRecovery(async () => {
      const table = await getBillingEventsTable();
      const rows = events.map((e) => ({
        id: e.id,
        conversation_id: e.conversationId ?? '',
        timestamp: e.timestamp,
        model: e.model,
        kind: e.kind,
        input_tokens: e.inputTokens ?? 0,
        output_tokens: e.outputTokens ?? 0,
        cache_read_tokens: e.cacheReadTokens ?? 0,
        total_tokens: e.totalTokens ?? 0,
        cost: e.cost ?? 0,
        csv_source: e.csvSource ?? '',
      }));

      await table.add(rows);
    });
  },

  async deleteBySource(csvSource: string): Promise<void> {
    await withConnectionRecovery(async () => {
      const table = await getBillingEventsTable();
      await table.delete(`csv_source = '${csvSource}'`);
    });
  },

  async count(): Promise<number> {
    return withConnectionRecovery(async () => {
      const table = await getBillingEventsTable();
      return table.countRows();
    });
  },

  async countBySource(csvSource: string): Promise<number> {
    return withConnectionRecovery(async () => {
      const table = await getBillingEventsTable();
      const results = await table
        .query()
        .where(`csv_source = '${csvSource}'`)
        .select(['id'])
        .toArray();
      return results.length;
    });
  },

  async getTotals(): Promise<{
    totalEvents: number;
    totalTokens: number;
    eventsWithTokens: number;
    eventsWithoutTokens: number;
    attributedEvents: number;
    unattributedEvents: number;
  }> {
    return withConnectionRecovery(async () => {
      const table = await getBillingEventsTable();
      const allRows = await table.query().toArray();
      const results = allRows.filter(isValidBillingEvent);

      let totalTokens = 0;
      let eventsWithTokens = 0;
      let eventsWithoutTokens = 0;
      let attributedEvents = 0;
      let unattributedEvents = 0;

      for (const row of results) {
        const tokens = row.total_tokens as number;
        if (tokens > 0) {
          totalTokens += tokens;
          eventsWithTokens++;
        } else {
          eventsWithoutTokens++;
        }

        const convId = row.conversation_id as string;
        if (convId && convId.length > 0) {
          attributedEvents++;
        } else {
          unattributedEvents++;
        }
      }

      return {
        totalEvents: results.length,
        totalTokens,
        eventsWithTokens,
        eventsWithoutTokens,
        attributedEvents,
        unattributedEvents,
      };
    });
  },

  async getByConversation(conversationId: string): Promise<BillingEvent[]> {
    return withConnectionRecovery(async () => {
      const table = await getBillingEventsTable();
      const allResults = await table
        .query()
        .where(`conversation_id = '${conversationId}'`)
        .toArray();

      return allResults.filter(isValidBillingEvent).map((row) => ({
        id: row.id as string,
        conversationId: (row.conversation_id as string) || undefined,
        timestamp: row.timestamp as string,
        model: row.model as string,
        kind: row.kind as string,
        inputTokens: (row.input_tokens as number) || undefined,
        outputTokens: (row.output_tokens as number) || undefined,
        cacheReadTokens: (row.cache_read_tokens as number) || undefined,
        totalTokens: (row.total_tokens as number) || undefined,
        cost: (row.cost as number) || undefined,
        csvSource: row.csv_source as string,
      }));
    });
  },

  async getTokensByConversation(conversationId: string): Promise<number> {
    return withConnectionRecovery(async () => {
      const table = await getBillingEventsTable();
      const results = await table
        .query()
        .where(`conversation_id = '${conversationId}'`)
        .select(['total_tokens'])
        .toArray();

      return results.reduce((sum, row) => sum + ((row.total_tokens as number) || 0), 0);
    });
  },

  async getDistinctConversationIds(): Promise<Set<string>> {
    return withConnectionRecovery(async () => {
      const table = await getBillingEventsTable();
      const results = await table.query().select(['conversation_id']).toArray();
      const ids = new Set<string>();
      for (const row of results) {
        const id = row.conversation_id as string;
        if (id && id.length > 0 && !CORRUPTED_MARKERS.has(id)) {
          ids.add(id);
        }
      }
      return ids;
    });
  },
};
