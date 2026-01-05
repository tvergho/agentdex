/**
 * Analytics query functions for the stats dashboard
 */

import { connect, getConversationsTable, getMessagesTable, getFilesTable, getFileEditsTable, getBillingEventsTable, withConnectionRecovery, isTransientError } from './index';
import type { Table } from '@lancedb/lancedb';
import { Source, type Conversation } from '../schema/index';
import { isValidBillingEvent } from './repository';

// --- Types ---

export interface PeriodFilter {
  startDate: Date;
  endDate: Date;
}

/**
 * A "turn" is a user prompt - the consistent unit of interaction across sources.
 * We count role='user' messages from the messages table for consistency.
 */
export interface TurnCounts {
  byConversation: Map<string, number>;
  bySource: Map<string, number>;
  byMonth: Map<number, number>;  // 0-11 for Jan-Dec
  total: number;
}

export interface DayActivity {
  date: string;
  conversations: number;
  messages: number;
  turns: number;
  tokens: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface SourceStats {
  source: string;
  conversations: number;
  messages: number;
  turns: number;
  tokens: number;
}

export interface ModelStats {
  model: string;
  source: string;
  conversations: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LinesGeneratedStats {
  totalLinesAdded: number;
  totalLinesRemoved: number;
  netLines: number;
  topConversationsByLines: Array<{
    id: string;
    title: string;
    linesAdded: number;
    linesRemoved: number;
  }>;
}

export interface CacheStats {
  totalInput: number;
  totalOutput: number;
  cacheCreation: number;
  cacheRead: number;
  hitRate: number;
}

export interface OverviewStats {
  conversations: number;
  messages: number;
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
}

export interface StreakInfo {
  current: number;
  longest: number;
  longestStart: string;
  longestEnd: string;
}

export interface ProjectStats {
  projectName: string;
  workspacePath: string;
  conversations: number;
  messages: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  linesAdded: number;
  linesRemoved: number;
  lastActivity: string;
}

export interface FileStats {
  filePath: string;
  relativePath: string;     // Path relative to workspace root (more readable)
  projectName: string;      // Project this file belongs to
  editCount: number;
  mentionCount: number;
  linesAdded: number;
  linesRemoved: number;
  conversationCount: number;
}

export interface EditTypeBreakdown {
  create: number;
  modify: number;
  delete: number;
}

export interface FileTypeStats {
  extension: string;
  editCount: number;
  linesAdded: number;
}

export interface DailyTokensBySource {
  date: string;           // YYYY-MM-DD
  cursor: number;         // Tokens from Cursor
  claudeCode: number;     // Tokens from Claude Code
  codex: number;          // Tokens from Codex
  opencode: number;       // Tokens from OpenCode
  total: number;          // Combined total
}

// --- Helper Functions ---

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]!;
}

function isInPeriod(dateStr: string | undefined, period: PeriodFilter): boolean {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  return date >= period.startDate && date < period.endDate;
}

export function createPeriodFilter(days: number): PeriodFilter {
  const endDate = new Date();
  endDate.setHours(23, 59, 59, 999);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);
  return { startDate, endDate };
}

// --- Query Helper ---

async function queryTableWithRetry<T>(
  getTable: () => Promise<Table>,
  query: (table: Table) => Promise<T>
): Promise<T> {
  return withConnectionRecovery(async () => {
    const table = await getTable();
    return query(table);
  });
}

export async function getTurnCounts(period?: PeriodFilter): Promise<TurnCounts> {
  await connect();
  
  const [msgRows, convRows] = await Promise.all([
    queryTableWithRetry(getMessagesTable, table => 
      table.query().select(['conversation_id', 'role', 'timestamp']).toArray()
    ),
    queryTableWithRetry(getConversationsTable, table => 
      table.query().select(['id', 'source', 'created_at']).toArray()
    ),
  ]);

  const convSourceMap = new Map<string, string>();
  const convDateMap = new Map<string, string>();
  for (const c of convRows) {
    convSourceMap.set(c.id as string, c.source as string);
    convDateMap.set(c.id as string, c.created_at as string);
  }

  const byConversation = new Map<string, number>();
  const bySource = new Map<string, number>();
  const byMonth = new Map<number, number>();
  let total = 0;

  for (const m of msgRows) {
    if ((m.role as string) !== 'user') continue;
    
    const convId = m.conversation_id as string;
    const source = convSourceMap.get(convId) || 'unknown';
    const timestamp = (m.timestamp as string) || convDateMap.get(convId);
    
    if (period) {
      if (!timestamp || !isInPeriod(timestamp, period)) continue;
    }

    byConversation.set(convId, (byConversation.get(convId) || 0) + 1);
    bySource.set(source, (bySource.get(source) || 0) + 1);
    
    if (timestamp) {
      const month = new Date(timestamp).getMonth();
      byMonth.set(month, (byMonth.get(month) || 0) + 1);
    }
    
    total++;
  }

  return { byConversation, bySource, byMonth, total };
}

/**
 * Map a raw database row to a Conversation object.
 * Handles snake_case to camelCase conversion.
 */
function mapRowToConversation(row: Record<string, unknown>): Conversation {
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
    sourceRef: row.source_ref_json ? JSON.parse(row.source_ref_json as string) : undefined,
    totalInputTokens: (row.total_input_tokens as number) || undefined,
    totalOutputTokens: (row.total_output_tokens as number) || undefined,
    totalCacheCreationTokens: (row.total_cache_creation_tokens as number) || undefined,
    totalCacheReadTokens: (row.total_cache_read_tokens as number) || undefined,
    totalLinesAdded: (row.total_lines_added as number) || undefined,
    totalLinesRemoved: (row.total_lines_removed as number) || undefined,
    compactCount: (row.compact_count as number) || undefined,
  };
}

