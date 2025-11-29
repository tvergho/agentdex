/**
 * HorizontalBar component - renders labeled horizontal bar charts
 * Used for showing proportional comparisons (sources, models, etc.)
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface BarItem {
  label: string;
  value: number;
  color?: string;
}

export interface HorizontalBarProps {
  items: BarItem[];
  width: number;
  showValues?: boolean;
  maxLabelWidth?: number;
  barChar?: string;
}

/**
 * Format a large number for compact display
 */
function formatCompact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(value);
}

/**
 * Render horizontal bar chart with labels
 */
export function HorizontalBar({
  items,
  width,
  showValues = true,
  maxLabelWidth = 15,
  barChar = '█',
}: HorizontalBarProps) {
  if (items.length === 0) {
    return <Text dimColor>No data</Text>;
  }

  const maxValue = Math.max(...items.map(i => i.value));
  if (maxValue === 0) {
    return <Text dimColor>No data</Text>;
  }

  // Calculate available space for bars
  // Layout: "label   ████████ value"
  const valueWidth = showValues ? 8 : 0;
  const padding = 2;
  const barWidth = Math.max(10, width - maxLabelWidth - valueWidth - padding);

  return (
    <Box flexDirection="column">
      {items.map((item, idx) => {
        const proportion = item.value / maxValue;
        const filledWidth = Math.max(1, Math.round(proportion * barWidth));
        const bar = barChar.repeat(filledWidth);

        // Truncate and pad label
        const label = item.label.length > maxLabelWidth
          ? item.label.slice(0, maxLabelWidth - 1) + '…'
          : item.label.padEnd(maxLabelWidth);

        return (
          <Box key={idx}>
            <Text>{label}</Text>
            <Text color={item.color || 'cyan'}>{bar}</Text>
            {showValues && (
              <Text dimColor> {formatCompact(item.value).padStart(6)}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Render a single progress bar (useful for percentages)
 */
export interface ProgressBarProps {
  value: number;    // 0-1
  width: number;
  color?: string;
  showPercent?: boolean;
  filledChar?: string;
  emptyChar?: string;
}

export function ProgressBar({
  value,
  width,
  color = 'cyan',
  showPercent = true,
  filledChar = '█',
  emptyChar = '░',
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const percentWidth = showPercent ? 5 : 0;
  const barWidth = Math.max(5, width - percentWidth - 1);

  const filledWidth = Math.round(clamped * barWidth);
  const emptyWidth = barWidth - filledWidth;

  const filled = filledChar.repeat(filledWidth);
  const empty = emptyChar.repeat(emptyWidth);

  return (
    <Text>
      <Text color={color}>{filled}</Text>
      <Text dimColor>{empty}</Text>
      {showPercent && <Text dimColor> {(clamped * 100).toFixed(0).padStart(3)}%</Text>}
    </Text>
  );
}
