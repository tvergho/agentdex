import { createHash } from 'crypto';
import { getGlobalDatabase } from './paths';
import { extractConversations, type RawConversation } from './parser';
import type { Conversation, Message, SourceRef, ToolCall, ConversationFile, MessageFile, FileEdit } from '../../schema/index';
import type { SourceAdapter, SourceLocation, NormalizedConversation } from '../types';

export class CursorAdapter implements SourceAdapter {
  name = 'cursor' as const;

  async detect(): Promise<boolean> {
    const globalDb = getGlobalDatabase();
    return globalDb !== null;
  }

  async discover(): Promise<SourceLocation[]> {
    const globalDb = getGlobalDatabase();
    if (!globalDb) return [];

    // Cursor stores all conversations in a single global database
    return [{
      source: 'cursor' as const,
      workspacePath: 'global',
      dbPath: globalDb.dbPath,
      mtime: globalDb.mtime,
    }];
  }

  async extract(location: SourceLocation): Promise<RawConversation[]> {
    return extractConversations(location.dbPath);
  }

  normalize(raw: RawConversation, location: SourceLocation): NormalizedConversation {
    // Create deterministic ID from source + original ID to avoid duplicates on re-sync
    const conversationId = createHash('sha256')
      .update(`cursor:${raw.composerId}`)
      .digest('hex')
      .slice(0, 32);

    const sourceRef: SourceRef = {
      source: 'cursor',
      workspacePath: undefined,
      originalId: raw.composerId,
      dbPath: location.dbPath,
    };

    // Parse timestamps
    let createdAt: string | undefined;
    let updatedAt: string | undefined;

    if (raw.createdAt) {
      try {
        createdAt = new Date(raw.createdAt).toISOString();
      } catch {
        // Skip invalid timestamps
      }
    }

    if (raw.lastUpdatedAt) {
      try {
        updatedAt = new Date(raw.lastUpdatedAt).toISOString();
      } catch {
        // Skip invalid timestamps
      }
    }

    // Build conversation
    const conversation: Conversation = {
      id: conversationId,
      source: 'cursor',
      title: raw.name || 'Untitled',
      subtitle: undefined,
      workspacePath: raw.workspacePath,
      projectName: raw.projectName,
      model: raw.model,
      mode: raw.mode,
      createdAt,
      updatedAt,
      messageCount: raw.bubbles.length,
      sourceRef,
      totalInputTokens: raw.totalInputTokens,
      totalOutputTokens: raw.totalOutputTokens,
      totalLinesAdded: raw.totalLinesAdded,
      totalLinesRemoved: raw.totalLinesRemoved,
    };

    // Filter to main messages (with content)
    const mainBubbles = raw.bubbles.filter((bubble) => bubble.text.trim().length > 0);

    // Propagate line counts from tool-only bubbles to the nearest visible assistant bubble
    // Tool-only bubbles (empty text but have fileEdits) get filtered out, but we want their line counts
    // to show on the visible assistant message
    const mainBubbleIds = new Set(mainBubbles.map((b) => b.bubbleId));
    const lineCounts = new Map<string, { added: number; removed: number }>();

    // Initialize line counts for main bubbles
    for (const bubble of mainBubbles) {
      lineCounts.set(bubble.bubbleId, {
        added: bubble.totalLinesAdded ?? 0,
        removed: bubble.totalLinesRemoved ?? 0,
      });
    }

    // For each tool-only bubble, find the nearest visible assistant bubble and add its line counts
    for (let i = 0; i < raw.bubbles.length; i++) {
      const bubble = raw.bubbles[i];
      if (!bubble) continue;

      // Skip if this is a main bubble (already has its own line counts)
      if (mainBubbleIds.has(bubble.bubbleId)) continue;

      // This is a tool-only bubble - find nearest visible assistant bubble
      if (bubble.type === 'assistant' && (bubble.totalLinesAdded ?? 0) > 0) {
        // Look backwards for the nearest visible assistant bubble
        for (let j = i - 1; j >= 0; j--) {
          const prev = raw.bubbles[j];
          if (prev && prev.type === 'assistant' && mainBubbleIds.has(prev.bubbleId)) {
            const counts = lineCounts.get(prev.bubbleId);
            if (counts) {
              counts.added += bubble.totalLinesAdded ?? 0;
              counts.removed += bubble.totalLinesRemoved ?? 0;
            }
            break;
          }
        }
      }
    }

    const messages: Message[] = mainBubbles.map((bubble, index) => {
      const counts = lineCounts.get(bubble.bubbleId);
      return {
        id: `${conversationId}:${bubble.bubbleId}`,
        conversationId,
        role: bubble.type,
        content: bubble.text,
        timestamp: undefined,
        messageIndex: index,
        inputTokens: bubble.inputTokens,
        outputTokens: bubble.outputTokens,
        totalLinesAdded: counts && counts.added > 0 ? counts.added : undefined,
        totalLinesRemoved: counts && counts.removed > 0 ? counts.removed : undefined,
      };
    });

    // Build conversation files
    const files: ConversationFile[] = raw.files.map((file, index) => ({
      id: `${conversationId}:file:${index}`,
      conversationId,
      filePath: file.path,
      role: file.role,
    }));

    // Build message files (per-message file associations)
    const messageFiles: MessageFile[] = [];
    for (let i = 0; i < raw.bubbles.length; i++) {
      const bubble = raw.bubbles[i];
      if (!bubble) continue;
      const messageId = `${conversationId}:${bubble.bubbleId}`;

      for (let j = 0; j < bubble.files.length; j++) {
        const file = bubble.files[j];
        if (!file) continue;
        messageFiles.push({
          id: `${messageId}:file:${j}`,
          messageId,
          conversationId,
          filePath: file.path,
          role: file.role,
        });
      }
    }

    // Tool calls - not implemented yet
    const toolCalls: ToolCall[] = [];

    // Build file edits
    const fileEdits: FileEdit[] = [];
    for (let i = 0; i < raw.bubbles.length; i++) {
      const bubble = raw.bubbles[i];
      if (!bubble) continue;
      const messageId = `${conversationId}:${bubble.bubbleId}`;

      for (let j = 0; j < bubble.fileEdits.length; j++) {
        const edit = bubble.fileEdits[j];
        if (!edit) continue;

        // Create deterministic ID from edit properties
        const editId = createHash('sha256')
          .update(`${messageId}:edit:${j}:${edit.filePath}`)
          .digest('hex')
          .slice(0, 32);

        fileEdits.push({
          id: editId,
          messageId,
          conversationId,
          filePath: edit.filePath,
          editType: edit.editType,
          linesAdded: edit.linesAdded,
          linesRemoved: edit.linesRemoved,
          startLine: edit.startLine,
          endLine: edit.endLine,
        });
      }
    }

    return {
      conversation,
      messages,
      toolCalls,
      files,
      messageFiles,
      fileEdits,
    };
  }

  getDeepLink(_ref: SourceRef): string | null {
    // Cursor doesn't have a way to open a specific conversation via URL/CLI
    return null;
  }
}

export const cursorAdapter = new CursorAdapter();
