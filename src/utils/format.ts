/**
 * Shared formatting utilities for consistent display across the CLI
 */

import { getSourceInfo } from '../schema/index';
import { marked, type MarkedExtension } from 'marked';
import { markedTerminal } from 'marked-terminal';

/**
 * Format a date as a human-readable relative time string
 */
export function formatRelativeTime(isoDate: string | undefined): string {
  if (!isoDate) return '';

  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

/**
 * Capitalize the first letter of a source name (e.g., "cursor" -> "Cursor")
 */
export function formatSourceName(source: string): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

/**
 * Format source name for display with proper capitalization
 * (e.g., "claude-code" -> "Claude Code", "codex" -> "Codex")
 */
export function formatSourceLabel(source: string): string {
  return getSourceInfo(source).name;
}

/**
 * Truncate a path from the left, preserving the end with an ellipsis prefix
 */
export function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  return '…' + path.slice(-(maxLen - 1));
}

/**
 * Extract the filename from a full file path
 */
export function getFileName(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

/**
 * Format pagination info as "start-end of total"
 */
export function formatPaginationInfo(
  offset: number,
  pageSize: number,
  total: number
): string {
  const start = offset + 1;
  const end = Math.min(offset + pageSize, total);
  return `${start}-${end} of ${total}`;
}

/**
 * Format match count as "N match(es)"
 */
export function formatMatchCount(count: number): string {
  return `${count} match${count !== 1 ? 'es' : ''}`;
}

/**
 * Format message count as "N message(s)"
 */
export function formatMessageCount(count: number): string {
  return `${count} message${count !== 1 ? 's' : ''}`;
}

/**
 * Format conversation count as "N conversation(s)"
 */
export function formatConversationCount(count: number): string {
  return `${count} conversation${count !== 1 ? 's' : ''}`;
}

/**
 * Get role label for display
 */
export function getRoleLabel(role: string): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Assistant';
  return 'System';
}

/**
 * Get role color for Ink components
 */
export function getRoleColor(role: string): string {
  if (role === 'user') return 'green';
  if (role === 'assistant') return 'blue';
  return 'yellow';
}

/**
 * Format source info with optional model (e.g., "Cursor · gpt-4")
 */
export function formatSourceInfo(source: string, model?: string | null): string {
  const sourceName = formatSourceLabel(source);
  return model ? `${sourceName} · ${model}` : sourceName;
}

/**
 * Format a token count as a human-readable string (e.g., "1.2K", "42.5K", "1.2M")
 */