// --- Query Functions ---

export async function getOverviewStats(period: PeriodFilter): Promise<OverviewStats> {
  await connect();
  
  const [rows, turnCounts] = await Promise.all([
    queryTableWithRetry(getConversationsTable, table => table.query().toArray()),
    getTurnCounts(period),
  ]);

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  let messages = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;

  for (const conv of filtered) {
    messages += (conv.message_count as number) || 0;
    totalInputTokens += ((conv.total_input_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0);
    totalOutputTokens += (conv.total_output_tokens as number) || 0;
    totalLinesAdded += (conv.total_lines_added as number) || 0;
    totalLinesRemoved += (conv.total_lines_removed as number) || 0;
  }

  return {
    conversations: filtered.length,
    messages,
    turns: turnCounts.total,
    totalInputTokens,
    totalOutputTokens,
    totalLinesAdded,
    totalLinesRemoved,
  };
}

export async function getDailyActivity(period: PeriodFilter): Promise<DayActivity[]> {
  await connect();
  
  const [convRows, msgRows] = await Promise.all([
    queryTableWithRetry(getConversationsTable, table => table.query().toArray()),
    queryTableWithRetry(getMessagesTable, table => 
      table.query().select(['conversation_id', 'role', 'timestamp']).toArray()
    ),
  ]);

  const filtered = convRows.filter(r => isInPeriod(r.created_at as string, period));
  const convDateMap = new Map(filtered.map(c => [c.id as string, (c.created_at as string)?.split('T')[0]]));

  const byDate = new Map<string, DayActivity>();

  for (const conv of filtered) {
    const createdAt = conv.created_at as string;
    const date = createdAt?.split('T')[0];
    if (!date) continue;

    const existing = byDate.get(date) || {
      date,
      conversations: 0,
      messages: 0,
      turns: 0,
      tokens: 0,
      linesAdded: 0,
      linesRemoved: 0,
    };

    existing.conversations += 1;
    existing.messages += (conv.message_count as number) || 0;
    existing.tokens += ((conv.total_input_tokens as number) || 0) + ((conv.total_output_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0);
    existing.linesAdded += (conv.total_lines_added as number) || 0;
    existing.linesRemoved += (conv.total_lines_removed as number) || 0;

    byDate.set(date, existing);
  }

  for (const msg of msgRows) {
    if ((msg.role as string) !== 'user') continue;
    const convId = msg.conversation_id as string;
    const date = convDateMap.get(convId);
    if (!date) continue;
    
    const existing = byDate.get(date);
    if (existing) {
      existing.turns += 1;
    }
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export async function getDailyTokensBySource(period: PeriodFilter): Promise<DailyTokensBySource[]> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  // Group by date, tracking tokens per source
  const byDate = new Map<string, DailyTokensBySource>();

  for (const conv of filtered) {
    const createdAt = conv.created_at as string;
    const date = createdAt?.split('T')[0];
    if (!date) continue;

    const source = (conv.source as string) || 'unknown';
    const tokens = ((conv.total_input_tokens as number) || 0) + ((conv.total_output_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0);

    const existing = byDate.get(date) || {
      date,
      cursor: 0,
      claudeCode: 0,
      codex: 0,
      opencode: 0,
      total: 0,
    };

    // Add tokens to the appropriate source
    switch (source) {
      case Source.Cursor:
        existing.cursor += tokens;
        break;
      case Source.ClaudeCode:
        existing.claudeCode += tokens;
        break;
      case Source.Codex:
        existing.codex += tokens;
        break;
      case Source.OpenCode:
        existing.opencode += tokens;
        break;
    }
    existing.total += tokens;

    byDate.set(date, existing);
  }

  // Fill in missing dates within the period to ensure continuous data
  const result: DailyTokensBySource[] = [];
  const current = new Date(period.startDate);
  const end = new Date(period.endDate);

  while (current <= end) {
    const dateStr = formatDate(current);
    const existing = byDate.get(dateStr);
    if (existing) {
      result.push(existing);
    } else {
      // Add empty entry for days with no activity
      result.push({
        date: dateStr,
        cursor: 0,
        claudeCode: 0,
        codex: 0,
        opencode: 0,
        total: 0,
      });
    }
    current.setDate(current.getDate() + 1);
  }

  return result;
}

export async function getStatsBySource(period: PeriodFilter): Promise<SourceStats[]> {
  await connect();
  
  const turnCounts = await getTurnCounts(period);
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  const bySource = new Map<string, SourceStats>();

  for (const conv of filtered) {
    const source = (conv.source as string) || 'unknown';
    const existing = bySource.get(source) || {
      source,
      conversations: 0,
      messages: 0,
      turns: 0,
      tokens: 0,
    };

    existing.conversations += 1;
    existing.messages += (conv.message_count as number) || 0;
    existing.tokens += ((conv.total_input_tokens as number) || 0) + ((conv.total_output_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0);

    bySource.set(source, existing);
  }

  for (const [source, stats] of bySource) {
    stats.turns = turnCounts.bySource.get(source) || 0;
  }

  return Array.from(bySource.values()).sort((a, b) => b.tokens - a.tokens);
}

export async function getStatsByModel(period: PeriodFilter): Promise<ModelStats[]> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  // Group by model+source combination
  const byModelSource = new Map<string, ModelStats>();

  for (const conv of filtered) {
    const model = (conv.model as string) || '(unknown)';
    const source = (conv.source as string) || 'unknown';
    const key = `${model}::${source}`;
    const existing = byModelSource.get(key) || {
      model,
      source,
      conversations: 0,
      inputTokens: 0,
      outputTokens: 0,
    };

    existing.conversations += 1;
    // Include cache tokens in input for total context processed
    existing.inputTokens += ((conv.total_input_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0);
    existing.outputTokens += (conv.total_output_tokens as number) || 0;

    byModelSource.set(key, existing);
  }

  // Sort by total tokens descending
  return Array.from(byModelSource.values()).sort(
    (a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)
  );
}

export async function getTopConversationsByTokens(
  period: PeriodFilter,
  limit: number = 5
): Promise<Conversation[]> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  // Sort by total tokens descending (including cache tokens)
  filtered.sort((a, b) => {
    const aTokens = ((a.total_input_tokens as number) || 0) + ((a.total_output_tokens as number) || 0) +
      ((a.total_cache_creation_tokens as number) || 0) + ((a.total_cache_read_tokens as number) || 0);
    const bTokens = ((b.total_input_tokens as number) || 0) + ((b.total_output_tokens as number) || 0) +
      ((b.total_cache_creation_tokens as number) || 0) + ((b.total_cache_read_tokens as number) || 0);
    return bTokens - aTokens;
  });

  // Map raw rows to Conversation objects with proper camelCase properties
  return filtered.slice(0, limit).map(row => mapRowToConversation(row as Record<string, unknown>));
}

export async function getLinesGeneratedStats(
  period: PeriodFilter,
  limit: number = 5
): Promise<LinesGeneratedStats> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;

  for (const conv of filtered) {
    totalLinesAdded += (conv.total_lines_added as number) || 0;
    totalLinesRemoved += (conv.total_lines_removed as number) || 0;
  }

  // Sort by lines added descending
  const sorted = [...filtered].sort(
    (a, b) => ((b.total_lines_added as number) || 0) - ((a.total_lines_added as number) || 0)
  );

  const topConversationsByLines = sorted.slice(0, limit).map(conv => ({
    id: conv.id as string,
    title: (conv.title as string) || '(untitled)',
    linesAdded: (conv.total_lines_added as number) || 0,
    linesRemoved: (conv.total_lines_removed as number) || 0,
  }));

  return {
    totalLinesAdded,
    totalLinesRemoved,
    netLines: totalLinesAdded - totalLinesRemoved,
    topConversationsByLines,
  };
}

export async function getCacheStats(period: PeriodFilter): Promise<CacheStats> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  // Only include Claude Code and Codex sources (which have cache data)
  const filtered = rows.filter(
    r => isInPeriod(r.created_at as string, period) &&
         (r.source === Source.ClaudeCode || r.source === Source.Codex)
  );

  let totalInput = 0;
  let totalOutput = 0;
  let cacheCreation = 0;
  let cacheRead = 0;

  for (const conv of filtered) {
    totalInput += (conv.total_input_tokens as number) || 0;
    totalOutput += (conv.total_output_tokens as number) || 0;
    cacheCreation += (conv.total_cache_creation_tokens as number) || 0;
    cacheRead += (conv.total_cache_read_tokens as number) || 0;
  }

  // Hit rate = cache_read / (cache_read + cache_creation + regular_input)
  const totalContext = cacheRead + cacheCreation + totalInput;
  const hitRate = totalContext > 0 ? cacheRead / totalContext : 0;

  return {
    totalInput,
    totalOutput,
    cacheCreation,
    cacheRead,
    hitRate,
  };
}

export async function getActivityByHour(period: PeriodFilter): Promise<number[]> {
  await connect();
  const byHour = new Array(24).fill(0);

  const [convRows, hasBilling] = await Promise.all([
    queryTableWithRetry(getConversationsTable, table => table.query().toArray()),
    hasBillingData(),
  ]);

  const convInPeriod = convRows.filter(r => isInPeriod(r.created_at as string, period));
  const convIdSet = new Set(convInPeriod.map(r => r.id as string));
  const convSourceMap = new Map(convInPeriod.map(r => [r.id as string, r.source as string]));
  
  // Track which conversations have been counted via billing/messages
  const countedConvIds = new Set<string>();

  // For Cursor: prefer billing events if available
  if (hasBilling) {
    const allRows = await queryTableWithRetry(getBillingEventsTable, table => table.query().toArray());
    const billingRows = allRows.filter(isValidBillingEvent);
    for (const event of billingRows) {
      const timestamp = event.timestamp as string;
      const convId = event.conversation_id as string;
      if (!timestamp || !isInPeriod(timestamp, period)) continue;
      if (convId && convIdSet.has(convId)) {
        countedConvIds.add(convId);
      }
      const hour = new Date(timestamp).getHours();
      byHour[hour] += 1;
    }
  }

  // For non-Cursor: use message timestamps
  const msgRows = await queryTableWithRetry(getMessagesTable, table => 
    table.query().select(['conversation_id', 'timestamp']).toArray()
  );

  for (const msg of msgRows) {
    const convId = msg.conversation_id as string;
    if (!convIdSet.has(convId)) continue;
    
    const source = convSourceMap.get(convId);
    if (source === Source.Cursor) continue;

    const timestamp = msg.timestamp as string;
    if (!timestamp) continue;
    if (!isInPeriod(timestamp, period)) continue;

    countedConvIds.add(convId);
    const hour = new Date(timestamp).getHours();
    byHour[hour] += 1;
  }

  // Fallback: use conversation.created_at for any conversation not yet counted
  for (const conv of convInPeriod) {
    const convId = conv.id as string;
    if (countedConvIds.has(convId)) continue;
    
    const createdAt = conv.created_at as string;
    if (!createdAt) continue;
    
    const hour = new Date(createdAt).getHours();
    byHour[hour] += 1;
  }

  return byHour;
}

export async function getActivityByDayOfWeek(period: PeriodFilter): Promise<number[]> {
  await connect();
  const byDay = new Array(7).fill(0);

  const [convRows, hasBilling] = await Promise.all([
    queryTableWithRetry(getConversationsTable, table => table.query().toArray()),
    hasBillingData(),
  ]);

  const convInPeriod = convRows.filter(r => isInPeriod(r.created_at as string, period));
  const convIdSet = new Set(convInPeriod.map(r => r.id as string));
  const convSourceMap = new Map(convInPeriod.map(r => [r.id as string, r.source as string]));
  
  // Track which conversations have been counted via billing/messages
  const countedConvIds = new Set<string>();

  // For Cursor: prefer billing events if available
  if (hasBilling) {
    const allRows = await queryTableWithRetry(getBillingEventsTable, table => table.query().toArray());
    const billingRows = allRows.filter(isValidBillingEvent);
    for (const event of billingRows) {
      const timestamp = event.timestamp as string;
      const convId = event.conversation_id as string;
      if (!timestamp || !isInPeriod(timestamp, period)) continue;
      if (convId && convIdSet.has(convId)) {
        countedConvIds.add(convId);
      }
      const day = new Date(timestamp).getDay();
      byDay[day] += 1;
    }
  }

  // For non-Cursor: use message timestamps
  const msgRows = await queryTableWithRetry(getMessagesTable, table => 
    table.query().select(['conversation_id', 'timestamp']).toArray()
  );

  for (const msg of msgRows) {
    const convId = msg.conversation_id as string;
    if (!convIdSet.has(convId)) continue;
    
    const source = convSourceMap.get(convId);
    if (source === Source.Cursor) continue;

    const timestamp = msg.timestamp as string;
    if (!timestamp) continue;
    if (!isInPeriod(timestamp, period)) continue;

    countedConvIds.add(convId);
    const day = new Date(timestamp).getDay();
    byDay[day] += 1;
  }

  // Fallback: use conversation.created_at for any conversation not yet counted
  for (const conv of convInPeriod) {
    const convId = conv.id as string;
    if (countedConvIds.has(convId)) continue;
    
    const createdAt = conv.created_at as string;
    if (!createdAt) continue;
    
    const day = new Date(createdAt).getDay();
    byDay[day] += 1;
  }

  return byDay;
}

export async function getStreakInfo(): Promise<StreakInfo> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  // Get all unique dates with activity
  const datesSet = new Set<string>();
  for (const conv of rows) {
    const createdAt = conv.created_at as string;
    if (createdAt) {
      datesSet.add(createdAt.split('T')[0]!);
    }
  }

  const dates = Array.from(datesSet).sort();

  if (dates.length === 0) {
    return { current: 0, longest: 0, longestStart: '', longestEnd: '' };
  }

  // Calculate streaks
  let currentStreak = 0;
  let longestStreak = 0;
  let longestStart = '';
  let longestEnd = '';
  let streakStart = dates[0]!;
  let streakLength = 1;

  // Check if today or yesterday has activity for current streak
  const today = formatDate(new Date());
  const yesterday = formatDate(new Date(Date.now() - 86400000));
  const hasToday = datesSet.has(today);
  const hasYesterday = datesSet.has(yesterday);

  for (let i = 1; i < dates.length; i++) {
    const prevDate = new Date(dates[i - 1]!);
    const currDate = new Date(dates[i]!);
    const diffDays = Math.round((currDate.getTime() - prevDate.getTime()) / 86400000);

    if (diffDays === 1) {
      // Consecutive day
      streakLength++;
    } else {
      // Gap in streak
      if (streakLength > longestStreak) {
        longestStreak = streakLength;
        longestStart = streakStart;
        longestEnd = dates[i - 1]!;
      }
      streakStart = dates[i]!;
      streakLength = 1;
    }
  }

  // Check final streak
  if (streakLength > longestStreak) {
    longestStreak = streakLength;
    longestStart = streakStart;
    longestEnd = dates[dates.length - 1]!;
  }

  // Calculate current streak (from today backwards)
  if (hasToday || hasYesterday) {
    const checkDate = hasToday ? today : yesterday;
    currentStreak = 1;
    let checkDateObj = new Date(checkDate);

    while (true) {
      checkDateObj.setDate(checkDateObj.getDate() - 1);
      const prevDateStr = formatDate(checkDateObj);
      if (datesSet.has(prevDateStr)) {
        currentStreak++;
      } else {
        break;
      }
    }
  }

  return {
    current: currentStreak,
    longest: longestStreak,
    longestStart,
    longestEnd,
  };
}

// --- Project Analytics ---

function extractProjectName(workspacePath: string | undefined): string {
  if (!workspacePath) return '(no project)';
  // Extract the last segment of the path as the project name
  const segments = workspacePath.split('/').filter(s => s.length > 0);
  return segments[segments.length - 1] || '(no project)';
}

/** Project names that indicate we should try to infer from file edits */
const UNHELPFUL_PROJECT_NAMES = ['(cursor)', '(no project)', '(codex)', '(claude-code)'];

/**
 * Determine the best project name for a conversation.
 * Tries: project_name -> workspace_path -> file edits -> fallback
 */
function resolveProjectName(
  conv: { project_name?: string; workspace_path?: string; id: string },
  editsByConvId: Map<string, Array<{ file_path: string }>>
): string {
  // If conversation has a useful project name, use it
  if (conv.project_name && !UNHELPFUL_PROJECT_NAMES.includes(conv.project_name)) {
    return conv.project_name;
  }

  // Try extracting from workspace path
  if (conv.workspace_path) {
    const extracted = extractProjectName(conv.workspace_path);
    if (!UNHELPFUL_PROJECT_NAMES.includes(extracted)) {
      return extracted;
    }
  }

  // Try to infer from file edits
  const edits = editsByConvId.get(conv.id as string);
  if (edits && edits.length > 0) {
    // Try to extract project from the first file path
    for (const edit of edits) {
      const extracted = extractProjectFromPath(edit.file_path);
      if (extracted) {
        return extracted.projectName;
      }
    }
  }

  // Fallback to unhelpful name or generic
  return conv.project_name || '(no project)';
}

export async function getProjectStats(period: PeriodFilter): Promise<ProjectStats[]> {
  await connect();
  
  const [rows, allEdits, turnCounts] = await Promise.all([
    queryTableWithRetry(getConversationsTable, table => table.query().toArray()),
    queryTableWithRetry(getFileEditsTable, table => table.query().toArray()),
    getTurnCounts(period),
  ]);

  const editsByConvId = new Map<string, Array<{ file_path: string }>>();
  for (const edit of allEdits) {
    const existing = editsByConvId.get(edit.conversation_id as string) || [];
    existing.push({ file_path: edit.file_path as string });
    editsByConvId.set(edit.conversation_id as string, existing);
  }

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  const convToProject = new Map<string, string>();
  const byProject = new Map<string, ProjectStats>();

  for (const conv of filtered) {
    const projectName = resolveProjectName(conv as any, editsByConvId);
    convToProject.set(conv.id as string, projectName);
    
    const existing = byProject.get(projectName) || {
      projectName,
      workspacePath: (conv.workspace_path as string) || '',
      conversations: 0,
      messages: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      linesAdded: 0,
      linesRemoved: 0,
      lastActivity: '',
    };

    existing.conversations += 1;
    existing.messages += (conv.message_count as number) || 0;
    existing.inputTokens += ((conv.total_input_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0);
    existing.outputTokens += (conv.total_output_tokens as number) || 0;
    existing.linesAdded += (conv.total_lines_added as number) || 0;
    existing.linesRemoved += (conv.total_lines_removed as number) || 0;

    const createdAt = conv.created_at as string;
    if (createdAt && (!existing.lastActivity || createdAt > existing.lastActivity)) {
      existing.lastActivity = createdAt;
      existing.workspacePath = (conv.workspace_path as string) || existing.workspacePath;
    }

    byProject.set(projectName, existing);
  }

  for (const [convId, turns] of turnCounts.byConversation) {
    const projectName = convToProject.get(convId);
    if (projectName) {
      const stats = byProject.get(projectName);
      if (stats) {
        stats.turns += turns;
      }
    }
  }

  return Array.from(byProject.values()).sort(
    (a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)
  );
}

export async function getConversationsByProject(
  projectName: string,
  period: PeriodFilter
): Promise<Conversation[]> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  // Load file edits for project inference
  const allEdits = await queryTableWithRetry(getFileEditsTable, table => table.query().toArray());

  // Group edits by conversation ID
  const editsByConvId = new Map<string, Array<{ file_path: string }>>();
  for (const edit of allEdits) {
    const existing = editsByConvId.get(edit.conversation_id as string) || [];
    existing.push({ file_path: edit.file_path as string });
    editsByConvId.set(edit.conversation_id as string, existing);
  }

  const filtered = rows.filter(r => {
    if (!isInPeriod(r.created_at as string, period)) return false;
    const convProjectName = resolveProjectName(r as any, editsByConvId);
    return convProjectName === projectName;
  });

  // Sort by created_at descending
  filtered.sort((a, b) => {
    const aDate = (a.created_at as string) || '';
    const bDate = (b.created_at as string) || '';
    return bDate.localeCompare(aDate);
  });

  // Map raw rows to Conversation objects with proper camelCase properties
  return filtered.map(row => mapRowToConversation(row as Record<string, unknown>));
}

// --- File Analytics ---

/**
 * Extract relative path from a full file path given a workspace root.
 * Falls back to the full path if workspace doesn't match.
 */
function getRelativePath(filePath: string, workspacePath?: string): string {
  if (!workspacePath) return filePath;
  if (filePath.startsWith(workspacePath)) {
    const relative = filePath.slice(workspacePath.length);
    // Remove leading slash if present
    return relative.startsWith('/') ? relative.slice(1) : relative;
  }
  return filePath;
}

/**
 * Extract project name from an absolute file path.
 * Looks for common project directory patterns like:
 * - /Users/.../Documents/GitHub/PROJECT/...
 * - /Users/.../projects/PROJECT/...
 * - /home/user/PROJECT/...
 * - /Users/.../.cursor/worktrees/PROJECT/ID/...
 */
function extractProjectFromPath(filePath: string): { projectName: string; relativePath: string } | null {
  const parts = filePath.split('/');

  // Special case: .cursor/worktrees/PROJECT/ID/...
  // Pattern: /.cursor/worktrees/{project}/{hash}/...
  const cursorIdx = parts.findIndex(p => p === '.cursor');
  const cursorProjectName = parts[cursorIdx + 2];
  if (cursorIdx >= 0 && parts[cursorIdx + 1] === 'worktrees' && cursorProjectName) {
    // Skip the hash directory (cursorIdx + 3) and take rest as relative path
    const relativePath = parts.slice(cursorIdx + 4).join('/');
    return { projectName: cursorProjectName, relativePath };
  }

  // Look for common project root indicators
  const projectRootIndicators = ['GitHub', 'projects', 'repos', 'code', 'dev', 'workspace'];

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part && projectRootIndicators.includes(part)) {
      const projectName = parts[i + 1];
      if (projectName && projectName.length > 0) {
        return {
          projectName,
          relativePath: parts.slice(i + 2).join('/'),
        };
      }
    }
  }

  // Look for common source directories (src, lib, etc.) and use parent as project
  // But skip if parent is a hidden dir, user home, or project root indicator
  const srcIndicators = ['src', 'lib', 'app', 'pages', 'components', 'packages'];
  const srcIdx = parts.findIndex(p => srcIndicators.includes(p));
  if (srcIdx > 1) {
    const projectName = parts[srcIdx - 1];
    const skipAsProject = [...projectRootIndicators, 'Users', 'home'];
    if (projectName && projectName.length > 0 &&
        !projectName.startsWith('.') &&
        !skipAsProject.includes(projectName)) {
      return {
        projectName,
        relativePath: parts.slice(srcIdx).join('/'),
      };
    }
  }

  // For paths like /home/user/project/..., try the third segment after root
  // Skip: /, home, user -> take next as project
  if (parts.length > 4 && parts[1] === 'home') {
    const projectName = parts[3]; // /home/user/PROJECT/...
    if (projectName && projectName.length > 0 && !projectName.startsWith('.')) {
      return {
        projectName,
        relativePath: parts.slice(4).join('/'),
      };
    }
  }

  // For /Users/name/..., skip common directories and hidden dirs
  if (parts.length > 4 && parts[1] === 'Users') {
    const skipDirs = ['Documents', 'Desktop', 'Downloads', 'Library', 'Applications'];
    let startIdx = 3; // After /Users/name/

    // Skip Documents and similar if present
    while (startIdx < parts.length && skipDirs.includes(parts[startIdx] || '')) {
      startIdx++;
    }

    // Skip hidden directories (like .cursor, .vscode)
    while (startIdx < parts.length && (parts[startIdx] || '').startsWith('.')) {
      startIdx++;
    }

    if (startIdx < parts.length) {
      const projectName = parts[startIdx];
      if (projectName && projectName.length > 0 && !projectName.startsWith('.')) {
        return {
          projectName,
          relativePath: parts.slice(startIdx + 1).join('/'),
        };
      }
    }
  }

  return null;
}

