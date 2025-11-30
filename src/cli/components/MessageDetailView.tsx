import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import {
  formatPaginationInfo,
  getFileName,
  getRoleColor,
  getRoleLabel,
  renderMarkdownContent,
  type CombinedMessage,
} from '../../utils/format';
import type { MessageFile } from '../../schema/index';

export interface MessageDetailViewProps {
  message: CombinedMessage;
  messageFiles: MessageFile[];
  width: number;
  height: number;
  scrollOffset: number;
  query: string;
}

/**
 * Full message detail view for viewing untruncated message content
 * Renders markdown with syntax highlighting and formatting
 */
export function MessageDetailView({
  message,
  messageFiles,
  width,
  height,
  scrollOffset,
}: MessageDetailViewProps) {
  const roleLabel = getRoleLabel(message.role);
  const roleColor = getRoleColor(message.role);

  // Get file names for all messages in this combined group
  const fileNames = messageFiles
    .filter((f) => message.messageIds.includes(f.messageId))
    .map((f) => getFileName(f.filePath));

  // Render markdown to terminal-formatted string using shared function
  const renderedContent = useMemo(() => {
    return renderMarkdownContent(message.content, width);
  }, [message.content, width]);

  // Split rendered content into lines for scrolling
  const lines = renderedContent.split('\n');
  const headerHeight = 3; // Role label + line count + separator
  // Note: No footerHeight reservation - the parent component handles the footer
  const availableHeight = height - headerHeight;
  const visibleLines = lines.slice(scrollOffset, scrollOffset + availableHeight);

  const paginationInfo = formatPaginationInfo(scrollOffset, availableHeight, lines.length);

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column">
        <Box>
          <Text color={roleColor} bold>{roleLabel}</Text>
          <Text color="gray"> #{message.combinedIndex + 1}</Text>
          {fileNames.length > 0 && (
            <Text color="gray"> · {fileNames.join(', ')}</Text>
          )}
        </Box>
        <Text dimColor>
          {lines.length} lines · {paginationInfo}
        </Text>
        <Text color="gray">{'─'.repeat(Math.max(0, width))}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        <Text>{visibleLines.join('\n')}</Text>
      </Box>
    </Box>
  );
}
