/**
 * Stats command - analytics dashboard for conversation data
 *
 * Usage: dex stats [--period <days>] [--summary]
 *
 * Interactive TUI with tabs for Overview, Tokens, and Activity
 * Or use --summary for quick non-interactive output
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index';
import {
  createPeriodFilter,
  getOverviewStats,
  getDailyActivity,
  getStatsBySource,
  getStatsByModel,
  getTopConversationsByTokens,
  getLinesGeneratedStats,
  getCacheStats,
  getActivityByHour,
  getActivityByDayOfWeek,
  getStreakInfo,
  getSummaryStats,
  type OverviewStats,
  type DayActivity,
  type SourceStats,
  type ModelStats,
  type LinesGeneratedStats,
  type CacheStats,
  type StreakInfo,
  type PeriodFilter,
} from '../../db/analytics';
import { MetricRow, formatLargeNumber, formatTokenDisplay, formatLinesDisplay } from '../components/MetricCard';
import { Sparkline } from '../components/Sparkline';
import { HorizontalBar, ProgressBar, type BarItem } from '../components/HorizontalBar';
import { ActivityHeatmap, HourlyActivity, WeeklyActivity } from '../components/ActivityHeatmap';
import type { Conversation } from '../../schema/index';

interface StatsOptions {
  period?: string;
  summary?: boolean;
}

type TabId = 'overview' | 'tokens' | 'activity';

interface AllData {
  overview: OverviewStats;
  daily: DayActivity[];
  sources: SourceStats[];
  models: ModelStats[];
  topConversations: Conversation[];
  lines: LinesGeneratedStats;
  cache: CacheStats;
  hourly: number[];
  weekly: number[];
  streak: StreakInfo;
}

// --- Tab Components ---

function OverviewTab({
  data,
  width,
  height,
  period,
}: {
  data: AllData;
  width: number;
  height: number;
  period: number;
}) {
  const { overview, daily, sources, streak, lines } = data;

  // Prepare sparkline data
  const convTrend = daily.map(d => d.conversations);
  const msgTrend = daily.map(d => d.messages);
  const tokenTrend = daily.map(d => d.tokens);

  // Source bars
  const sourceBars: BarItem[] = sources.slice(0, 5).map(s => ({
    label: s.source,
    value: s.tokens,
    color: s.source === 'cursor' ? 'cyan' : s.source === 'claude-code' ? 'magenta' : 'yellow',
  }));

  return (
    <Box flexDirection="column">
      {/* Period header */}
      <Box marginBottom={1}>
        <Text bold color="white">Last {period} Days</Text>
        {streak.current > 0 && (
          <Text color="yellow"> · {streak.current} day streak</Text>
        )}
      </Box>

      {/* Main metrics row */}
      <Box marginBottom={1}>
        <MetricRow
          width={width}
          metrics={[
            { label: 'Conversations', value: formatLargeNumber(overview.conversations), color: 'cyan' },
            { label: 'Messages', value: formatLargeNumber(overview.messages), color: 'green' },
            { label: 'Input Tokens', value: formatLargeNumber(overview.totalInputTokens), color: 'yellow' },
            { label: 'Output Tokens', value: formatLargeNumber(overview.totalOutputTokens), color: 'magenta' },
          ]}
        />
      </Box>

      {/* Lines generated */}
      <Box marginBottom={1}>
        <MetricRow
          width={width}
          metrics={[
            { label: 'Lines Added', value: `+${formatLargeNumber(lines.totalLinesAdded)}`, color: 'green' },
            { label: 'Lines Removed', value: `-${formatLargeNumber(lines.totalLinesRemoved)}`, color: 'red' },
            { label: 'Net Lines', value: lines.netLines >= 0 ? `+${formatLargeNumber(lines.netLines)}` : formatLargeNumber(lines.netLines), color: lines.netLines >= 0 ? 'green' : 'red' },
            { label: 'Longest Streak', value: `${streak.longest} days`, color: 'yellow' },
          ]}
        />
      </Box>

      {/* Trends */}
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>Activity Trends</Text>
        <Box>
          <Box width={Math.floor(width / 3)}>
            <Text>Conversations: </Text>
            <Sparkline data={convTrend} width={15} showTrend />
          </Box>
          <Box width={Math.floor(width / 3)}>
            <Text>Messages: </Text>
            <Sparkline data={msgTrend} width={15} color="green" showTrend />
          </Box>
          <Box width={Math.floor(width / 3)}>
            <Text>Tokens: </Text>
            <Sparkline data={tokenTrend} width={15} color="yellow" showTrend />
          </Box>
        </Box>
      </Box>

      {/* Sources breakdown */}
      {sourceBars.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>By Source (tokens)</Text>
          <HorizontalBar items={sourceBars} width={Math.min(width, 60)} maxLabelWidth={12} />
        </Box>
      )}
    </Box>
  );
}

