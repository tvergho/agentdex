import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import {
  formatPaginationInfo,
  getFileName,
  getRoleColor,
  getRoleLabel,
  renderMarkdownContent,
  parseToolOutputsFromContent,
  renderSegmentsWithCollapse,
  type CombinedMessage,
  type ToolOutputBlock,
  type ContentSegment,
} from '../../utils/format';
import type { MessageFile } from '../../schema/index';

export interface MessageDetailViewProps {
  message: CombinedMessage;
  messageFiles: MessageFile[];
  /** Parsed tool output blocks (from useNavigation) */
  toolOutputBlocks: ToolOutputBlock[];
  /** Content segments (text and tool references interleaved) */
  contentSegments: ContentSegment[];
  /** Which tool output indices are expanded */
  expandedToolIndices: Set<number>;
  /** Which tool is currently focused (for > indicator) */
  focusedToolIndex: number | null;
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
  toolOutputBlocks,
  contentSegments,
  expandedToolIndices,
  focusedToolIndex,
  width,
  height,
  scrollOffset,
}: MessageDetailViewProps) {
  const isCompactSummary = message.isCompactSummary;
  const roleLabel = isCompactSummary ? '📋 Context Summary' : getRoleLabel(message.role);
  const roleColor = isCompactSummary ? 'yellow' : getRoleColor(message.role);

  // Get file names for all messages in this combined group
  const fileNames = messageFiles
    .filter((f) => message.messageIds.includes(f.messageId))
    .map((f) => getFileName(f.filePath));

  // Build full content with collapsible tool outputs for assistant messages
  // Uses segments to preserve interleaved text between tool blocks
  const fullContent = useMemo(() => {
    if (message.role !== 'assistant' || toolOutputBlocks.length === 0) {
      return message.content;
    }
    // Use segments passed from useNavigation (already parsed)
    // If segments weren't passed, parse them ourselves
    const segments = contentSegments.length > 0
      ? contentSegments
      : parseToolOutputsFromContent(message.content).segments;
    return renderSegmentsWithCollapse(segments, toolOutputBlocks, expandedToolIndices, focusedToolIndex);
  }, [message.content, message.role, toolOutputBlocks, contentSegments, expandedToolIndices, focusedToolIndex]);

  // Render markdown to terminal-formatted string using shared function
  const renderedContent = useMemo(() => {
    return renderMarkdownContent(fullContent, width);
  }, [fullContent, width]);

  // Split rendered content into lines for scrolling
  const lines = renderedContent.split('\n');
  const headerHeight = 3; // Role label + line count + separator
  // Note: No footerHeight reservation - the parent component handles the footer
  const availableHeight = height - headerHeight;
  const visibleLines = lines.slice(scrollOffset, scrollOffset + availableHeight);

  const paginationInfo = formatPaginationInfo(scrollOffset, availableHeight, lines.length);

  // Tool indicator only when actively navigating tools
  const toolIndicator = focusedToolIndex !== null && toolOutputBlocks.length > 0
    ? ` · Tool ${focusedToolIndex + 1}/${toolOutputBlocks.length}`
    : '';

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column">
        {/* Compact summary header */}
        {isCompactSummary && (
          <Text color="yellow">{'─'.repeat(Math.floor(width * 0.3))} ⟳ CONTEXT COMPACTED {'─'.repeat(Math.floor(width * 0.3))}</Text>
        )}
        <Box>
          <Text color={roleColor} bold>{roleLabel}</Text>
          {!isCompactSummary && <Text color="gray"> #{message.combinedIndex + 1}</Text>}
          {fileNames.length > 0 && (
            <Text color="gray"> · {fileNames.join(', ')}</Text>
          )}
        </Box>
        <Box>
          <Text dimColor>
            {lines.length} lines · {paginationInfo}
          </Text>
          {toolIndicator && <Text color="cyan" bold>{toolIndicator}</Text>}
        </Box>
        <Text color="gray">{'─'.repeat(Math.max(0, width))}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        <Text>{visibleLines.join('\n')}</Text>
      </Box>
    </Box>
  );
}
