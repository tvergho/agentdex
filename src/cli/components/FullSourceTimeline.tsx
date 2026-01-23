/**
 * FullSourceTimeline component - full-height stacked bar chart for token usage over time
 * Shows all sources with proper Y-axis scale and X-axis date labels
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DailyTokensBySource } from '../../db/analytics';
import { Source, getSourceInfo } from '../../schema/index';
import { formatLargeNumber } from './MetricCard';

const BLOCK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const FULL_BLOCK = '█';

export interface FullSourceTimelineProps {
  data: DailyTokensBySource[];
  width: number;
  height: number;
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
 * Format date for axis display (e.g., "Jan", "Feb 15")
 */
function formatAxisDate(dateStr: string, includeDay = false): string {
  const date = new Date(dateStr);
  if (includeDay) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { month: 'short' });
}

/**
 * Calculate trend direction and percentage change
 */
function getTrend(data: number[]): { direction: 'up' | 'down' | 'flat'; percent: number } {
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
 * FullSourceTimeline - renders a full-height stacked bar chart of token usage by source
 */
export function FullSourceTimeline({
  data,
  width,
  height,
}: FullSourceTimelineProps) {
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

  const grandTotal = sourceTotals.cursor + sourceTotals.claudeCode + sourceTotals.codex + sourceTotals.opencode;

  // Filter to active sources (with any tokens), sorted by total descending
  const activeSources = SOURCES
    .filter(s => sourceTotals[s.key] > 0)
    .sort((a, b) => sourceTotals[b.key] - sourceTotals[a.key]);

  // Layout calculations
  const yAxisWidth = 8; // "100.0M │"
  const legendHeight = activeSources.length + 2; // Legend lines + spacing
  const xAxisHeight = 2; // Date labels
  const chartHeight = Math.max(8, height - legendHeight - xAxisHeight - 4);
  const chartWidth = Math.max(20, width - yAxisWidth - 4);

  // Find max daily total for Y-axis scaling
  const dailyTotals = data.map(d => d.cursor + d.claudeCode + d.codex + d.opencode);
  const maxDailyTotal = Math.max(...dailyTotals, 1);

  // Resample data to chart width
  const resampledTotals = data.length === chartWidth ? dailyTotals : resample(dailyTotals, chartWidth);
  const resampledBySource: Record<string, number[]> = {};
  for (const source of SOURCES) {
    const sourceData = data.map(d => d[source.key]);
    resampledBySource[source.key] = data.length === chartWidth ? sourceData : resample(sourceData, chartWidth);
  }

  // Calculate Y-axis labels (show 5 labels: 0, 25%, 50%, 75%, 100%)
  const yLabels: { value: number; row: number }[] = [];
  const labelCount = Math.min(5, chartHeight);
  for (let i = 0; i < labelCount; i++) {
    const row = Math.floor((i / (labelCount - 1)) * (chartHeight - 1));
    const value = maxDailyTotal * (1 - i / (labelCount - 1));
    yLabels.push({ value, row });
  }

  // Build X-axis date markers (show ~6 dates spread across the timeline)
  const xLabels: { date: string; col: number }[] = [];
  const numLabels = Math.min(6, data.length);
  for (let i = 0; i < numLabels; i++) {
    const dataIndex = Math.floor((i / (numLabels - 1)) * (data.length - 1));
    const col = Math.floor((i / (numLabels - 1)) * (chartWidth - 1));
    xLabels.push({ date: data[dataIndex]?.date || '', col });
  }

  // Render chart rows from top to bottom
  const chartRows: React.ReactNode[] = [];

  for (let row = 0; row < chartHeight; row++) {
    const threshold = maxDailyTotal * (1 - row / chartHeight);
    const nextThreshold = maxDailyTotal * (1 - (row + 1) / chartHeight);

    // Y-axis label for this row
    const yLabel = yLabels.find(l => l.row === row);
    const yLabelStr = yLabel ? formatLargeNumber(yLabel.value).padStart(yAxisWidth - 2) + ' │' : ' '.repeat(yAxisWidth - 1) + '│';

    // Build the row content
    const rowChars: { char: string; color: string }[] = [];

    for (let col = 0; col < chartWidth; col++) {
      const total = resampledTotals[col] || 0;

      if (total <= nextThreshold) {
        // Below this row entirely
        rowChars.push({ char: ' ', color: 'gray' });
      } else if (total > threshold) {
        // Find which source contributes to this row (stacked from bottom)
        let cumulative = 0;
        let foundSource: SourceConfig | null = null;

        // Stack sources in reverse order (highest total at bottom)
        const sortedSources = [...activeSources].reverse();
        for (const source of sortedSources) {
          const sourceVal = resampledBySource[source.key]?.[col] || 0;
          const sourceTop = cumulative + sourceVal;

          if (sourceTop > nextThreshold && cumulative < threshold) {
            foundSource = source;
            break;
          }
          cumulative += sourceVal;
        }

        if (foundSource) {
          rowChars.push({ char: FULL_BLOCK, color: foundSource.color });
        } else {
          // Fallback: use the dominant source at this point
          const dominantSource = activeSources[0];
          rowChars.push({ char: FULL_BLOCK, color: dominantSource?.color || 'gray' });
        }
      } else {
        // Partial block (top of bar)
        const fraction = (total - nextThreshold) / (threshold - nextThreshold);
        const blockIndex = Math.min(Math.floor(fraction * BLOCK_CHARS.length), BLOCK_CHARS.length - 1);

        // Find the source at the top of the stack
        let cumulative = 0;
        let topSource: SourceConfig | null = null;
        const sortedSources = [...activeSources].reverse();
        for (const source of sortedSources) {
          const sourceVal = resampledBySource[source.key]?.[col] || 0;
          cumulative += sourceVal;
          topSource = source;
        }

        rowChars.push({ char: BLOCK_CHARS[blockIndex] || '▁', color: topSource?.color || 'gray' });
      }
    }

    chartRows.push(
      <Box key={row}>
        <Text dimColor>{yLabelStr}</Text>
        {rowChars.map((c, i) => (
          <Text key={i} color={c.color}>{c.char}</Text>
        ))}
      </Box>
    );
  }

  // X-axis line
  const xAxisLine = '─'.repeat(chartWidth);

  // X-axis labels
  const xAxisLabelRow = ' '.repeat(chartWidth).split('');
  for (const label of xLabels) {
    const dateStr = formatAxisDate(label.date, true);
    const startCol = Math.max(0, Math.min(label.col, chartWidth - dateStr.length));
    for (let i = 0; i < dateStr.length && startCol + i < chartWidth; i++) {
      xAxisLabelRow[startCol + i] = dateStr[i]!;
    }
  }

  return (
    <Box flexDirection="column">
      {/* Legend at top */}
      <Box flexDirection="column" marginBottom={1}>
        <Box marginBottom={0}>
          <Text bold color="white">Token Usage Timeline</Text>
          <Text dimColor> · </Text>
          <Text dimColor>Total: </Text>
          <Text color="cyan" bold>{formatLargeNumber(grandTotal)}</Text>
        </Box>

        {/* Source legend with totals and trends */}
        <Box flexWrap="wrap">
          {activeSources.map((source, idx) => {
            const total = sourceTotals[source.key];
            const percent = grandTotal > 0 ? Math.round((total / grandTotal) * 100) : 0;
            const sourceData = data.map(d => d[source.key]);
            const trend = getTrend(sourceData);
            const trendChar = trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '─';
            const trendColor = trend.direction === 'up' ? 'green' : trend.direction === 'down' ? 'red' : 'gray';

            return (
              <Box key={source.key} marginRight={3}>
                <Text color={source.color}>{FULL_BLOCK} </Text>
                <Text color={source.color} bold>{source.name}</Text>
                <Text dimColor>: </Text>
                <Text>{formatLargeNumber(total)}</Text>
                <Text dimColor> ({percent}%) </Text>
                <Text color={trendColor}>{trendChar}{trend.percent > 0 ? `${trend.percent}%` : ''}</Text>
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* Chart */}
      {chartRows}

      {/* X-axis */}
      <Box>
        <Text dimColor>{' '.repeat(yAxisWidth - 1)}└</Text>
        <Text dimColor>{xAxisLine}</Text>
      </Box>
      <Box>
        <Text dimColor>{' '.repeat(yAxisWidth)}</Text>
        <Text dimColor>{xAxisLabelRow.join('')}</Text>
      </Box>
    </Box>
  );
}
