import React from 'react';
import { Box, Text } from 'ink';
import { HighlightedText } from './HighlightedText';
import {
  formatRelativeTime,
  formatMatchCount,
  truncatePath,
  formatTokenPair,
  formatLineCounts,
  formatSourceLabel,
} from '../../utils/format';
import type { ConversationResult } from '../../schema/index';
import type { FileSearchMatch } from '../../db/repository';

export interface ResultRowProps {
  result: ConversationResult;
  isSelected: boolean;
  width: number;
  query: string;
  fileMatches?: FileSearchMatch[];
  index?: number;
}

/**
 * A single search result row showing conversation title, metadata, and snippet
 */
export function ResultRow({
  result,
  isSelected,
  width,
  query,
  fileMatches,
  index,
}: ResultRowProps) {
  const { conversation, bestMatch, totalMatches } = result;

  const timeStr = formatRelativeTime(conversation.updatedAt);
  const matchStr = formatMatchCount(totalMatches);

  // Format index with consistent width (right-aligned)
  const indexStr = index !== undefined ? `${index + 1}.` : '';
  const indexWidth = index !== undefined ? 4 : 0; // "999." max
  const contentWidth = width - indexWidth - (indexWidth > 0 ? 1 : 0);

  // Calculate available width for title
  const prefixWidth = indexWidth + (indexWidth > 0 ? 1 : 0);
  const timeWidth = timeStr.length + matchStr.length + 5;
  const maxTitleWidth = Math.max(20, width - prefixWidth - timeWidth - 4);

  const title = conversation.title.length > maxTitleWidth
    ? conversation.title.slice(0, maxTitleWidth - 1) + '…'
    : conversation.title;

  // Build row 2 metadata parts for colored display
  const sourceName = formatSourceLabel(conversation.source);
  const tokenStr = formatTokenPair(
    conversation.totalInputTokens,
    conversation.totalOutputTokens,
    conversation.totalCacheCreationTokens,
    conversation.totalCacheReadTokens
  );
  const lineStr = formatLineCounts(
    conversation.totalLinesAdded,
    conversation.totalLinesRemoved
  );

  // Calculate how much space we have for the path
  const fixedPartsLen = sourceName.length +
    (tokenStr ? ` · ${tokenStr}`.length : 0) +
    (lineStr ? ` · ${lineStr}`.length : 0);
  const availableForPath = contentWidth - fixedPartsLen - 10; // Leave some buffer

  const pathStr = conversation.workspacePath
    ? truncatePath(conversation.workspacePath, Math.max(15, availableForPath))
    : null;

  // Snippet - truncate to fit width
  const snippetContent = bestMatch.snippet.replace(/\n/g, ' ').trim();
  const snippetMaxWidth = Math.max(20, contentWidth - 2);
  const snippetText = snippetContent.length > snippetMaxWidth
    ? snippetContent.slice(0, snippetMaxWidth - 1) + '…'
    : snippetContent;

  // Format file matches display - truncate to fit
  const hasFileMatches = fileMatches && fileMatches.length > 0;
  let fileMatchDisplay = '';
  if (hasFileMatches) {
    fileMatchDisplay = 'Files: ' + fileMatches
      .slice(0, 3)
      .map((m) => m.filePath.split('/').pop())
      .join(', ') + (fileMatches.length > 3 ? ` +${fileMatches.length - 3}` : '');
    if (fileMatchDisplay.length > contentWidth - 2) {
      fileMatchDisplay = fileMatchDisplay.slice(0, contentWidth - 3) + '…';
    }
  }

  return (
    <Box flexDirection="column">
      {/* Row 1: Index + Title + Match count + Time */}
      <Box width={width}>
        {index !== undefined && (
          <Text color={isSelected ? 'cyan' : 'gray'}>{indexStr.padStart(indexWidth)} </Text>
        )}
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected} underline={isSelected}>{title}</Text>
        <Box flexGrow={1} />
        <Text bold color="yellow">{matchStr}</Text>
        <Text color="gray"> · {timeStr}</Text>
      </Box>
      {/* Row 2: Source + workspace path + tokens + lines */}
      <Box marginLeft={indexWidth + (indexWidth > 0 ? 1 : 0)}>
        <Text color="yellow">{sourceName}</Text>
        {pathStr && <Text color="magenta"> · {pathStr}</Text>}
        {tokenStr && <Text color="cyan"> · {tokenStr}</Text>}
        {lineStr && <Text color="gray"> · {lineStr}</Text>}
      </Box>
      {/* Row 3: Snippet or file matches */}
      <Box marginLeft={indexWidth + (indexWidth > 0 ? 1 : 0)}>
        {hasFileMatches ? (
          <Text color="gray">{fileMatchDisplay}</Text>
        ) : (
          <HighlightedText text={snippetText} query={query} />
        )}
      </Box>
    </Box>
  );
}
