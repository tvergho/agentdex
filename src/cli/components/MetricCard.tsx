/**
 * MetricCard component - displays a labeled metric with value
 * Used for overview stats, totals, etc.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface MetricCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  color?: string;
  width?: number;
}

/**
 * Render a single metric with label and value
 */
export function MetricCard({
  label,
  value,
  subValue,
  color = 'cyan',
  width,
}: MetricCardProps) {
  return (
    <Box flexDirection="column" width={width}>
      <Text dimColor>{label}</Text>
      <Text color={color} bold>{value}</Text>
      {subValue && <Text dimColor>{subValue}</Text>}
    </Box>
  );
}

export interface MetricRowProps {
  metrics: MetricCardProps[];
  width: number;
  spacing?: number;
}

/**
 * Render a row of metrics evenly distributed
 */
export function MetricRow({ metrics, width, spacing = 2 }: MetricRowProps) {
  const metricWidth = Math.floor((width - spacing * (metrics.length - 1)) / metrics.length);

  return (
    <Box>
      {metrics.map((metric, idx) => (
        <Box key={idx} marginRight={idx < metrics.length - 1 ? spacing : 0}>
          <MetricCard {...metric} width={metricWidth} />
        </Box>
      ))}
    </Box>
  );
}

/**
 * Format a large number for display (e.g., 1234567 -> "1.2M")
 */
export function formatLargeNumber(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return String(value);
}

/**
 * Format token counts for display
 */
export function formatTokenDisplay(input: number, output: number): string {
  return `${formatLargeNumber(input)} in / ${formatLargeNumber(output)} out`;
}

/**
 * Format line counts for display
 */
export function formatLinesDisplay(added: number, removed: number): string {
  return `+${formatLargeNumber(added)} / -${formatLargeNumber(removed)}`;
}
