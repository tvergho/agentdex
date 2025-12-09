/**
 * SourceTokenTrend component - visualizes token usage over time by source
 * Shows sparklines for each source with distinct colors
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DailyTokensBySource } from '../../db/analytics';
import { Source, getSourceInfo } from '../../schema/index';
import { formatLargeNumber } from './MetricCard';

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export interface SourceTokenTrendProps {
  data: DailyTokensBySource[];
  width: number;
  showLegend?: boolean;
  showDateAxis?: boolean;
}

interface SourceConfig {
  key: keyof Omit<DailyTokensBySource, 'date' | 'total'>;
  source: string;
  color: string;
  name: string;
}

const SOURCES: SourceConfig[] = [
  { key: 'cursor', source: Source.Cursor, color: getSourceInfo(Source.Cursor).color, name: 'Cursor' },
  { key: 'claudeCode', source: Source.ClaudeCode, color: getSourceInfo(Source.ClaudeCode).color, name: 'Claude Code' },
  { key: 'codex', source: Source.Codex, color: getSourceInfo(Source.Codex).color, name: 'Codex' },
  { key: 'opencode', source: Source.OpenCode, color: getSourceInfo(Source.OpenCode).color, name: 'OpenCode' },
];

/**
 * Resample data to target length using linear interpolation
 */
function resample(data: number[], targetLength: number): number[] {
  if (data.length === 0) return [];
  if (data.length === 1) return new Array(targetLength).fill(data[0]);
  if (data.length === targetLength) return data;

  const result: number[] = [];
  const step = (data.length - 1) / (targetLength - 1);

  for (let i = 0; i < targetLength; i++) {
    const pos = i * step;
    const lower = Math.floor(pos);
    const upper = Math.min(Math.ceil(pos), data.length - 1);
    const t = pos - lower;

    result.push(data[lower]! * (1 - t) + data[upper]! * t);
  }

  return result;
}

/**
 * Render a sparkline from numeric data, scaled to its own max (not global)
 * This ensures each source's trend is visible regardless of absolute values
 */
function renderSparkline(data: number[], width: number): string {
  if (data.length === 0) return ' '.repeat(width);

  // Resample to target width
  const resampled = data.length === width ? data : resample(data, width);

  const max = Math.max(...resampled);
  if (max === 0) return '▁'.repeat(width); // Show flat line for zero data

  return resampled.map(value => {
    const normalized = value / max;
    const index = Math.min(Math.floor(normalized * BLOCKS.length), BLOCKS.length - 1);
    return BLOCKS[Math.max(0, index)];
  }).join('');
}

/**
 * Calculate trend direction and percentage change
 */
function getTrend(data: number[]): { direction: 'up' | 'down' | 'flat'; percent: number } {
  // Filter to only non-zero values for trend calculation
  const nonZero = data.filter(v => v > 0);
  if (nonZero.length < 2) return { direction: 'flat', percent: 0 };

  const mid = Math.floor(nonZero.length / 2);
  const firstHalf = nonZero.slice(0, mid);
  const secondHalf = nonZero.slice(mid);

  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const diff = secondAvg - firstAvg;
  const threshold = Math.max(firstAvg, secondAvg) * 0.1;

  const percent = firstAvg > 0 ? Math.round((diff / firstAvg) * 100) : 0;

  if (diff > threshold) return { direction: 'up', percent: Math.abs(percent) };
  if (diff < -threshold) return { direction: 'down', percent: Math.abs(percent) };
  return { direction: 'flat', percent: 0 };
}

/**
 * Format date for axis display (e.g., "Dec 01")
 */
function formatAxisDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
}

/**
 * SourceTokenTrend - renders token usage over time broken down by source
 * Each source gets its own row with label, sparkline, total, and trend
 */