function TokensTab({
  data,
  width,
  height,
}: {
  data: AllData;
  width: number;
  height: number;
}) {
  const { models, topConversations, lines, cache, sources } = data;

  // Model bars
  const modelBars: BarItem[] = models.slice(0, 5).map(m => ({
    label: m.model.length > 20 ? m.model.slice(0, 19) + '…' : m.model,
    value: m.inputTokens + m.outputTokens,
    color: 'cyan',
  }));

  // Check if we have any Claude Code/Codex sources for cache stats
  const hasCacheData = sources.some(s => s.source === 'claude-code' || s.source === 'codex');

  return (
    <Box flexDirection="column">
      {/* Models breakdown */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="white">Token Usage by Model</Text>
        {modelBars.length > 0 ? (
          <HorizontalBar items={modelBars} width={Math.min(width, 60)} maxLabelWidth={22} />
        ) : (
          <Text dimColor>No model data available</Text>
        )}
      </Box>

      {/* Lines Generated */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="white">Lines Generated</Text>
        <Box>
          <Box width={20}>
            <Text color="green">+{formatLargeNumber(lines.totalLinesAdded)}</Text>
            <Text dimColor> added</Text>
          </Box>
          <Box width={20}>
            <Text color="red">-{formatLargeNumber(lines.totalLinesRemoved)}</Text>
            <Text dimColor> removed</Text>
          </Box>
          <Box>
            <Text color={lines.netLines >= 0 ? 'green' : 'red'}>
              {lines.netLines >= 0 ? '+' : ''}{formatLargeNumber(lines.netLines)}
            </Text>
            <Text dimColor> net</Text>
          </Box>
        </Box>
        {lines.topConversationsByLines.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Top by lines added:</Text>
            {lines.topConversationsByLines.slice(0, 3).map((conv, idx) => (
              <Box key={idx}>
                <Text color="green">+{String(conv.linesAdded).padStart(5)} </Text>
                <Text>{conv.title.slice(0, 40)}{conv.title.length > 40 ? '…' : ''}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>

      {/* Cache Efficiency - Claude Code/Codex only */}
      {hasCacheData && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="white">Cache Efficiency <Text dimColor>(Claude Code/Codex only)</Text></Text>
          <Box>
            <Box width={30}>
              <Text dimColor>Hit Rate: </Text>
              <ProgressBar value={cache.hitRate} width={15} color="green" />
            </Box>
          </Box>
          <Box marginTop={1}>
            <Box width={20}>
              <Text dimColor>Cache Read: </Text>
              <Text color="green">{formatLargeNumber(cache.cacheRead)}</Text>
            </Box>
            <Box width={20}>
              <Text dimColor>Cache Create: </Text>
              <Text color="yellow">{formatLargeNumber(cache.cacheCreation)}</Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Top conversations */}
      <Box flexDirection="column">
        <Text bold color="white">Top Conversations by Tokens</Text>
        {topConversations.length > 0 ? (
          topConversations.slice(0, 5).map((conv, idx) => {
            const total = (conv.totalInputTokens || 0) + (conv.totalOutputTokens || 0);
            return (
              <Box key={idx}>
                <Text color="cyan">{formatLargeNumber(total).padStart(6)} </Text>
                <Text>{conv.title.slice(0, 50)}{conv.title.length > 50 ? '…' : ''}</Text>
              </Box>
            );
          })
        ) : (
          <Text dimColor>No conversation data</Text>
        )}
      </Box>
    </Box>
  );
}

function ActivityTab({
  data,
  width,
  height,
  period,
}: {
  data: AllData;
  width: number;
  height: number;
  period: number;
}) {
  const { daily, hourly, weekly, streak } = data;
  const weeks = Math.ceil(period / 7);

  return (
    <Box flexDirection="column">
      {/* Streak info */}
      <Box marginBottom={1}>
        <Text bold color="white">Activity Streaks</Text>
      </Box>
      <Box marginBottom={1}>
        <Box width={20}>
          <Text dimColor>Current: </Text>
          <Text color="yellow" bold>{streak.current} days</Text>
        </Box>
        <Box>
          <Text dimColor>Longest: </Text>
          <Text color="green" bold>{streak.longest} days</Text>
          {streak.longestStart && (
            <Text dimColor> ({streak.longestStart} - {streak.longestEnd})</Text>
          )}
        </Box>
      </Box>

      {/* Activity heatmap */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="white">Activity Heatmap</Text>
        <ActivityHeatmap data={daily} weeks={weeks} width={width} metric="conversations" />
      </Box>

      {/* Hourly distribution */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="white">Activity by Hour</Text>
        <HourlyActivity data={hourly} width={width} />
      </Box>

      {/* Weekly distribution */}
      <Box flexDirection="column">
        <Text bold color="white">Activity by Day of Week</Text>
        <WeeklyActivity data={weekly} width={Math.min(width, 40)} />
      </Box>
    </Box>
  );
}

// --- Main Stats App ---

function StatsApp({ period }: { period: number }) {
  const { exit } = useApp();
  const { width, height } = useScreenSize();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [data, setData] = useState<AllData | null>(null);

  useEffect(() => {
    async function loadData() {
      try {
        await connect();
        const periodFilter = createPeriodFilter(period);

        // Load all data in parallel
        const [overview, daily, sources, models, topConversations, lines, cache, hourly, weekly, streak] = await Promise.all([
          getOverviewStats(periodFilter),
          getDailyActivity(periodFilter),
          getStatsBySource(periodFilter),
          getStatsByModel(periodFilter),
          getTopConversationsByTokens(periodFilter, 5),
          getLinesGeneratedStats(periodFilter, 5),
          getCacheStats(periodFilter),
          getActivityByHour(periodFilter),
          getActivityByDayOfWeek(periodFilter),
          getStreakInfo(),
        ]);

        setData({
          overview,
          daily,
          sources,
          models,
          topConversations,
          lines,
          cache,
          hourly,
          weekly,
          streak,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [period]);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
      return;
    }

    // Tab switching
    if (input === '1') setActiveTab('overview');
    if (input === '2') setActiveTab('tokens');
    if (input === '3') setActiveTab('activity');

    // Arrow key tab navigation
    if (key.leftArrow || input === 'h') {
      const tabs: TabId[] = ['overview', 'tokens', 'activity'];
      const idx = tabs.indexOf(activeTab);
      setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length]!);
    }
    if (key.rightArrow || input === 'l') {
      const tabs: TabId[] = ['overview', 'tokens', 'activity'];
      const idx = tabs.indexOf(activeTab);
      setActiveTab(tabs[(idx + 1) % tabs.length]!);
    }
  });

  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="cyan">Loading analytics...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box width={width} height={height} flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press q to exit</Text>
      </Box>
    );
  }

  if (!data) {
    return (
      <Box width={width} height={height} flexDirection="column" padding={1}>
        <Text dimColor>No data available</Text>
        <Text dimColor>Press q to exit</Text>
      </Box>
    );
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: '1:Overview' },
    { id: 'tokens', label: '2:Tokens' },
    { id: 'activity', label: '3:Activity' },
  ];

  const headerHeight = 4;
  const footerHeight = 2;
  const contentHeight = height - headerHeight - footerHeight;

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text bold color="white">Stats Dashboard</Text>
          <Text dimColor> · Last {period} days</Text>
        </Box>
        {/* Tab bar */}
        <Box paddingX={1}>
          {tabs.map((tab, idx) => (
            <Box key={tab.id} marginRight={2}>
              <Text
                bold={activeTab === tab.id}
                color={activeTab === tab.id ? 'cyan' : 'white'}
                underline={activeTab === tab.id}
              >
                {tab.label}
              </Text>
            </Box>
          ))}
        </Box>
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
      </Box>

      {/* Content */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} height={contentHeight}>
        {activeTab === 'overview' && (
          <OverviewTab data={data} width={width - 2} height={contentHeight} period={period} />
        )}
        {activeTab === 'tokens' && (
          <TokensTab data={data} width={width - 2} height={contentHeight} />
        )}
        {activeTab === 'activity' && (
          <ActivityTab data={data} width={width - 2} height={contentHeight} period={period} />
        )}
      </Box>

      {/* Footer */}
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
        </Box>
        <Box paddingX={1}>
          <Text>
            <Text color="white">1-3</Text><Text dimColor>: tabs · </Text>
            <Text color="white">h/l</Text><Text dimColor>: navigate · </Text>
            <Text color="white">q</Text><Text dimColor>: quit</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

// --- Non-interactive Summary ---

async function printSummary(period: number): Promise<void> {
  await connect();
  const stats = await getSummaryStats(period);
  const streak = await getStreakInfo();

  console.log('');
  console.log(`Stats (last ${period} days)`);
  console.log('');
  console.log(`  Conversations: ${stats.conversations}`);
  console.log(`  Messages:      ${stats.messages}`);
  console.log(`  Tokens:        ${formatLargeNumber(stats.inputTokens)} in / ${formatLargeNumber(stats.outputTokens)} out`);
  console.log(`  Lines:         +${formatLargeNumber(stats.linesAdded)} / -${formatLargeNumber(stats.linesRemoved)}`);

  if (streak.current > 0) {
    console.log(`  Streak:        ${streak.current} days`);
  }

  console.log('');
}

// --- Rich Summary for Post-Sync ---

export async function printRichSummary(period: number = 7): Promise<void> {
  await connect();
  const stats = await getSummaryStats(period);
  const streak = await getStreakInfo();

  const parts: string[] = [];

  // Conversations and messages
  parts.push(`${stats.conversations} conversations`);
  parts.push(`${stats.messages} messages`);

  // Tokens
  if (stats.inputTokens > 0 || stats.outputTokens > 0) {
    parts.push(`${formatLargeNumber(stats.inputTokens)} in / ${formatLargeNumber(stats.outputTokens)} out`);
  }

  // Lines
  if (stats.linesAdded > 0 || stats.linesRemoved > 0) {
    parts.push(`+${formatLargeNumber(stats.linesAdded)} / -${formatLargeNumber(stats.linesRemoved)} lines`);
  }

  // Streak with emoji
  if (streak.current > 0) {
    parts.push(`${streak.current} day streak`);
  }

  console.log('');
  console.log(`Last ${period} days: ${parts.join(' · ')}`);
  console.log('');
}

// --- Entry Point ---

export async function statsCommand(options: StatsOptions): Promise<void> {
  const period = parseInt(options.period ?? '30', 10);

  if (options.summary || !process.stdin.isTTY) {
    await printSummary(period);
    return;
  }

  const app = withFullScreen(<StatsApp period={period} />);
  await app.start();
  await app.waitUntilExit();
}