/**
 * Extract project name from a file path by finding the best matching workspace.
 */
function findProjectForFile(filePath: string, workspaceMap: Map<string, string>): { projectName: string; relativePath: string } {
  // Try to find a workspace that contains this file
  let bestMatch = '';
  let bestProject = '';

  for (const [workspace, project] of workspaceMap) {
    if (filePath.startsWith(workspace) && workspace.length > bestMatch.length) {
      bestMatch = workspace;
      bestProject = project;
    }
  }

  if (bestMatch) {
    return {
      projectName: bestProject,
      relativePath: getRelativePath(filePath, bestMatch),
    };
  }

  // Fall back to extracting project from the file path itself
  const extracted = extractProjectFromPath(filePath);
  if (extracted) {
    return extracted;
  }

  // Last resort: use last 3 segments
  const parts = filePath.split('/');
  return {
    projectName: '(unknown)',
    relativePath: parts.slice(-3).join('/'),
  };
}

export async function getCombinedFileStats(
  period: PeriodFilter,
  limit: number = 10
): Promise<FileStats[]> {
  await connect();

  // Get conversations in period to filter files
  const convRows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());
  const convsInPeriod = convRows.filter(r => isInPeriod(r.created_at as string, period));
  const convInPeriodSet = new Set(convsInPeriod.map(r => r.id as string));

  // Build workspace -> project mapping from conversations
  const workspaceMap = new Map<string, string>();
  for (const conv of convsInPeriod) {
    const workspacePath = conv.workspace_path as string;
    if (workspacePath) {
      const projectName = (conv.project_name as string) || extractProjectName(workspacePath);
      workspaceMap.set(workspacePath, projectName);
    }
  }

  // Aggregate file edits
  const editsRows = await queryTableWithRetry(getFileEditsTable, table => table.query().toArray());
  const editsByFile = new Map<string, { editCount: number; linesAdded: number; linesRemoved: number; conversations: Set<string> }>();

  for (const edit of editsRows) {
    const conversationId = edit.conversation_id as string;
    if (!convInPeriodSet.has(conversationId)) continue;

    const filePath = edit.file_path as string;
    const existing = editsByFile.get(filePath) || {
      editCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      conversations: new Set<string>(),
    };

    existing.editCount += 1;
    existing.linesAdded += (edit.lines_added as number) || 0;
    existing.linesRemoved += (edit.lines_removed as number) || 0;
    existing.conversations.add(conversationId);

    editsByFile.set(filePath, existing);
  }

  // Aggregate file mentions (from conversation_files)
  const filesRows = await queryTableWithRetry(getFilesTable, table => table.query().toArray());
  const mentionsByFile = new Map<string, { mentionCount: number; conversations: Set<string> }>();

  for (const file of filesRows) {
    const conversationId = file.conversation_id as string;
    if (!convInPeriodSet.has(conversationId)) continue;

    const filePath = file.file_path as string;
    const existing = mentionsByFile.get(filePath) || {
      mentionCount: 0,
      conversations: new Set<string>(),
    };

    existing.mentionCount += 1;
    existing.conversations.add(conversationId);

    mentionsByFile.set(filePath, existing);
  }

  // Combine into FileStats
  const allFiles = new Set([...editsByFile.keys(), ...mentionsByFile.keys()]);
  const combined: FileStats[] = [];

  for (const filePath of allFiles) {
    const edits = editsByFile.get(filePath);
    const mentions = mentionsByFile.get(filePath);
    const allConversations = new Set([
      ...(edits?.conversations || []),
      ...(mentions?.conversations || []),
    ]);

    // Get project and relative path
    const { projectName, relativePath } = findProjectForFile(filePath, workspaceMap);

    combined.push({
      filePath,
      relativePath,
      projectName,
      editCount: edits?.editCount || 0,
      mentionCount: mentions?.mentionCount || 0,
      linesAdded: edits?.linesAdded || 0,
      linesRemoved: edits?.linesRemoved || 0,
      conversationCount: allConversations.size,
    });
  }

  // Sort by total activity (edits + mentions) descending
  combined.sort((a, b) => (b.editCount + b.mentionCount) - (a.editCount + a.mentionCount));

  return combined.slice(0, limit);
}

