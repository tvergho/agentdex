/**
 * ActivityHeatmap component - GitHub-style contribution heatmap
 * Uses Unicode block characters to show activity intensity
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DayActivity } from '../../db/analytics';

// Intensity blocks from empty to full
const BLOCKS = [' ', '░', '▒', '▓', '█'];

// Day of week labels (starting Sunday)
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export interface ActivityHeatmapProps {
  data: DayActivity[];
  weeks?: number;
  width: number;
  metric?: 'conversations' | 'messages' | 'tokens';
  showLegend?: boolean;
}

/**
 * Generate a complete date range for the heatmap
 */
function generateDateRange(weeks: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Start from the most recent Sunday
  const currentDay = today.getDay();
  const endDate = new Date(today);

  // Go back to fill in the weeks
  const totalDays = weeks * 7;
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - totalDays + 1);

  // Adjust to start on Sunday
  const startDay = startDate.getDay();
  if (startDay !== 0) {
    startDate.setDate(startDate.getDate() - startDay);
  }

  // Generate all dates
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(current.toISOString().split('T')[0]!);
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

/**
 * Get the value to display based on selected metric
 */
function getMetricValue(activity: DayActivity | undefined, metric: string): number {
  if (!activity) return 0;
  switch (metric) {
    case 'conversations':
      return activity.conversations;
    case 'messages':
      return activity.messages;
    case 'tokens':
      return activity.tokens;
    default:
      return activity.conversations;
  }
}

/**
 * Map value to intensity level (0-4)
 */
function getIntensity(value: number, maxValue: number): number {
  if (value === 0 || maxValue === 0) return 0;
  const normalized = value / maxValue;
  // Use quartiles for intensity
  if (normalized >= 0.75) return 4;
  if (normalized >= 0.5) return 3;
  if (normalized >= 0.25) return 2;
  return 1;
}

/**
 * Render GitHub-style activity heatmap
 */
export function ActivityHeatmap({
  data,
  weeks = 12,
  width,
  metric = 'conversations',
  showLegend = true,
}: ActivityHeatmapProps) {
  // Create a map for quick lookup
  const activityMap = new Map<string, DayActivity>();
  for (const day of data) {
    activityMap.set(day.date, day);
  }

  // Generate date range
  const dates = generateDateRange(weeks);

  // Find max value for scaling
  let maxValue = 0;
  for (const date of dates) {
    const value = getMetricValue(activityMap.get(date), metric);
    maxValue = Math.max(maxValue, value);
  }

  // Build grid: rows = days of week (7), cols = weeks
  const grid: number[][] = [];
  for (let day = 0; day < 7; day++) {
    grid[day] = [];
  }

  for (let i = 0; i < dates.length; i++) {
    const date = new Date(dates[i]!);
    const dayOfWeek = date.getDay();
    const value = getMetricValue(activityMap.get(dates[i]!), metric);
    const intensity = getIntensity(value, maxValue);
    grid[dayOfWeek]!.push(intensity);
  }

  // Ensure all rows have same length (pad with 0)
  const numWeeks = Math.ceil(dates.length / 7);
  for (let day = 0; day < 7; day++) {
    while (grid[day]!.length < numWeeks) {
      grid[day]!.push(0);
    }
  }

  // Calculate which weeks we can show given width
  const labelWidth = 2; // "S ", "M ", etc.
  const availableWidth = width - labelWidth;
  const displayWeeks = Math.min(numWeeks, availableWidth);
  const startWeek = Math.max(0, numWeeks - displayWeeks);

  return (
    <Box flexDirection="column">
      {/* Grid */}
      {grid.map((row, dayIdx) => (
        <Box key={dayIdx}>
          <Text dimColor>{DAY_LABELS[dayIdx]} </Text>
          <Text>
            {row.slice(startWeek).map((intensity, weekIdx) => (
              <Text key={weekIdx} color={intensity > 0 ? 'green' : 'gray'}>
                {BLOCKS[intensity]}
              </Text>
            ))}
          </Text>
        </Box>
      ))}

      {/* Legend */}
      {showLegend && (
        <Box marginTop={1}>
          <Text dimColor>Less </Text>
          {BLOCKS.map((block, idx) => (
            <Text key={idx} color={idx > 0 ? 'green' : 'gray'}>
              {block}
            </Text>
          ))}
          <Text dimColor> More</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Simple hour-of-day activity chart (24-hour bar)
 */
export interface HourlyActivityProps {
  data: number[];
  width: number;
  color?: string;
}

export function HourlyActivity({ data, width, color = 'cyan' }: HourlyActivityProps) {
  if (data.length !== 24) {
    return <Text dimColor>Invalid hourly data</Text>;
  }

  const max = Math.max(...data);
  if (max === 0) {
    return <Text dimColor>No activity data</Text>;
  }

  // Build hour bar
  const bar = data.map(value => {
    const intensity = Math.round((value / max) * 4);
    return BLOCKS[intensity];
  }).join('');

  // Hour labels
  const hours = '0     6     12    18   23';

  return (
    <Box flexDirection="column">
      <Text color={color}>{bar}</Text>
      <Text dimColor>{hours}</Text>
    </Box>
  );
}

/**
 * Day-of-week activity chart (7-day bar)
 */
export interface WeeklyActivityProps {
  data: number[];
  width: number;
  color?: string;
}

export function WeeklyActivity({ data, width, color = 'cyan' }: WeeklyActivityProps) {
  if (data.length !== 7) {
    return <Text dimColor>Invalid weekly data</Text>;
  }

  const max = Math.max(...data);
  if (max === 0) {
    return <Text dimColor>No activity data</Text>;
  }

  return (
    <Box flexDirection="column">
      {DAY_LABELS.map((label, idx) => {
        const value = data[idx]!;
        const barWidth = max > 0 ? Math.round((value / max) * (width - 4)) : 0;
        const bar = '█'.repeat(Math.max(0, barWidth));

        return (
          <Box key={idx}>
            <Text dimColor>{label} </Text>
            <Text color={color}>{bar}</Text>
            {value > 0 && <Text dimColor> {value}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
