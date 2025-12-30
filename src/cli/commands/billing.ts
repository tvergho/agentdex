import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';
import { createHash } from 'crypto';
import { connect } from '../../db/index';
import { conversationRepo, billingEventsRepo } from '../../db/repository';
import type { BillingEvent } from '../../schema/index';
import { getCursorCredentialStatus } from '../../providers/cursor/credentials';
import { fetchBillingData, getDefaultDateRange, type BillingRow } from '../../providers/cursor/client';

interface BillingOptions {
  dryRun?: boolean;
}

interface BillingSyncOptions {
  dryRun?: boolean;
  days?: string;
}

interface CsvRow {
  date: Date;
  user: string;
  kind: string;
  model: string;
  maxMode: string;
  inputWithCache: number | null;
  inputWithoutCache: number | null;
  cacheRead: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
}

interface ConversationWindow {
  id: string;
  title: string;
  updatedAt: Date;
  windowStart: Date;
  windowEnd: Date;
}

function parseCsv(path: string): CsvRow[] {
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current);

    if (fields.length < 11) continue;

    const parseNum = (s: string): number | null => {
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    };

    const dateStr = fields[0]!.trim();
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) continue;

    rows.push({
      date,
      user: fields[1]!,
      kind: fields[2]!,
      model: fields[3]!,
      maxMode: fields[4]!,
      inputWithCache: parseNum(fields[5]!),
      inputWithoutCache: parseNum(fields[6]!),
      cacheRead: parseNum(fields[7]!),
      outputTokens: parseNum(fields[8]!),
      totalTokens: parseNum(fields[9]!),
      cost: parseNum(fields[10]!),
    });
  }

  return rows;
}

function buildConversationWindows(
  conversations: Array<{ id: string; title: string; updatedAt?: string }>
): ConversationWindow[] {
  const withTimestamps = conversations
    .filter(c => c.updatedAt)
    .map(c => ({
      id: c.id,
      title: c.title,
      updatedAt: new Date(c.updatedAt!),
    }))
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());

  if (withTimestamps.length === 0) return [];

  const windows: ConversationWindow[] = [];

  for (let i = 0; i < withTimestamps.length; i++) {
    const conv = withTimestamps[i]!;

    let windowStart: Date;
    if (i === 0) {
      windowStart = new Date(0);
    } else {
      const prev = withTimestamps[i - 1]!;
      const midpoint = (prev.updatedAt.getTime() + conv.updatedAt.getTime()) / 2;
      windowStart = new Date(midpoint);
    }

    let windowEnd: Date;
    if (i === withTimestamps.length - 1) {
      windowEnd = new Date('2100-01-01');
    } else {
      const next = withTimestamps[i + 1]!;
      const midpoint = (conv.updatedAt.getTime() + next.updatedAt.getTime()) / 2;
      windowEnd = new Date(midpoint);
    }

    windows.push({
      id: conv.id,
      title: conv.title,
      updatedAt: conv.updatedAt,
      windowStart,
      windowEnd,
    });
  }

  return windows;
}

function findConversationForTimestamp(
  timestamp: Date,
  windows: ConversationWindow[]
): ConversationWindow | null {
  let left = 0;
  let right = windows.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const window = windows[mid]!;

    if (timestamp >= window.windowStart && timestamp < window.windowEnd) {
      return window;
    } else if (timestamp < window.windowStart) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return null;
}