export function SourceTokenTrend({
  data,
  width,
  showLegend = true,
  showDateAxis = true,
}: SourceTokenTrendProps) {
  if (data.length === 0) {
    return <Text dimColor>No token data available</Text>;
  }

  // Calculate totals for each source
  const sourceTotals = {
    cursor: data.reduce((sum, d) => sum + d.cursor, 0),
    claudeCode: data.reduce((sum, d) => sum + d.claudeCode, 0),
    codex: data.reduce((sum, d) => sum + d.codex, 0),
    opencode: data.reduce((sum, d) => sum + d.opencode, 0),
  };

  // Only show sources with activity, sorted by total tokens descending
  const activeSources = SOURCES
    .filter(s => sourceTotals[s.key] > 0)
    .sort((a, b) => sourceTotals[b.key] - sourceTotals[a.key]);

  if (activeSources.length === 0) {
    return <Text dimColor>No token data for any source</Text>;
  }

  // Layout: [Label 13] [Sparkline] [Total 8] [Trend 8]
  const labelWidth = 13;
  const totalWidth = 8;
  const trendWidth = 8;
  const sparklineWidth = Math.max(20, width - labelWidth - totalWidth - trendWidth - 4);

  // Get date range for axis
  const firstDate = data[0]?.date || '';
  const lastDate = data[data.length - 1]?.date || '';

  return (
    <Box flexDirection="column">
      {/* Column headers */}
      <Box marginBottom={0}>
        <Text dimColor>{'Source'.padEnd(labelWidth)}</Text>
        <Text dimColor>{'Activity'.padEnd(sparklineWidth)}</Text>
        <Text dimColor>{'Total'.padStart(totalWidth)}</Text>
        <Text dimColor>{'Trend'.padStart(trendWidth)}</Text>
      </Box>

      {/* Source rows with spacing */}
      {activeSources.map((source, idx) => {
        const sourceData = data.map(d => d[source.key]);
        const sparkline = renderSparkline(sourceData, sparklineWidth);
        const total = sourceTotals[source.key];
        const trend = getTrend(sourceData);
        const trendChar = trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '';
        const trendColor = trend.direction === 'up' ? 'green' : trend.direction === 'down' ? 'red' : 'gray';

        return (
          <Box key={source.key} marginTop={idx === 0 ? 0 : 0}>
            <Text color={source.color}>{source.name.padEnd(labelWidth)}</Text>
            <Text color={source.color}>{sparkline}</Text>
            <Text dimColor> {formatLargeNumber(total).padStart(totalWidth - 1)}</Text>
            {trend.direction !== 'flat' ? (
              <Text color={trendColor}> {trendChar}{String(trend.percent).padStart(3)}%</Text>
            ) : (
              <Text dimColor>{''.padEnd(trendWidth)}</Text>
            )}
          </Box>
        );
      })}

      {/* Date axis */}
      {showDateAxis && firstDate && lastDate && (
        <Box marginTop={0}>
          <Text dimColor>{''.padEnd(labelWidth)}</Text>
          <Text dimColor>{'└'}{formatAxisDate(firstDate)}</Text>
          <Text dimColor>{'─'.repeat(Math.max(0, sparklineWidth - 16))}</Text>
          <Text dimColor>{formatAxisDate(lastDate)}{'┘'}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Compact version showing stacked bar chart by day
 */
export function SourceTokenBars({
  data,
  width,
  maxBars = 14,
}: {
  data: DailyTokensBySource[];
  width: number;
  maxBars?: number;
}) {
  if (data.length === 0) {
    return <Text dimColor>No token data available</Text>;
  }

  // Take the most recent N days
  const recentData = data.slice(-maxBars);

  // Find max total for scaling
  const maxTotal = Math.max(...recentData.map(d => d.total), 1);

  // Calculate bar height (in block characters)
  const maxHeight = 6;

  // Bar width calculation
  const barSpacing = 1;
  const availableWidth = width - 15; // Leave room for labels
  const barWidth = Math.max(1, Math.floor(availableWidth / recentData.length) - barSpacing);

  // Render each row from top to bottom
  const rows: React.ReactNode[] = [];

  for (let row = maxHeight - 1; row >= 0; row--) {
    const threshold = (row / maxHeight) * maxTotal;

    rows.push(
      <Box key={row}>
        <Text dimColor>{''.padEnd(2)}</Text>
        {recentData.map((day, idx) => {
          // Determine which source(s) are at this height level
          let cumulative = 0;
          let char = ' ';
          let color = 'gray';

          for (const source of SOURCES) {
            const value = day[source.key];
            if (cumulative + value > threshold && cumulative <= threshold) {
              char = '█';
              color = source.color;
              break;
            }
            cumulative += value;
          }

          // If total exceeds threshold, show bar
          if (day.total > threshold) {
            return (
              <Text key={idx} color={color}>
                {char.repeat(barWidth)}
                {' '.repeat(barSpacing)}
              </Text>
            );
          }
          return (
            <Text key={idx} dimColor>
              {' '.repeat(barWidth + barSpacing)}
            </Text>
          );
        })}
      </Box>
    );
  }

  // Date labels (show first and last)
  const firstDate = recentData[0]?.date;
  const lastDate = recentData[recentData.length - 1]?.date;

  return (
    <Box flexDirection="column">
      {rows}
      <Box>
        <Text dimColor>{''.padEnd(2)}</Text>
        <Text dimColor>{'─'.repeat(Math.min(availableWidth, recentData.length * (barWidth + barSpacing)))}</Text>
      </Box>
      {firstDate && lastDate && (
        <Box>
          <Text dimColor>{''.padEnd(2)}</Text>
          <Text dimColor>{formatAxisDate(firstDate)}</Text>
          <Text dimColor>{''.padEnd(Math.max(0, recentData.length * (barWidth + barSpacing) - 14))}</Text>
          <Text dimColor>{formatAxisDate(lastDate)}</Text>
        </Box>
      )}
    </Box>
  );
}