export async function getEditTypeBreakdown(period: PeriodFilter): Promise<EditTypeBreakdown> {
  await connect();

  // Get conversations in period
  const convRows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());
  const convInPeriod = new Set(
    convRows
      .filter(r => isInPeriod(r.created_at as string, period))
      .map(r => r.id as string)
  );

  const editsRows = await queryTableWithRetry(getFileEditsTable, table => table.query().toArray());

  let create = 0;
  let modify = 0;
  let deleteCount = 0;

  for (const edit of editsRows) {
    if (!convInPeriod.has(edit.conversation_id as string)) continue;

    const editType = edit.edit_type as string;
    if (editType === 'create') create++;
    else if (editType === 'modify') modify++;
    else if (editType === 'delete') deleteCount++;
  }

  return { create, modify, delete: deleteCount };
}

export async function getFileTypeStats(
  period: PeriodFilter,
  limit: number = 5
): Promise<FileTypeStats[]> {
  await connect();

  // Get conversations in period
  const convRows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());
  const convInPeriod = new Set(
    convRows
      .filter(r => isInPeriod(r.created_at as string, period))
      .map(r => r.id as string)
  );

  const editsRows = await queryTableWithRetry(getFileEditsTable, table => table.query().toArray());
  const byExtension = new Map<string, FileTypeStats>();

  for (const edit of editsRows) {
    if (!convInPeriod.has(edit.conversation_id as string)) continue;

    // Extract file extension
    const filePath = edit.file_path as string;
    const parts = filePath.split('.');
    let extension = parts.length > 1 ? `.${parts[parts.length - 1]}` : '(no ext)';

    // Group .ts and .tsx together
    if (extension === '.ts' || extension === '.tsx') {
      extension = '.ts/.tsx';
    }

    const existing = byExtension.get(extension) || {
      extension,
      editCount: 0,
      linesAdded: 0,
    };

    existing.editCount += 1;
    existing.linesAdded += (edit.lines_added as number) || 0;

    byExtension.set(extension, existing);
  }

  // Sort by edit count descending
  return Array.from(byExtension.values())
    .sort((a, b) => b.editCount - a.editCount)
    .slice(0, limit);
}

