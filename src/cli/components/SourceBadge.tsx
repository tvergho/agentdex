import React from 'react';
import { Text } from 'ink';
import { getSourceInfo } from '../../schema/index';

export interface SourceBadgeProps {
  source: string;
}

/**
 * Source badge with consistent colors across the app.
 * Shows full source name with source-specific color.
 */
export function SourceBadge({ source }: SourceBadgeProps) {
  const info = getSourceInfo(source);

  return (
    <Text color={info.color}>{info.name}</Text>
  );
}

/**
 * Get the color for a source (useful for other components)
 */
export function getSourceColor(source: string): string {
  return getSourceInfo(source).color;
}
