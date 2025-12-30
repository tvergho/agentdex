import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile } from 'fs/promises';
import { join } from 'path';

import { TestDatabase } from '../../helpers/db';
import { TempDir } from '../../helpers/temp';
import { mockConsole, mockProcessExit } from '../../helpers/cli';
import { createConversation } from '../../fixtures';

function isoDateTime(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): string {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
}

describe('billing import command', () => {
  let db: TestDatabase;
  let temp: TempDir;
  let consoleMock: ReturnType<typeof mockConsole>;

  beforeEach(async () => {
    db = new TestDatabase();
    temp = new TempDir();
    consoleMock = mockConsole();
    await db.setup();
  });

  afterEach(async () => {
    consoleMock.restore();
    await temp.cleanupAll();
    await db.teardown();
  });

  async function createTestCsv(rows: string[]): Promise<string> {
    const dir = await temp.create('billing-test');
    const csvPath = join(dir, 'test-billing.csv');
    const header = 'Date,User,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost';
    await writeFile(csvPath, [header, ...rows].join('\n'), 'utf-8');
    return csvPath;
  }

  describe('basic import', () => {
    it('imports billing events from CSV', async () => {
      const conv = createConversation({
        source: 'cursor',
        updatedAt: isoDateTime(2025, 1, 15, 12, 0, 0),
      });
      await db.seed({ conversations: [conv] });

      const csvPath = await createTestCsv([
        '2025-01-15T10:00:00Z,user@test.com,chat,gpt-4,normal,100,80,20,50,150,0.01',
        '2025-01-15T11:00:00Z,user@test.com,chat,claude-3,normal,200,180,20,100,300,0.02',
      ]);

      const { billingImportCommand } = await import('../../../src/cli/commands/billing');
      await billingImportCommand(csvPath, {});

      const { billingEventsRepo } = await import('../../../src/db/repository');
      const count = await billingEventsRepo.count();
      expect(count).toBe(2);

      const output = consoleMock.logs.join('\n');
      expect(output).toContain('Import Complete');
      expect(output).toContain('Total events: 2');
    });

    it('attributes events to conversations via timestamp windows', async () => {
      const conv1 = createConversation({
        source: 'cursor',
        title: 'First Conv',
        updatedAt: isoDateTime(2025, 1, 10, 12, 0, 0),
      });
      const conv2 = createConversation({
        source: 'cursor',
        title: 'Second Conv',
        updatedAt: isoDateTime(2025, 1, 20, 12, 0, 0),
      });
      await db.seed({ conversations: [conv1, conv2] });

      const csvPath = await createTestCsv([
        '2025-01-08T10:00:00Z,user@test.com,chat,gpt-4,normal,100,80,20,50,1000,0.01',
        '2025-01-18T10:00:00Z,user@test.com,chat,gpt-4,normal,100,80,20,50,2000,0.01',
      ]);

      const { billingImportCommand } = await import('../../../src/cli/commands/billing');
      await billingImportCommand(csvPath, {});

      const { billingEventsRepo } = await import('../../../src/db/repository');
      
      const conv1Tokens = await billingEventsRepo.getTokensByConversation(conv1.id);
      const conv2Tokens = await billingEventsRepo.getTokensByConversation(conv2.id);
      
      expect(conv1Tokens).toBe(1000);
      expect(conv2Tokens).toBe(2000);
    });

    it('handles events without token data', async () => {
      const conv = createConversation({
        source: 'cursor',
        updatedAt: isoDateTime(2025, 1, 15, 12, 0, 0),
      });
      await db.seed({ conversations: [conv] });

      const csvPath = await createTestCsv([
        '2025-01-15T10:00:00Z,user@test.com,chat,gpt-4,normal,,,,,1000,0.01',
        '2025-01-15T11:00:00Z,user@test.com,chat,gpt-4,normal,,,,,,',
      ]);

      const { billingImportCommand } = await import('../../../src/cli/commands/billing');
      await billingImportCommand(csvPath, {});

      const output = consoleMock.logs.join('\n');
      expect(output).toContain('Rows with token data: 1');
      expect(output).toContain('Rows without token data: 1');
    });
  });

  describe('dry run', () => {
    it('previews import without writing', async () => {
      const conv = createConversation({
        source: 'cursor',
        updatedAt: isoDateTime(2025, 1, 15, 12, 0, 0),
      });
      await db.seed({ conversations: [conv] });

      const csvPath = await createTestCsv([
        '2025-01-15T10:00:00Z,user@test.com,chat,gpt-4,normal,100,80,20,50,150,0.01',
      ]);

      const { billingImportCommand } = await import('../../../src/cli/commands/billing');
      await billingImportCommand(csvPath, { dryRun: true });

      const { billingEventsRepo } = await import('../../../src/db/repository');
      const count = await billingEventsRepo.count();
      expect(count).toBe(0);

      const output = consoleMock.logs.join('\n');
      expect(output).toContain('[DRY RUN]');
    });
  });

  describe('idempotent re-import', () => {
    it('replaces events from same CSV source', async () => {
      const conv = createConversation({
        source: 'cursor',
        updatedAt: isoDateTime(2025, 1, 15, 12, 0, 0),
      });
      await db.seed({ conversations: [conv] });

      const csvPath = await createTestCsv([
        '2025-01-15T10:00:00Z,user@test.com,chat,gpt-4,normal,100,80,20,50,1000,0.01',
      ]);

      const { billingImportCommand } = await import('../../../src/cli/commands/billing');
      
      await billingImportCommand(csvPath, {});
      
      const { billingEventsRepo } = await import('../../../src/db/repository');
      expect(await billingEventsRepo.count()).toBe(1);

      await billingImportCommand(csvPath, {});
      
      expect(await billingEventsRepo.count()).toBe(1);

      const output = consoleMock.logs.join('\n');
      expect(output).toContain('Removing 1 existing events');
    });
  });

  describe('error handling', () => {
    it('exits with error for missing file', async () => {
      const exitMock = mockProcessExit();

      const { billingImportCommand } = await import('../../../src/cli/commands/billing');
      
      try {
        await billingImportCommand('/nonexistent/path.csv', {});
      } catch (e: any) {
        expect(e.name).toBe('ProcessExitError');
      }

      expect(consoleMock.errors.join('\n')).toContain('File not found');
      exitMock.restore();
    });
  });
});