export function formatTokenCount(count: number | undefined): string {
  if (count === undefined || count === 0) return '';
  if (count < 1000) return count.toString();
  if (count < 1000000) {
    const k = count / 1000;
    return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  }
  const m = count / 1000000;
  return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

/**
 * Format input/output token pair (e.g., "42K in / 2.3K out")
 * For Claude Code, input includes cache tokens (cache_creation + cache_read + input)
 */
export function formatTokenPair(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  cacheCreationTokens?: number,
  cacheReadTokens?: number
): string {
  // Total input = regular input + cache tokens (for Claude Code)
  const input = (inputTokens || 0) + (cacheCreationTokens || 0) + (cacheReadTokens || 0);
  const output = outputTokens || 0;
  if (input === 0 && output === 0) return '';
  return `${formatTokenCount(input) || '0'} in / ${formatTokenCount(output) || '0'} out`;
}

/**
 * Format line counts as "+N / -M" for display
 * Only shows if there are actual changes
 */
export function formatLineCounts(
  linesAdded: number | undefined,
  linesRemoved: number | undefined
): string {
  const added = linesAdded || 0;
  const removed = linesRemoved || 0;
  if (added === 0 && removed === 0) return '';
  return `+${added} / -${removed}`;
}

/**
 * Get line count parts for separate colored display
 * Returns null if no changes, otherwise { added: "+N", removed: "-M" }
 */
export function getLineCountParts(
  linesAdded: number | undefined,
  linesRemoved: number | undefined
): { added: string; removed: string } | null {
  const added = linesAdded || 0;
  const removed = linesRemoved || 0;
  if (added === 0 && removed === 0) return null;
  return { added: `+${added}`, removed: `-${removed}` };
}

/**
 * Truncate a list of file names for display
 */
export function formatFileList(
  fileNames: string[],
  maxShow: number = 2
): string {
  if (fileNames.length === 0) return '';
  const shown = fileNames.slice(0, maxShow).join(', ');
  const remaining = fileNames.length - maxShow;
  return remaining > 0 ? `${shown} +${remaining}` : shown;
}

/**
 * Format files display with optional "more" indicator
 */
export function formatFilesDisplay(
  fileNames: string[],
  totalCount: number,
  maxShow: number = 5
): string {
  if (fileNames.length === 0) return 'No files';
  const shown = fileNames.slice(0, maxShow).join(', ');
  const remaining = totalCount - maxShow;
  return remaining > 0 ? `Files: ${shown} (+${remaining} more)` : `Files: ${shown}`;
}

/**
 * Combined message that groups consecutive messages from the same role
 */
export interface CombinedMessage {
  /** IDs of all original messages in this group */
  messageIds: string[];
  /** Combined content from all messages */
  content: string;
  /** Role (user, assistant, system) */
  role: 'user' | 'assistant' | 'system';
  /** Index of this combined message (0-based) */
  combinedIndex: number;
  /** Original message indices included in this group */
  originalIndices: number[];
  /** Timestamp from first message */
  timestamp?: string;
  /** Total input tokens for this message group */
  inputTokens?: number;
  /** Total output tokens for this message group */
  outputTokens?: number;
  /** Total cache creation tokens for this message group */
  cacheCreationTokens?: number;
  /** Total cache read tokens for this message group */
  cacheReadTokens?: number;
  /** Total lines added for this message group */
  totalLinesAdded?: number;
  /** Total lines removed for this message group */
  totalLinesRemoved?: number;
  /** Whether this is a compact summary message (Claude Code only) */
  isCompactSummary?: boolean;
}

/**
 * Result of combining messages
 */
export interface CombinedMessagesResult {
  /** Combined messages */
  messages: CombinedMessage[];
  /** Map from original messageIndex to combined index */
  indexMap: Map<number, number>;
}

/**
 * Combine consecutive messages from the same role (especially assistant messages
 * that are split by tool calls) into single logical messages.
 */
export function combineConsecutiveMessages<T extends {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  messageIndex: number;
  timestamp?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  isCompactSummary?: boolean;
}>(messages: T[]): CombinedMessagesResult {
  if (messages.length === 0) {
    return { messages: [], indexMap: new Map() };
  }

  const combined: CombinedMessage[] = [];
  const indexMap = new Map<number, number>();

  let currentGroup: T[] = [];
  let currentRole: string | null = null;

  for (const msg of messages) {
    if (msg.role === currentRole && (currentRole === 'assistant' || currentRole === 'user')) {
      // Continue grouping consecutive messages from the same role
      currentGroup.push(msg);
    } else {
      // Flush current group if any
      if (currentGroup.length > 0) {
        const combinedIdx = combined.length;
        // For input/cache tokens, find the message with peak TOTAL context and use all its values.
        // We can't take max of each component separately as they'd come from different messages.
        // For output tokens and line counts, SUM since each adds new content.
        let peakMessage: T | undefined;
        let peakContext = 0;
        for (const m of currentGroup) {
          const ctx = (m.inputTokens || 0) + (m.cacheCreationTokens || 0) + (m.cacheReadTokens || 0);
          if (ctx > peakContext) {
            peakContext = ctx;
            peakMessage = m;
          }
        }
        const totalInputTokens = peakMessage?.inputTokens || 0;
        const totalCacheCreationTokens = peakMessage?.cacheCreationTokens || 0;
        const totalCacheReadTokens = peakMessage?.cacheReadTokens || 0;
        const totalOutputTokens = currentGroup.reduce((sum, m) => sum + (m.outputTokens || 0), 0);
        const totalLinesAdded = currentGroup.reduce((sum, m) => sum + (m.totalLinesAdded || 0), 0);
        const totalLinesRemoved = currentGroup.reduce((sum, m) => sum + (m.totalLinesRemoved || 0), 0);
        // A combined message is a compact summary if any of its parts is
        const isCompactSummary = currentGroup.some(m => m.isCompactSummary);
        combined.push({
          messageIds: currentGroup.map(m => m.id),
          content: currentGroup.map(m => m.content).join('\n\n'),
          role: currentGroup[0]!.role,
          combinedIndex: combinedIdx,
          originalIndices: currentGroup.map(m => m.messageIndex),
          timestamp: currentGroup[0]!.timestamp,
          inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
          outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
          cacheCreationTokens: totalCacheCreationTokens > 0 ? totalCacheCreationTokens : undefined,
          cacheReadTokens: totalCacheReadTokens > 0 ? totalCacheReadTokens : undefined,
          totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
          totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
          isCompactSummary: isCompactSummary || undefined,
        });
        // Map all original indices to this combined index
        for (const m of currentGroup) {
          indexMap.set(m.messageIndex, combinedIdx);
        }
      }
      // Start new group
      currentGroup = [msg];
      currentRole = msg.role;
    }
  }

  // Flush final group
  if (currentGroup.length > 0) {
    const combinedIdx = combined.length;
    // For input/cache tokens, find the message with peak TOTAL context and use all its values.
    // We can't take max of each component separately as they'd come from different messages.
    // For output tokens and line counts, SUM since each adds new content.
    let peakMessage: T | undefined;
    let peakContext = 0;
    for (const m of currentGroup) {
      const ctx = (m.inputTokens || 0) + (m.cacheCreationTokens || 0) + (m.cacheReadTokens || 0);
      if (ctx > peakContext) {
        peakContext = ctx;
        peakMessage = m;
      }
    }
    const totalInputTokens = peakMessage?.inputTokens || 0;
    const totalCacheCreationTokens = peakMessage?.cacheCreationTokens || 0;
    const totalCacheReadTokens = peakMessage?.cacheReadTokens || 0;
    const totalOutputTokens = currentGroup.reduce((sum, m) => sum + (m.outputTokens || 0), 0);
    const totalLinesAdded = currentGroup.reduce((sum, m) => sum + (m.totalLinesAdded || 0), 0);
    const totalLinesRemoved = currentGroup.reduce((sum, m) => sum + (m.totalLinesRemoved || 0), 0);
    // A combined message is a compact summary if any of its parts is
    const isCompactSummary = currentGroup.some(m => m.isCompactSummary);
    combined.push({
      messageIds: currentGroup.map(m => m.id),
      content: currentGroup.map(m => m.content).join('\n\n'),
      role: currentGroup[0]!.role,
      combinedIndex: combinedIdx,
      originalIndices: currentGroup.map(m => m.messageIndex),
      timestamp: currentGroup[0]!.timestamp,
      inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
      outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
      cacheCreationTokens: totalCacheCreationTokens > 0 ? totalCacheCreationTokens : undefined,
      cacheReadTokens: totalCacheReadTokens > 0 ? totalCacheReadTokens : undefined,
      totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
      totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
      isCompactSummary: isCompactSummary || undefined,
    });
    for (const m of currentGroup) {
      indexMap.set(m.messageIndex, combinedIdx);
    }
  }

  return { messages: combined, indexMap };
}

/**
 * Render markdown content to terminal-formatted string.
 * Returns the rendered string which can be split by '\n' to get line count.
 * This must match the rendering in MessageDetailView.
 */
export function renderMarkdownContent(content: string, width: number): string {
  marked.use(markedTerminal({
    reflowText: true,
    width: Math.max(40, width - 4),
    tab: 2,
  }) as MarkedExtension);

  try {
    return marked.parse(content) as string;
  } catch {
    return content;
  }
}

/**
 * Get the line count for rendered markdown content.
 * Used for scroll calculations in message detail view.
 */
export function getRenderedLineCount(content: string, width: number): number {
  return renderMarkdownContent(content, width).split('\n').length;
}

/**
 * Format tool outputs as markdown for rendering in message detail view.
 * Used by both the navigation hook (for scroll calculations) and the component (for display).
 */
export function formatToolOutputs(
  toolCalls: { messageId: string; type: string; filePath?: string; output?: string }[],
  fileEdits: { messageId: string; filePath: string; linesAdded: number; linesRemoved: number; newContent?: string }[],
  messageIds: string[]
): string {
  const msgToolCalls = toolCalls.filter(
    (tc) => messageIds.includes(tc.messageId) && tc.output
  );
  const msgFileEdits = fileEdits.filter(
    (fe) => messageIds.includes(fe.messageId) && fe.newContent
  );

  if (msgToolCalls.length === 0 && msgFileEdits.length === 0) {
    return '';
  }

  const lines: string[] = ['', '---', '', '### Tool Outputs', ''];

  for (const tc of msgToolCalls) {
    const fileName = tc.filePath ? getFileName(tc.filePath) : '';
    lines.push(`**${tc.type}**${fileName ? ` \`${fileName}\`` : ''}`);
    lines.push('```');
    lines.push(tc.output!);
    lines.push('```');
    lines.push('');
  }

  for (const fe of msgFileEdits) {
    const fileName = getFileName(fe.filePath);
    lines.push(`**Edit** \`${fileName}\` (+${fe.linesAdded}/-${fe.linesRemoved})`);
    lines.push('```');
    lines.push(fe.newContent!);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * A structured tool output block for collapsible rendering
 */
export interface ToolOutputBlock {
  /** Unique index within the message */
  index: number;
  /** Display header line: "**Edit** `config.ts` (+15/-3)" */
  header: string;
  /** The code block content (without the ```...``` wrapper) */
  content: string;
  /** Type of tool: 'Edit', 'RunCommand', etc. */
  type: string;
  /** Optional file path */
  filePath?: string;
}

/**
 * Result of parsing tool outputs into structured blocks
 */
export interface ParsedToolOutputs {
  /** Structured tool output blocks */
  blocks: ToolOutputBlock[];
}

/**
 * Parse tool outputs into structured blocks for collapsible rendering.
 * This extracts the same data as formatToolOutputs but returns structured data
 * instead of a markdown string.
 */
export function parseToolOutputs(
  toolCalls: { messageId: string; type: string; filePath?: string; output?: string }[],
  fileEdits: { messageId: string; filePath: string; linesAdded: number; linesRemoved: number; newContent?: string }[],
  messageIds: string[]
): ParsedToolOutputs {
  const msgToolCalls = toolCalls.filter(
    (tc) => messageIds.includes(tc.messageId) && tc.output
  );
  const msgFileEdits = fileEdits.filter(
    (fe) => messageIds.includes(fe.messageId) && fe.newContent
  );

  const blocks: ToolOutputBlock[] = [];
  let index = 0;

  for (const tc of msgToolCalls) {
    const fileName = tc.filePath ? getFileName(tc.filePath) : '';
    blocks.push({
      index: index++,
      header: `**${tc.type}**${fileName ? ` \`${fileName}\`` : ''}`,
      content: tc.output!,
      type: tc.type,
      filePath: tc.filePath,
    });
  }

  for (const fe of msgFileEdits) {
    const fileName = getFileName(fe.filePath);
    blocks.push({
      index: index++,
      header: `**Edit** \`${fileName}\` (+${fe.linesAdded}/-${fe.linesRemoved})`,
      content: fe.newContent!,
      type: 'Edit',
      filePath: fe.filePath,
    });
  }

  return { blocks };
}

/**
 * A segment of message content - either text or a tool output
 */
export interface ContentSegment {
  type: 'text' | 'tool';
  /** For text: the text content. For tool: not used (see toolIndex) */
  content: string;
  /** For tool segments: index into the blocks array */
  toolIndex?: number;
}

/**
 * Result of parsing tool outputs from message content
 */
export interface ParsedMessageContent {
  /** Content segments in order (text and tool blocks interleaved) */
  segments: ContentSegment[];
  /** All tool output blocks for indexing */
  blocks: ToolOutputBlock[];
  /** The main message content without tool outputs (for backwards compatibility) */
  mainContent: string;
}

/**
 * Parse tool outputs that are interleaved throughout message content.
 * Tool outputs can appear anywhere in the message, each preceded by "---" separator.
 * Format: ---\n**ToolType** `filename` (optional +N/-M)\n```\ncontent\n```
 */
export function parseToolOutputsFromContent(content: string): ParsedMessageContent {
  const segments: ContentSegment[] = [];
  const blocks: ToolOutputBlock[] = [];
  let blockIndex = 0;

  // Regex to match tool blocks: ---\n**ToolType** `filename` (lineinfo)\n```lang\ncontent\n```
  // The --- separator, optional ### Tool Outputs header, then the tool block
  // Supports both 3 and 4 backticks (4 is used when content may contain code blocks)
  const toolBlockRegex = /\n---\n+(?:### Tool Outputs\n+)?\*\*(\w+)\*\*(?:\s+`([^`]+)`)?\s*(?:\(([^)]+)\))?\s*\n(`{3,4})[^\n]*\n([\s\S]*?)\4/g;

  let lastIndex = 0;
  let match;

  while ((match = toolBlockRegex.exec(content)) !== null) {
    const [fullMatch, toolType, fileName, lineInfo, _backticks, codeContent] = match;
    const matchStart = match.index;

    // Add text segment before this tool block (if any)
    if (matchStart > lastIndex) {
      const textContent = content.substring(lastIndex, matchStart).trim();
      if (textContent) {
        segments.push({ type: 'text', content: textContent });
      }
    }

    // Build header string
    let header = `**${toolType}**`;
    if (fileName) {
      header += ` \`${fileName}\``;
    }
    if (lineInfo) {
      header += ` (${lineInfo})`;
    }

    // Add the tool block
    const block: ToolOutputBlock = {
      index: blockIndex,
      header,
      content: codeContent?.trim() || '',
      type: toolType || 'Unknown',
      filePath: fileName,
    };
    blocks.push(block);
    segments.push({ type: 'tool', content: '', toolIndex: blockIndex });
    blockIndex++;

    lastIndex = matchStart + fullMatch.length;
  }

  // Add any remaining text after the last tool block
  if (lastIndex < content.length) {
    const textContent = content.substring(lastIndex).trim();
    if (textContent) {
      segments.push({ type: 'text', content: textContent });
    }
  }

  // If no tool blocks found, the entire content is text
  if (blocks.length === 0) {
    return {
      segments: [{ type: 'text', content: content }],
      blocks: [],
      mainContent: content,
    };
  }

  // Build mainContent by joining all text segments (for backwards compatibility)
  const mainContent = segments
    .filter(s => s.type === 'text')
    .map(s => s.content)
    .join('\n\n');

  return { segments, blocks, mainContent };
}

/**
 * Render tool outputs with collapse indicators.
 * Returns a markdown string with [+]/[-] indicators for each tool output.
 *
 * @param blocks - Parsed tool output blocks
 * @param expandedIndices - Set of block indices that are expanded (show content)
 * @param focusedIndex - Index of the currently focused block (for > indicator), or null
 */
export function renderToolOutputsWithCollapse(
  blocks: ToolOutputBlock[],
  expandedIndices: Set<number>,
  focusedIndex: number | null
): string {
  if (blocks.length === 0) {
    return '';
  }

  const lines: string[] = ['', '---', '', '### Tool Outputs', ''];

  for (const block of blocks) {
    const isExpanded = expandedIndices.has(block.index);
    const isFocused = focusedIndex === block.index;

    // Focus indicator: "> " or "  " for alignment
    const focusPrefix = isFocused ? '> ' : '  ';
    // Collapse indicator: [+] for collapsed, [-] for expanded
    const collapseIndicator = isExpanded ? '[-]' : '[+]';

    lines.push(`${focusPrefix}${collapseIndicator} ${block.header}`);

    if (isExpanded) {
      lines.push('```');
      lines.push(block.content);
      lines.push('```');
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render a single tool block with collapse indicator (for interleaved rendering)
 * When focused, shows ► arrow to indicate selection
 */
function renderToolBlock(
  block: ToolOutputBlock,
  isExpanded: boolean,
  isFocused: boolean
): string {
  const collapseIndicator = isExpanded ? '[-]' : '[+]';

  // Use ANSI escape codes directly to bypass markdown processing
  // \x1b[1m = bold, \x1b[33m = yellow, \x1b[0m = reset
  const BOLD = '\x1b[1m';
  const YELLOW = '\x1b[33m';
  const CYAN = '\x1b[36m';
  const RESET = '\x1b[0m';

  const prefix = isFocused ? `${YELLOW}${BOLD}►${RESET}` : ' ';
  const headerStyle = isFocused ? `${CYAN}${BOLD}` : '';
  const headerEnd = isFocused ? RESET : '';

  const lines: string[] = [
    `${prefix} ${collapseIndicator} ${headerStyle}${block.header}${headerEnd}`,
  ];

  if (isExpanded) {
    lines.push('```');
    lines.push(block.content);
    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Render content segments with collapsible tool outputs.
 * Preserves interleaved text between tool blocks.
 *
 * @param segments - Content segments (text and tool references)
 * @param blocks - All tool output blocks
 * @param expandedIndices - Set of block indices that are expanded
 * @param focusedIndex - Index of the currently focused block, or null
 */
export function renderSegmentsWithCollapse(
  segments: ContentSegment[],
  blocks: ToolOutputBlock[],
  expandedIndices: Set<number>,
  focusedIndex: number | null
): string {
  if (segments.length === 0) {
    return '';
  }

  const parts: string[] = [];

  for (const segment of segments) {
    if (segment.type === 'text') {
      parts.push(segment.content);
    } else if (segment.type === 'tool' && segment.toolIndex !== undefined) {
      const block = blocks[segment.toolIndex];
      if (block) {
        const isExpanded = expandedIndices.has(segment.toolIndex);
        const isFocused = focusedIndex === segment.toolIndex;
        parts.push(renderToolBlock(block, isExpanded, isFocused));
      }
    }
  }

  return parts.join('\n\n');
}