function generateEventId(row: CsvRow, csvSource: string): string {
  const data = `${row.date.toISOString()}|${row.model}|${row.kind}|${row.totalTokens}|${csvSource}`;
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

export async function billingImportCommand(csvPath: string, options: BillingOptions): Promise<void> {
  if (!existsSync(csvPath)) {
    console.error(`File not found: ${csvPath}`);
    process.exit(1);
  }

  const csvSource = basename(csvPath);

  console.log('=== Billing Data Import ===\n');

  console.log('Step 1: Parsing CSV...');
  const rows = parseCsv(csvPath);
  console.log(`  Total rows: ${rows.length.toLocaleString()}`);

  const withTokens = rows.filter(r => r.totalTokens !== null && r.totalTokens > 0);
  const withoutTokens = rows.filter(r => r.totalTokens === null || r.totalTokens === 0);
  console.log(`  Rows with token data: ${withTokens.length.toLocaleString()}`);
  console.log(`  Rows without token data: ${withoutTokens.length.toLocaleString()}`);

  if (rows.length === 0) {
    console.log('\nNo valid rows found in CSV.');
    return;
  }

  await connect();

  console.log('\nStep 2: Loading Cursor conversations...');
  const { conversations } = await conversationRepo.list({ source: 'cursor', limit: 100000 });
  console.log(`  Total Cursor conversations: ${conversations.length.toLocaleString()}`);

  console.log('\nStep 3: Building conversation windows...');
  const windows = buildConversationWindows(conversations);
  console.log(`  Windows created: ${windows.length.toLocaleString()}`);

  console.log('\nStep 4: Attributing events to conversations...');
  const events: BillingEvent[] = [];
  let unattributedCount = 0;
  let unattributedTokens = 0;
  let attributedTokens = 0;
  const conversationTokens = new Map<string, number>();

  for (const row of rows) {
    const window = findConversationForTimestamp(row.date, windows);
    const eventId = generateEventId(row, csvSource);

    const event: BillingEvent = {
      id: eventId,
      conversationId: window?.id,
      timestamp: row.date.toISOString(),
      model: row.model,
      kind: row.kind,
      inputTokens: row.inputWithCache ?? row.inputWithoutCache ?? undefined,
      outputTokens: row.outputTokens ?? undefined,
      cacheReadTokens: row.cacheRead ?? undefined,
      totalTokens: row.totalTokens ?? undefined,
      cost: row.cost ?? undefined,
      csvSource,
    };

    events.push(event);

    const tokens = row.totalTokens ?? 0;
    if (window) {
      attributedTokens += tokens;
      conversationTokens.set(window.id, (conversationTokens.get(window.id) ?? 0) + tokens);
    } else {
      unattributedCount++;
      unattributedTokens += tokens;
    }
  }

  const attributedConversations = conversationTokens.size;
  console.log(`  Attributed to ${attributedConversations.toLocaleString()} conversations`);
  console.log(`  Unattributed events: ${unattributedCount.toLocaleString()}`);

  if (options.dryRun) {
    console.log('\n[DRY RUN] Would import:');
    console.log(`  Events: ${events.length.toLocaleString()}`);
    console.log(`  Tokens with data: ${(attributedTokens + unattributedTokens).toLocaleString()}`);
    console.log(`  Attributed tokens: ${attributedTokens.toLocaleString()}`);
    console.log(`  Unattributed tokens: ${unattributedTokens.toLocaleString()}`);
    return;
  }

  console.log('\nStep 5: Storing billing events...');
  const existingCount = await billingEventsRepo.countBySource(csvSource);
  if (existingCount > 0) {
    console.log(`  Removing ${existingCount.toLocaleString()} existing events from ${csvSource}...`);
    await billingEventsRepo.deleteBySource(csvSource);
  }

  const BATCH_SIZE = 1000;
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    await billingEventsRepo.bulkInsert(batch);
    if ((i + BATCH_SIZE) % 5000 === 0 || i + BATCH_SIZE >= events.length) {
      console.log(`  Inserted ${Math.min(i + BATCH_SIZE, events.length).toLocaleString()}/${events.length.toLocaleString()} events...`);
    }
  }

  console.log('\n=== Import Complete ===\n');
  console.log('Summary:');
  console.log(`  CSV file: ${csvSource}`);
  console.log(`  Total events: ${events.length.toLocaleString()}`);
  console.log(`  Events with token data: ${withTokens.length.toLocaleString()}`);
  console.log(`  Events without token data: ${withoutTokens.length.toLocaleString()}`);
  console.log(`  Attributed conversations: ${attributedConversations.toLocaleString()}`);
  console.log(`  Attributed tokens: ${attributedTokens.toLocaleString()}`);
  console.log(`  Unattributed events: ${unattributedCount.toLocaleString()}`);
  console.log(`  Unattributed tokens: ${unattributedTokens.toLocaleString()}`);

  const topConversations = [...conversationTokens.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (topConversations.length > 0) {
    console.log('\nTop 5 conversations by tokens:');
    for (const [convId, tokens] of topConversations) {
      const conv = conversations.find(c => c.id === convId);
      const title = conv?.title?.slice(0, 50) ?? 'Unknown';
      console.log(`  ${tokens.toLocaleString().padStart(12)} - ${title}`);
    }
  }
}

export async function billingStatsCommand(): Promise<void> {
  await connect();

  const totals = await billingEventsRepo.getTotals();

  if (totals.totalEvents === 0) {
    console.log('No billing events found. Sync billing data with:');
    console.log('  dex billing sync');
    return;
  }

  console.log('=== Billing Data Statistics ===\n');
  console.log(`Total events: ${totals.totalEvents.toLocaleString()}`);
  console.log(`Total tokens: ${totals.totalTokens.toLocaleString()}`);
  console.log(`Events with tokens: ${totals.eventsWithTokens.toLocaleString()}`);
  console.log(`Events without tokens: ${totals.eventsWithoutTokens.toLocaleString()}`);
  console.log(`Attributed events: ${totals.attributedEvents.toLocaleString()}`);
  console.log(`Unattributed events: ${totals.unattributedEvents.toLocaleString()}`);
}

function billingRowToCsvRow(row: BillingRow): CsvRow {
  return {
    date: row.date,
    user: row.user,
    kind: row.kind,
    model: row.model,
    maxMode: row.maxMode,
    inputWithCache: row.inputWithCache,
    inputWithoutCache: row.inputWithoutCache,
    cacheRead: row.cacheRead,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    cost: row.cost,
  };
}

export async function billingSyncCommand(options: BillingSyncOptions): Promise<void> {
  console.log('=== Cursor Billing Sync ===\n');

  const credStatus = getCursorCredentialStatus();
  if (!credStatus.isAuthenticated) {
    console.error(`Authentication required: ${credStatus.error}`);
    console.error('\nPlease log in to Cursor first, then try again.');
    process.exit(1);
  }

  console.log('Step 1: Fetching billing data from Cursor...');

  const days = options.days ? parseInt(options.days, 10) : 365;
  const endDate = new Date();
  endDate.setHours(23, 59, 59, 999);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);

  console.log(`  Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

  const result = await fetchBillingData(startDate, endDate);

  if (!result.success || !result.rows) {
    console.error(`\nFailed to fetch billing data: ${result.error}`);
    process.exit(1);
  }

  const rows = result.rows.map(billingRowToCsvRow);
  console.log(`  Total events: ${rows.length.toLocaleString()}`);

  const withTokens = rows.filter(r => r.totalTokens !== null && r.totalTokens > 0);
  const withoutTokens = rows.filter(r => r.totalTokens === null || r.totalTokens === 0);
  console.log(`  Events with token data: ${withTokens.length.toLocaleString()}`);
  console.log(`  Events without token data: ${withoutTokens.length.toLocaleString()}`);

  if (rows.length === 0) {
    console.log('\nNo billing events found in the specified date range.');
    return;
  }

  await connect();

  console.log('\nStep 2: Loading Cursor conversations...');
  const { conversations } = await conversationRepo.list({ source: 'cursor', limit: 100000 });
  console.log(`  Total Cursor conversations: ${conversations.length.toLocaleString()}`);

  console.log('\nStep 3: Building conversation windows...');
  const windows = buildConversationWindows(conversations);
  console.log(`  Windows created: ${windows.length.toLocaleString()}`);

  console.log('\nStep 4: Attributing events to conversations...');
  const csvSource = `cursor-api-sync-${new Date().toISOString().split('T')[0]}`;
  const events: BillingEvent[] = [];
  let unattributedCount = 0;
  let unattributedTokens = 0;
  let attributedTokens = 0;
  const conversationTokens = new Map<string, number>();

  for (const row of rows) {
    const window = findConversationForTimestamp(row.date, windows);
    const eventId = generateEventId(row, csvSource);

    const event: BillingEvent = {
      id: eventId,
      conversationId: window?.id,
      timestamp: row.date.toISOString(),
      model: row.model,
      kind: row.kind,
      inputTokens: row.inputWithCache ?? row.inputWithoutCache ?? undefined,
      outputTokens: row.outputTokens ?? undefined,
      cacheReadTokens: row.cacheRead ?? undefined,
      totalTokens: row.totalTokens ?? undefined,
      cost: row.cost ?? undefined,
      csvSource,
    };

    events.push(event);

    const tokens = row.totalTokens ?? 0;
    if (window) {
      attributedTokens += tokens;
      conversationTokens.set(window.id, (conversationTokens.get(window.id) ?? 0) + tokens);
    } else {
      unattributedCount++;
      unattributedTokens += tokens;
    }
  }

  const attributedConversations = conversationTokens.size;
  console.log(`  Attributed to ${attributedConversations.toLocaleString()} conversations`);
  console.log(`  Unattributed events: ${unattributedCount.toLocaleString()}`);

  if (options.dryRun) {
    console.log('\n[DRY RUN] Would sync:');
    console.log(`  Events: ${events.length.toLocaleString()}`);
    console.log(`  Tokens with data: ${(attributedTokens + unattributedTokens).toLocaleString()}`);
    console.log(`  Attributed tokens: ${attributedTokens.toLocaleString()}`);
    console.log(`  Unattributed tokens: ${unattributedTokens.toLocaleString()}`);
    return;
  }

  console.log('\nStep 5: Storing billing events...');
  const existingCount = await billingEventsRepo.count();
  if (existingCount > 0) {
    console.log(`  Clearing ${existingCount.toLocaleString()} existing events...`);
    const sources = new Set(events.map(e => e.csvSource));
    for (const source of sources) {
      await billingEventsRepo.deleteBySource(source);
    }
  }

  const BATCH_SIZE = 1000;
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    await billingEventsRepo.bulkInsert(batch);
    if ((i + BATCH_SIZE) % 5000 === 0 || i + BATCH_SIZE >= events.length) {
      console.log(`  Inserted ${Math.min(i + BATCH_SIZE, events.length).toLocaleString()}/${events.length.toLocaleString()} events...`);
    }
  }

  console.log('\n=== Sync Complete ===\n');
  console.log('Summary:');
  console.log(`  Total events: ${events.length.toLocaleString()}`);
  console.log(`  Events with token data: ${withTokens.length.toLocaleString()}`);
  console.log(`  Events without token data: ${withoutTokens.length.toLocaleString()}`);
  console.log(`  Attributed conversations: ${attributedConversations.toLocaleString()}`);
  console.log(`  Attributed tokens: ${attributedTokens.toLocaleString()}`);
  console.log(`  Unattributed events: ${unattributedCount.toLocaleString()}`);
  console.log(`  Unattributed tokens: ${unattributedTokens.toLocaleString()}`);

  const topConversations = [...conversationTokens.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (topConversations.length > 0) {
    console.log('\nTop 5 conversations by tokens:');
    for (const [convId, tokens] of topConversations) {
      const conv = conversations.find(c => c.id === convId);
      const title = conv?.title?.slice(0, 50) ?? 'Unknown';
      console.log(`  ${tokens.toLocaleString().padStart(12)} - ${title}`);
    }
  }
}