describe('billing stats command', () => {
  let db: TestDatabase;
  let consoleMock: ReturnType<typeof mockConsole>;

  beforeEach(async () => {
    db = new TestDatabase();
    consoleMock = mockConsole();
    await db.setup();
  });

  afterEach(async () => {
    consoleMock.restore();
    await db.teardown();
  });

  it('shows stats for imported billing data', async () => {
    const conv = createConversation({ source: 'cursor' });
    await db.seed({ conversations: [conv] });

    const { billingEventsRepo } = await import('../../../src/db/repository');
    const { createBillingEvent } = await import('../../fixtures');

    await billingEventsRepo.bulkInsert([
      createBillingEvent({ conversationId: conv.id, totalTokens: 1000 }),
      createBillingEvent({ conversationId: conv.id, totalTokens: 2000 }),
      createBillingEvent({ conversationId: undefined, totalTokens: 500 }),
    ]);

    const { billingStatsCommand } = await import('../../../src/cli/commands/billing');
    await billingStatsCommand();

    const output = consoleMock.logs.join('\n');
    expect(output).toContain('Total events: 3');
    expect(output).toContain('Total tokens: 3,500');
    expect(output).toContain('Attributed events: 2');
    expect(output).toContain('Unattributed events: 1');
  });

  it('shows message when no billing data exists', async () => {
    const { billingStatsCommand } = await import('../../../src/cli/commands/billing');
    await billingStatsCommand();

    const output = consoleMock.logs.join('\n');
    expect(output).toContain('No billing events found');
    expect(output).toContain('dex billing sync');
  });
});