// --- Billing Analytics (Cursor) ---

export interface BillingOverview {
  totalEvents: number;
  totalTokens: number;
  eventsWithTokens: number;
  eventsWithoutTokens: number;
  attributedEvents: number;
  unattributedEvents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalCost: number;
}

export interface BillingModelStats {
  model: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

export interface DailyBillingTokens {
  date: string;
  tokens: number;
  events: number;
  cost: number;
}

export interface BillingConversation {
  conversationId: string;
  title: string;
  tokens: number;
  events: number;
  cost: number;
}

/**
 * Check if billing data exists in the database.
 */
export async function hasBillingData(): Promise<boolean> {
  await connect();
  try {
    const table = await getBillingEventsTable();
    const count = await table.countRows();
    return count > 0;
  } catch {
    return false;
  }
}

export async function getBillingOverview(period: PeriodFilter): Promise<BillingOverview> {
  await connect();
  const table = await getBillingEventsTable();
  const allRows = await table.query().toArray();
  const rows = allRows.filter(isValidBillingEvent);

  let totalTokens = 0;
  let eventsWithTokens = 0;
  let eventsWithoutTokens = 0;
  let attributedEvents = 0;
  let unattributedEvents = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let totalCost = 0;
  let totalEvents = 0;

  for (const row of rows) {
    const timestamp = row.timestamp as string;
    if (!isInPeriod(timestamp, period)) continue;

    totalEvents++;
    const tokens = (row.total_tokens as number) || 0;
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

    inputTokens += (row.input_tokens as number) || 0;
    outputTokens += (row.output_tokens as number) || 0;
    cacheReadTokens += (row.cache_read_tokens as number) || 0;
    totalCost += (row.cost as number) || 0;
  }

  return {
    totalEvents,
    totalTokens,
    eventsWithTokens,
    eventsWithoutTokens,
    attributedEvents,
    unattributedEvents,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalCost,
  };
}

export async function getBillingByModel(period: PeriodFilter): Promise<BillingModelStats[]> {
  await connect();
  const table = await getBillingEventsTable();
  const allRows = await table.query().toArray();
  const rows = allRows.filter(isValidBillingEvent);

  const byModel = new Map<string, BillingModelStats>();

  for (const row of rows) {
    const timestamp = row.timestamp as string;
    if (!isInPeriod(timestamp, period)) continue;

    const model = (row.model as string) || '(unknown)';
    const existing = byModel.get(model) || {
      model,
      events: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
    };

    existing.events++;
    existing.inputTokens += (row.input_tokens as number) || 0;
    existing.outputTokens += (row.output_tokens as number) || 0;
    existing.totalTokens += (row.total_tokens as number) || 0;
    existing.cost += (row.cost as number) || 0;

    byModel.set(model, existing);
  }

  // Sort by total tokens descending
  return Array.from(byModel.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

export async function getDailyBillingTokens(period: PeriodFilter): Promise<DailyBillingTokens[]> {
  await connect();
  const table = await getBillingEventsTable();
  const allRows = await table.query().toArray();
  const rows = allRows.filter(isValidBillingEvent);

  const byDate = new Map<string, DailyBillingTokens>();

  for (const row of rows) {
    const timestamp = row.timestamp as string;
    if (!isInPeriod(timestamp, period)) continue;

    const date = timestamp.split('T')[0];
    if (!date) continue;

    const existing = byDate.get(date) || {
      date,
      tokens: 0,
      events: 0,
      cost: 0,
    };

    existing.tokens += (row.total_tokens as number) || 0;
    existing.events++;
    existing.cost += (row.cost as number) || 0;

    byDate.set(date, existing);
  }

  // Fill in missing dates and sort
  const result: DailyBillingTokens[] = [];
  const current = new Date(period.startDate);
  const end = new Date(period.endDate);

  while (current <= end) {
    const dateStr = formatDate(current);
    const existing = byDate.get(dateStr);
    if (existing) {
      result.push(existing);
    } else {
      result.push({ date: dateStr, tokens: 0, events: 0, cost: 0 });
    }
    current.setDate(current.getDate() + 1);
  }

  return result;
}

/**
 * Get top conversations by billed tokens.
 */
export async function getBillingTopConversations(
  period: PeriodFilter,
  limit: number = 5
): Promise<BillingConversation[]> {
  await connect();
  const billingTable = await getBillingEventsTable();
  const allRows = await billingTable.query().toArray();
  const billingRows = allRows.filter(isValidBillingEvent);

  // Aggregate by conversation
  const byConv = new Map<string, { tokens: number; events: number; cost: number }>();

  for (const row of billingRows) {
    const timestamp = row.timestamp as string;
    if (!isInPeriod(timestamp, period)) continue;

    const convId = row.conversation_id as string;
    if (!convId || convId.length === 0) continue;

    const existing = byConv.get(convId) || { tokens: 0, events: 0, cost: 0 };
    existing.tokens += (row.total_tokens as number) || 0;
    existing.events++;
    existing.cost += (row.cost as number) || 0;
    byConv.set(convId, existing);
  }

  // Sort by tokens and take top N
  const sorted = Array.from(byConv.entries())
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, limit);

  // Get conversation titles
  const convTable = await getConversationsTable();
  const convRows = await convTable.query().toArray();
  const titleMap = new Map<string, string>();
  for (const row of convRows) {
    titleMap.set(row.id as string, (row.title as string) || '(untitled)');
  }

  return sorted.map(([convId, data]) => ({
    conversationId: convId,
    title: titleMap.get(convId) || '(unknown)',
    tokens: data.tokens,
    events: data.events,
    cost: data.cost,
  }));
}

// --- Summary Functions ---

export interface SummaryStats {
  conversations: number;
  messages: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  linesAdded: number;
  linesRemoved: number;
  currentStreak: number;
}

export async function getSummaryStats(days: number): Promise<SummaryStats> {
  const period = createPeriodFilter(days);
  const [overview, streak] = await Promise.all([
    getOverviewStats(period),
    getStreakInfo(),
  ]);

  return {
    conversations: overview.conversations,
    messages: overview.messages,
    turns: overview.turns,
    inputTokens: overview.totalInputTokens,
    outputTokens: overview.totalOutputTokens,
    linesAdded: overview.totalLinesAdded,
    linesRemoved: overview.totalLinesRemoved,
    currentStreak: streak.current,
  };
}

export interface RecentConversation {
  id: string;
  title: string;
  source: string;
  createdAt: string;
  totalTokens: number;
}

export async function getRecentConversations(
  period: PeriodFilter,
  limit: number = 5
): Promise<RecentConversation[]> {
  await connect();
  const rows = await queryTableWithRetry(getConversationsTable, table => table.query().toArray());

  const filtered = rows.filter(r => isInPeriod(r.created_at as string, period));

  // Sort by created_at descending (most recent first)
  filtered.sort((a, b) => {
    const aDate = (a.created_at as string) || '';
    const bDate = (b.created_at as string) || '';
    return bDate.localeCompare(aDate);
  });

  return filtered.slice(0, limit).map(conv => ({
    id: conv.id as string,
    title: (conv.title as string) || '(untitled)',
    source: (conv.source as string) || 'unknown',
    createdAt: (conv.created_at as string) || '',
    totalTokens: ((conv.total_input_tokens as number) || 0) + ((conv.total_output_tokens as number) || 0) +
      ((conv.total_cache_creation_tokens as number) || 0) + ((conv.total_cache_read_tokens as number) || 0),
  }));
}

export interface UnifiedModelStats {
  model: string;
  source: string;
  conversations: number;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
  hasBillingData: boolean;
}

export async function getUnifiedModelStats(period: PeriodFilter): Promise<UnifiedModelStats[]> {
  const [conversationStats, billingStats, hasBilling] = await Promise.all([
    getStatsByModel(period),
    getBillingByModel(period),
    hasBillingData(),
  ]);

  if (!hasBilling || billingStats.length === 0) {
    return conversationStats.map(s => ({
      model: s.model,
      source: s.source,
      conversations: s.conversations,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      hasBillingData: false,
    }));
  }

  const result: UnifiedModelStats[] = [];

  const cursorConvCount = conversationStats
    .filter(s => s.source === 'cursor')
    .reduce((sum, s) => sum + s.conversations, 0);

  for (const billing of billingStats) {
    result.push({
      model: billing.model,
      source: 'cursor',
      conversations: cursorConvCount,
      inputTokens: billing.inputTokens,
      outputTokens: billing.outputTokens,
      cost: billing.cost,
      hasBillingData: true,
    });
  }

  for (const convStat of conversationStats) {
    if (convStat.source !== 'cursor') {
      result.push({
        model: convStat.model,
        source: convStat.source,
        conversations: convStat.conversations,
        inputTokens: convStat.inputTokens,
        outputTokens: convStat.outputTokens,
        hasBillingData: false,
      });
    }
  }

  return result.sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
}
