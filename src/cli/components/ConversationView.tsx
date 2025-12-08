import React from 'react';
import { Box, Text } from 'ink';
import {
  formatSourceInfo,
  truncatePath,
  formatPaginationInfo,
  formatFilesDisplay,
  formatMessageCount,
  getFileName,
  formatFileList,
  getRoleColor,
  getRoleLabel,
  formatTokenPair,
  getLineCountParts,
  formatRelativeTime,
  type CombinedMessage,
} from '../../utils/format';
import type { Conversation, ConversationFile, MessageFile } from '../../schema/index';

export interface ConversationViewProps {
  conversation: Conversation;
  messages: CombinedMessage[];
  files: ConversationFile[];
  messageFiles: MessageFile[];
  width: number;
  height: number;
  scrollOffset: number;
  highlightMessageIndex?: number;
  selectedIndex: number;
}

/**
 * Full conversation view with all messages
 */
export function ConversationView({
  conversation,
  messages,
  files,
  messageFiles,
  width,
  height,
  scrollOffset,
  highlightMessageIndex,
  selectedIndex,
}: ConversationViewProps) {
  const sourceInfo = formatSourceInfo(conversation.source, conversation.model);

  // Get file names
  const fileNames = files.slice(0, 5).map((f) => getFileName(f.filePath));

  // Header: title + project info + workspace path + files (optional) + message count + separator
  const headerHeight = 5 + (files.length > 0 ? 1 : 0);
  const availableHeight = height - headerHeight;
  const messagesPerPage = Math.max(1, Math.floor(availableHeight / 3));

  const visibleMessages = messages.slice(scrollOffset, scrollOffset + messagesPerPage);

  // Always show pagination info when more than 1 message
  const paginationInfo = messages.length > 0
    ? formatPaginationInfo(scrollOffset, messagesPerPage, messages.length)
    : '';

  // Build workspace display - always show something
  const workspaceDisplay = conversation.workspacePath
    ? truncatePath(conversation.workspacePath, width - sourceInfo.length - 7)
    : '';

  // Format conversation-level token totals
  const tokenTotals = formatTokenPair(
    conversation.totalInputTokens,
    conversation.totalOutputTokens,
    conversation.totalCacheCreationTokens,
    conversation.totalCacheReadTokens
  );

  // Format conversation-level line counts
  const lineCountTotals = getLineCountParts(
    conversation.totalLinesAdded,
    conversation.totalLinesRemoved
  );

  return (
    <Box flexDirection="column" height={height}>
      {/* Fixed header - always same structure */}
      <Box flexDirection="column">
        <Text bold color="cyan">{conversation.title}</Text>
        <Text>
          <Text color="yellow">{sourceInfo}</Text>
          {workspaceDisplay && <Text color="gray"> · </Text>}
          <Text color="magenta">{workspaceDisplay}</Text>
          {conversation.createdAt && (
            <>
              <Text color="gray"> · </Text>
              <Text color="gray">{formatRelativeTime(conversation.createdAt)}</Text>
            </>
          )}
        </Text>
        <Text color="gray">
          {formatFilesDisplay(fileNames, files.length)}
        </Text>
        <Text>
          <Text color="gray">{formatMessageCount(messages.length)} · {paginationInfo}</Text>
          {conversation.compactCount && conversation.compactCount > 0 && (
            <Text color="yellow"> · ⟳{conversation.compactCount} compacted</Text>
          )}
          {tokenTotals && <Text color="cyan"> · {tokenTotals}</Text>}
          {lineCountTotals && (
            <>
              <Text color="gray"> · </Text>
              <Text color="green">{lineCountTotals.added}</Text>
              <Text color="gray"> / </Text>
              <Text color="red">{lineCountTotals.removed}</Text>
            </>
          )}
        </Text>
        <Text color="gray">{'─'.repeat(Math.max(0, width))}</Text>
      </Box>

      {/* Messages - fixed height per message */}
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {visibleMessages.map((msg, idx) => {
          const actualIdx = scrollOffset + idx;
          const isHighlighted = actualIdx === highlightMessageIndex;
          const isSelected = actualIdx === selectedIndex;
          const isCompactSummary = msg.isCompactSummary;

          // For compact summaries, show special styling
          const roleLabel = isCompactSummary ? '📋 Summary' : getRoleLabel(msg.role);
          const roleColor = isCompactSummary ? 'yellow' : getRoleColor(msg.role);

          // Get files for all messages in this combined group
          const msgFiles = messageFiles.filter((f) => msg.messageIds.includes(f.messageId));
          const msgFileNames = msgFiles.map((f) => getFileName(f.filePath));

          const filesDisplay = formatFileList(msgFileNames, 2);

          // Format per-message tokens (only show for assistant messages)
          const msgTokens = msg.role === 'assistant'
            ? formatTokenPair(msg.inputTokens, msg.outputTokens, msg.cacheCreationTokens, msg.cacheReadTokens)
            : '';

          // Format per-message line counts (only show for assistant messages with edits)
          const msgLineParts = msg.role === 'assistant'
            ? getLineCountParts(msg.totalLinesAdded, msg.totalLinesRemoved)
            : null;

          // Truncate messages to ~1 line for readable view
          const maxLen = width - 5;
          const truncatedContent = msg.content.replace(/\n/g, ' ').slice(0, maxLen);
          const isTruncated = msg.content.length > maxLen;
          const totalLines = msg.content.split('\n').length;

          // Determine visual state
          const showIndicator = isSelected || isHighlighted;

          return (
            <Box
              key={msg.messageIds[0]}
              flexDirection="column"
              height={isCompactSummary ? 4 : 3}
            >
              {/* Compact separator line before compact summary messages */}
              {isCompactSummary && (
                <Text color="yellow">{'─'.repeat(Math.floor(width * 0.3))} ⟳ CONTEXT COMPACTED {'─'.repeat(Math.floor(width * 0.3))}</Text>
              )}
              <Box>
                <Text backgroundColor={isSelected ? 'cyan' : isHighlighted ? 'yellow' : undefined} color={showIndicator ? 'black' : undefined}>
                  {isSelected ? ' ▸ ' : isHighlighted ? ' ★ ' : '   '}
                </Text>
                <Box width={isCompactSummary ? 16 : 14}>
                  <Text color={roleColor} bold>
                    {roleLabel}
                  </Text>
                  {!isCompactSummary && <Text color="gray"> #{msg.combinedIndex + 1}</Text>}
                </Box>
                {filesDisplay && (
                  <Text color="gray" wrap="truncate"> ({filesDisplay})</Text>
                )}
                {msgTokens && (
                  <Text color="cyan"> · {msgTokens}</Text>
                )}
                {msgLineParts && (
                  <Text color="gray"> · <Text color="green">{msgLineParts.added}</Text> / <Text color="red">{msgLineParts.removed}</Text></Text>
                )}
                {isHighlighted && !isSelected && (
                  <Text color="yellow"> matched</Text>
                )}
              </Box>
              <Box marginLeft={3}>
                <Text bold={isSelected || isHighlighted} color={isCompactSummary ? 'yellow' : undefined} wrap="truncate">
                  {truncatedContent}
                  {isTruncated && <Text color="gray"> ({totalLines} lines)</Text>}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
