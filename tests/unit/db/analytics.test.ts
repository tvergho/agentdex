/**
 * Unit tests for analytics module
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestDatabase } from '../../helpers/db';
import { createConversation, createFileEdit } from '../../fixtures';
import { isoDate } from '../../helpers/time';

describe('analytics', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = new TestDatabase();
    await db.setup();
  });

  afterEach(async () => {
    await db.teardown();
  });

  describe('createPeriodFilter', () => {
    it('creates period filter for last N days', async () => {
      const { createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(7);

      expect(period.startDate).toBeInstanceOf(Date);
      expect(period.endDate).toBeInstanceOf(Date);
      expect(period.endDate.getTime()).toBeGreaterThan(period.startDate.getTime());

      // Should be approximately 7 days
      const diffDays = (period.endDate.getTime() - period.startDate.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThanOrEqual(7);
      expect(diffDays).toBeLessThan(8);
    });
  });

  describe('getOverviewStats', () => {
    it('returns zeros for empty database', async () => {
      const { getOverviewStats, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);

      const stats = await getOverviewStats(period);

      expect(stats.conversations).toBe(0);
      expect(stats.messages).toBe(0);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
    });

    it('aggregates conversation stats within period', async () => {
      const conv1 = createConversation({
        createdAt: new Date().toISOString(),
        messageCount: 10,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalLinesAdded: 50,
        totalLinesRemoved: 20,
      });
      const conv2 = createConversation({
        createdAt: new Date().toISOString(),
        messageCount: 5,
        totalInputTokens: 500,
        totalOutputTokens: 250,
        totalLinesAdded: 30,
        totalLinesRemoved: 10,
      });
      await db.seed({ conversations: [conv1, conv2] });

      const { getOverviewStats, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getOverviewStats(period);

      expect(stats.conversations).toBe(2);
      expect(stats.messages).toBe(15);
      expect(stats.totalInputTokens).toBe(1500);
      expect(stats.totalOutputTokens).toBe(750);
      expect(stats.totalLinesAdded).toBe(80);
      expect(stats.totalLinesRemoved).toBe(30);
    });

    it('includes cache tokens in input total', async () => {
      const conv = createConversation({
        createdAt: new Date().toISOString(),
        totalInputTokens: 1000,
        totalCacheCreationTokens: 200,
        totalCacheReadTokens: 300,
      });
      await db.seed({ conversations: [conv] });

      const { getOverviewStats, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getOverviewStats(period);

      expect(stats.totalInputTokens).toBe(1500); // 1000 + 200 + 300
    });

    it('excludes conversations outside period', async () => {
      const inPeriod = createConversation({
        createdAt: new Date().toISOString(),
        messageCount: 10,
      });
      const outOfPeriod = createConversation({
        createdAt: isoDate(2020, 1, 1),
        messageCount: 100,
      });
      await db.seed({ conversations: [inPeriod, outOfPeriod] });

      const { getOverviewStats, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getOverviewStats(period);

      expect(stats.conversations).toBe(1);
      expect(stats.messages).toBe(10);
    });
  });

  describe('getDailyActivity', () => {
    it('returns empty array for empty database', async () => {
      const { getDailyActivity, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);

      const activity = await getDailyActivity(period);

      expect(activity).toEqual([]);
    });

    it('groups conversations by date', async () => {
      const today = new Date().toISOString().split('T')[0]!;
      const conv1 = createConversation({
        createdAt: `${today}T10:00:00.000Z`,
        messageCount: 5,
      });
      const conv2 = createConversation({
        createdAt: `${today}T14:00:00.000Z`,
        messageCount: 10,
      });
      await db.seed({ conversations: [conv1, conv2] });

      const { getDailyActivity, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const activity = await getDailyActivity(period);

      expect(activity.length).toBe(1);
      expect(activity[0]!.date).toBe(today);
      expect(activity[0]!.conversations).toBe(2);
      expect(activity[0]!.messages).toBe(15);
    });

    it('sorts activity by date ascending', async () => {
      const conv1 = createConversation({ createdAt: isoDate(2025, 1, 15) });
      const conv2 = createConversation({ createdAt: isoDate(2025, 1, 10) });
      const conv3 = createConversation({ createdAt: isoDate(2025, 1, 20) });
      await db.seed({ conversations: [conv1, conv2, conv3] });

      const { getDailyActivity } = await import('../../../src/db/analytics');
      const period = {
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-31'),
      };
      const activity = await getDailyActivity(period);

      expect(activity.length).toBe(3);
      expect(activity[0]!.date).toBe('2025-01-10');
      expect(activity[1]!.date).toBe('2025-01-15');
      expect(activity[2]!.date).toBe('2025-01-20');
    });
  });

  describe('getStatsBySource', () => {
    it('groups stats by source', async () => {
      const cursor1 = createConversation({
        source: 'cursor',
        createdAt: new Date().toISOString(),
        messageCount: 10,
        totalInputTokens: 1000,
      });
      const cursor2 = createConversation({
        source: 'cursor',
        createdAt: new Date().toISOString(),
        messageCount: 5,
        totalInputTokens: 500,
      });
      const claude = createConversation({
        source: 'claude-code',
        createdAt: new Date().toISOString(),
        messageCount: 20,
        totalInputTokens: 2000,
      });
      await db.seed({ conversations: [cursor1, cursor2, claude] });

      const { getStatsBySource, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getStatsBySource(period);

      expect(stats.length).toBe(2);
      // Should be sorted by tokens descending
      expect(stats[0]!.source).toBe('claude-code');
      expect(stats[0]!.conversations).toBe(1);
      expect(stats[1]!.source).toBe('cursor');
      expect(stats[1]!.conversations).toBe(2);
      expect(stats[1]!.messages).toBe(15);
    });
  });

  describe('getStatsByModel', () => {
    it('groups stats by model and source', async () => {
      const conv1 = createConversation({
        source: 'cursor',
        model: 'gpt-4',
        createdAt: new Date().toISOString(),
        totalInputTokens: 1000,
        totalOutputTokens: 500,
      });
      const conv2 = createConversation({
        source: 'cursor',
        model: 'gpt-4',
        createdAt: new Date().toISOString(),
        totalInputTokens: 1000,
        totalOutputTokens: 500,
      });
      const conv3 = createConversation({
        source: 'claude-code',
        model: 'claude-3-opus',
        createdAt: new Date().toISOString(),
        totalInputTokens: 5000,
        totalOutputTokens: 2000,
      });
      await db.seed({ conversations: [conv1, conv2, conv3] });

      const { getStatsByModel, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getStatsByModel(period);

      expect(stats.length).toBe(2);
      // Sorted by total tokens descending
      expect(stats[0]!.model).toBe('claude-3-opus');
      expect(stats[0]!.source).toBe('claude-code');
      expect(stats[0]!.conversations).toBe(1);
      expect(stats[1]!.model).toBe('gpt-4');
      expect(stats[1]!.conversations).toBe(2);
    });

    it('handles missing model as (unknown)', async () => {
      const conv = createConversation({
        createdAt: new Date().toISOString(),
        model: undefined,
      });
      await db.seed({ conversations: [conv] });

      const { getStatsByModel, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getStatsByModel(period);

      expect(stats[0]!.model).toBe('(unknown)');
    });
  });

  describe('getLinesGeneratedStats', () => {
    it('calculates line totals', async () => {
      const conv1 = createConversation({
        title: 'Conv 1',
        createdAt: new Date().toISOString(),
        totalLinesAdded: 100,
        totalLinesRemoved: 30,
      });
      const conv2 = createConversation({
        title: 'Conv 2',
        createdAt: new Date().toISOString(),
        totalLinesAdded: 50,
        totalLinesRemoved: 20,
      });
      await db.seed({ conversations: [conv1, conv2] });

      const { getLinesGeneratedStats, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getLinesGeneratedStats(period);

      expect(stats.totalLinesAdded).toBe(150);
      expect(stats.totalLinesRemoved).toBe(50);
      expect(stats.netLines).toBe(100);
    });

    it('returns top conversations by lines added', async () => {
      const convs = [
        createConversation({ title: 'Low', createdAt: new Date().toISOString(), totalLinesAdded: 10 }),
        createConversation({ title: 'High', createdAt: new Date().toISOString(), totalLinesAdded: 100 }),
        createConversation({ title: 'Medium', createdAt: new Date().toISOString(), totalLinesAdded: 50 }),
      ];
      await db.seed({ conversations: convs });

      const { getLinesGeneratedStats, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getLinesGeneratedStats(period, 2);

      expect(stats.topConversationsByLines.length).toBe(2);
      expect(stats.topConversationsByLines[0]!.title).toBe('High');
      expect(stats.topConversationsByLines[1]!.title).toBe('Medium');
    });
  });

  describe('getCacheStats', () => {
    it('calculates cache stats for claude-code and codex only', async () => {
      const claude = createConversation({
        source: 'claude-code',
        createdAt: new Date().toISOString(),
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCacheCreationTokens: 200,
        totalCacheReadTokens: 800,
      });
      const cursor = createConversation({
        source: 'cursor',
        createdAt: new Date().toISOString(),
        totalInputTokens: 5000, // Should be excluded
      });
      await db.seed({ conversations: [claude, cursor] });

      const { getCacheStats, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getCacheStats(period);

      expect(stats.totalInput).toBe(1000);
      expect(stats.totalOutput).toBe(500);
      expect(stats.cacheCreation).toBe(200);
      expect(stats.cacheRead).toBe(800);
    });

    it('calculates cache hit rate', async () => {
      const conv = createConversation({
        source: 'claude-code',
        createdAt: new Date().toISOString(),
        totalInputTokens: 100,
        totalCacheCreationTokens: 100,
        totalCacheReadTokens: 800, // 80% hit rate
      });
      await db.seed({ conversations: [conv] });

      const { getCacheStats, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getCacheStats(period);

      expect(stats.hitRate).toBe(0.8);
    });

    it('returns 0 hit rate for no cache data', async () => {
      const { getCacheStats, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getCacheStats(period);

      expect(stats.hitRate).toBe(0);
    });
  });

  describe('getActivityByHour', () => {
    it('returns 24-element array', async () => {
      const { getActivityByHour, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const activity = await getActivityByHour(period);

      expect(activity.length).toBe(24);
    });

    it('counts conversations by hour of day', async () => {
      const conv1 = createConversation({
        createdAt: new Date('2025-01-15T10:30:00Z').toISOString(),
      });
      const conv2 = createConversation({
        createdAt: new Date('2025-01-15T10:45:00Z').toISOString(),
      });
      const conv3 = createConversation({
        createdAt: new Date('2025-01-15T14:00:00Z').toISOString(),
      });
      await db.seed({ conversations: [conv1, conv2, conv3] });

      const { getActivityByHour } = await import('../../../src/db/analytics');
      const period = {
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-31'),
      };
      const activity = await getActivityByHour(period);

      expect(activity[10]).toBe(2); // Two at 10:xx
      expect(activity[14]).toBe(1); // One at 14:xx
    });
  });

  describe('getActivityByDayOfWeek', () => {
    it('returns 7-element array', async () => {
      const { getActivityByDayOfWeek, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const activity = await getActivityByDayOfWeek(period);

      expect(activity.length).toBe(7);
    });

    it('counts conversations by day of week', async () => {
      // 2025-01-15 is a Wednesday (day 3)
      const conv1 = createConversation({ createdAt: isoDate(2025, 1, 15) }); // Wed
      const conv2 = createConversation({ createdAt: isoDate(2025, 1, 16) }); // Thu
      const conv3 = createConversation({ createdAt: isoDate(2025, 1, 22) }); // Wed
      await db.seed({ conversations: [conv1, conv2, conv3] });

      const { getActivityByDayOfWeek } = await import('../../../src/db/analytics');
      const period = {
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-31'),
      };
      const activity = await getActivityByDayOfWeek(period);

      expect(activity[3]).toBe(2); // Wednesday
      expect(activity[4]).toBe(1); // Thursday
    });
  });

  describe('getProjectStats', () => {
    it('groups stats by project name', async () => {
      const proj1Conv1 = createConversation({
        projectName: 'project-a',
        workspacePath: '/home/user/project-a',
        createdAt: new Date().toISOString(),
        messageCount: 10,
        totalInputTokens: 1000,
      });
      const proj1Conv2 = createConversation({
        projectName: 'project-a',
        workspacePath: '/home/user/project-a',
        createdAt: new Date().toISOString(),
        messageCount: 5,
        totalInputTokens: 500,
      });
      const proj2Conv = createConversation({
        projectName: 'project-b',
        workspacePath: '/home/user/project-b',
        createdAt: new Date().toISOString(),
        messageCount: 20,
        totalInputTokens: 3000,
      });
      await db.seed({ conversations: [proj1Conv1, proj1Conv2, proj2Conv] });

      const { getProjectStats, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getProjectStats(period);

      expect(stats.length).toBe(2);
      // Sorted by total tokens descending
      expect(stats[0]!.projectName).toBe('project-b');
      expect(stats[0]!.conversations).toBe(1);
      expect(stats[1]!.projectName).toBe('project-a');
      expect(stats[1]!.conversations).toBe(2);
      expect(stats[1]!.messages).toBe(15);
    });

    it('extracts project name from workspace path if not provided', async () => {
      const conv = createConversation({
        workspacePath: '/home/user/my-project',
        projectName: undefined, // Force extraction from workspace path
        createdAt: new Date().toISOString(),
      });
      await db.seed({ conversations: [conv] });

      const { getProjectStats, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getProjectStats(period);

      expect(stats[0]!.projectName).toBe('my-project');
    });
  });

  describe('getTopConversationsByTokens', () => {
    it('returns conversations sorted by total tokens', async () => {
      const low = createConversation({
        title: 'Low',
        createdAt: new Date().toISOString(),
        totalInputTokens: 100,
        totalOutputTokens: 50,
      });
      const high = createConversation({
        title: 'High',
        createdAt: new Date().toISOString(),
        totalInputTokens: 5000,
        totalOutputTokens: 2000,
      });
      const medium = createConversation({
        title: 'Medium',
        createdAt: new Date().toISOString(),
        totalInputTokens: 1000,
        totalOutputTokens: 500,
      });
      await db.seed({ conversations: [low, high, medium] });

      const { getTopConversationsByTokens, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const top = await getTopConversationsByTokens(period, 2);

      expect(top.length).toBe(2);
      expect(top[0]!.title).toBe('High');
      expect(top[1]!.title).toBe('Medium');
    });
  });

  describe('getRecentConversations', () => {
    it('returns conversations sorted by date descending', async () => {
      const old = createConversation({
        title: 'Old',
        createdAt: isoDate(2025, 1, 1),
      });
      const newer = createConversation({
        title: 'New',
        createdAt: isoDate(2025, 1, 15),
      });
      const middle = createConversation({
        title: 'Middle',
        createdAt: isoDate(2025, 1, 10),
      });
      await db.seed({ conversations: [old, newer, middle] });

      const { getRecentConversations } = await import('../../../src/db/analytics');
      const period = {
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-31'),
      };
      const recent = await getRecentConversations(period, 3);

      expect(recent.length).toBe(3);
      expect(recent[0]!.title).toBe('New');
      expect(recent[1]!.title).toBe('Middle');
      expect(recent[2]!.title).toBe('Old');
    });

    it('calculates total tokens including cache', async () => {
      const conv = createConversation({
        title: 'Test',
        createdAt: new Date().toISOString(),
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCacheCreationTokens: 100,
        totalCacheReadTokens: 200,
      });
      await db.seed({ conversations: [conv] });

      const { getRecentConversations, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const recent = await getRecentConversations(period, 1);

      expect(recent[0]!.totalTokens).toBe(1800);
    });
  });

  describe('getSummaryStats', () => {
    it('returns combined summary stats', async () => {
      const conv = createConversation({
        createdAt: new Date().toISOString(),
        messageCount: 10,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalLinesAdded: 50,
        totalLinesRemoved: 20,
      });
      await db.seed({ conversations: [conv] });

      const { getSummaryStats } = await import('../../../src/db/analytics');
      const stats = await getSummaryStats(30);

      expect(stats.conversations).toBe(1);
      expect(stats.messages).toBe(10);
      expect(stats.inputTokens).toBe(1000);
      expect(stats.outputTokens).toBe(500);
      expect(stats.linesAdded).toBe(50);
      expect(stats.linesRemoved).toBe(20);
    });
  });

  describe('getEditTypeBreakdown', () => {
    it('counts edit types', async () => {
      const conv = createConversation({ createdAt: new Date().toISOString() });
      const msg = { id: 'msg-1', conversationId: conv.id, role: 'assistant' as const, content: '', messageIndex: 0 };
      const edits = [
        createFileEdit(msg.id, conv.id, { editType: 'create' }),
        createFileEdit(msg.id, conv.id, { editType: 'modify' }),
        createFileEdit(msg.id, conv.id, { editType: 'modify' }),
        createFileEdit(msg.id, conv.id, { editType: 'delete' }),
      ];
      await db.seed({ conversations: [conv], messages: [msg], fileEdits: edits });

      const { getEditTypeBreakdown, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const breakdown = await getEditTypeBreakdown(period);

      expect(breakdown.create).toBe(1);
      expect(breakdown.modify).toBe(2);
      expect(breakdown.delete).toBe(1);
    });
  });

  describe('getFileTypeStats', () => {
    it('groups edits by file extension', async () => {
      const conv = createConversation({ createdAt: new Date().toISOString() });
      const msg = { id: 'msg-1', conversationId: conv.id, role: 'assistant' as const, content: '', messageIndex: 0 };
      const edits = [
        createFileEdit(msg.id, conv.id, { filePath: '/src/app.ts', linesAdded: 10 }),
        createFileEdit(msg.id, conv.id, { filePath: '/src/utils.ts', linesAdded: 20 }),
        createFileEdit(msg.id, conv.id, { filePath: '/src/style.css', linesAdded: 5 }),
      ];
      await db.seed({ conversations: [conv], messages: [msg], fileEdits: edits });

      const { getFileTypeStats, createPeriodFilter } = await import('../../../src/db/analytics');
      const period = createPeriodFilter(30);
      const stats = await getFileTypeStats(period);

      // .ts/.tsx should be grouped together and be first (2 edits)
      expect(stats[0]!.extension).toBe('.ts/.tsx');
      expect(stats[0]!.editCount).toBe(2);
      expect(stats[0]!.linesAdded).toBe(30);
    });
  });
});

