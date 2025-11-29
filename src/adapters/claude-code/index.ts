import { createHash } from 'crypto';
import { detectClaudeCode, discoverProjects } from './paths.js';
import { extractConversations, type RawConversation } from './parser.js';
import type { Conversation, Message, SourceRef, ToolCall, ConversationFile, MessageFile, FileEdit } from '../../schema/index.js';
import type { SourceAdapter, SourceLocation, NormalizedConversation } from '../types.js';

export class ClaudeCodeAdapter implements SourceAdapter {
  name = 'claude-code' as const;

  async detect(): Promise<boolean> {
    return detectClaudeCode();
  }

  async discover(): Promise<SourceLocation[]> {
    const projects = discoverProjects();

    return projects.map((project) => ({
      source: 'claude-code' as const,
      workspacePath: project.workspacePath,
      dbPath: project.sessionsDir,
      mtime: project.mtime,
    }));
  }

  async extract(location: SourceLocation): Promise<RawConversation[]> {
    // Find the project that matches this location
    const projects = discoverProjects();
    const project = projects.find((p) => p.sessionsDir === location.dbPath);

    if (!project) {
      return [];
    }

    return extractConversations(project);
  }

  normalize(raw: RawConversation, location: SourceLocation): NormalizedConversation {
    // Create deterministic ID from source + session ID
    const conversationId = createHash('sha256')
      .update(`claude-code:${raw.sessionId}`)
      .digest('hex')
      .slice(0, 32);

    const sourceRef: SourceRef = {
      source: 'claude-code',
      workspacePath: location.workspacePath,
      originalId: raw.sessionId,
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

    if (raw.updatedAt) {
      try {
        updatedAt = new Date(raw.updatedAt).toISOString();
      } catch {
        // Skip invalid timestamps
      }
    }

    // Build conversation
    const conversation: Conversation = {
      id: conversationId,
      source: 'claude-code',
      title: raw.title,
      subtitle: raw.gitBranch ? `branch: ${raw.gitBranch}` : undefined,
      workspacePath: raw.workspacePath || raw.cwd,
      projectName: raw.workspacePath?.split('/').pop(),
      model: raw.model,
      mode: 'agent', // Claude Code is always agent mode
      createdAt,
      updatedAt,
      messageCount: raw.messages.length,
      sourceRef,
      totalInputTokens: raw.totalInputTokens,
      totalOutputTokens: raw.totalOutputTokens,
      totalCacheCreationTokens: raw.totalCacheCreationTokens,
      totalCacheReadTokens: raw.totalCacheReadTokens,
      totalLinesAdded: raw.totalLinesAdded,
      totalLinesRemoved: raw.totalLinesRemoved,
    };

    // Filter to main messages (non-sidechain with content)
    const mainMessages = raw.messages.filter((m) => !m.isSidechain && m.content.trim().length > 0);

    // Propagate line counts from tool-only assistant messages to the nearest visible assistant message
    // Tool-only messages (empty content but have fileEdits) get filtered out, but we want their line counts
    // to show on the visible assistant message
    const mainMessageUuids = new Set(mainMessages.map((m) => m.uuid));
    const lineCounts = new Map<string, { added: number; removed: number }>();

    // Initialize line counts for main messages
    for (const msg of mainMessages) {
      lineCounts.set(msg.uuid, {
        added: msg.totalLinesAdded ?? 0,
        removed: msg.totalLinesRemoved ?? 0,
      });
    }

    // For each tool-only message, find the nearest visible assistant message and add its line counts
    for (let i = 0; i < raw.messages.length; i++) {
      const msg = raw.messages[i];
      if (!msg || msg.isSidechain) continue;

      // Skip if this is a main message (already has its own line counts)
      if (mainMessageUuids.has(msg.uuid)) continue;

      // This is a tool-only message - find nearest visible assistant message
      if (msg.role === 'assistant' && (msg.totalLinesAdded ?? 0) > 0) {
        // Look backwards for the nearest visible assistant message
        for (let j = i - 1; j >= 0; j--) {
          const prev = raw.messages[j];
          if (prev && prev.role === 'assistant' && mainMessageUuids.has(prev.uuid)) {
            const counts = lineCounts.get(prev.uuid);
            if (counts) {
              counts.added += msg.totalLinesAdded ?? 0;
              counts.removed += msg.totalLinesRemoved ?? 0;
            }
            break;
          }
        }
      }
    }

    const messages: Message[] = mainMessages.map((msg, index) => {
      const counts = lineCounts.get(msg.uuid);
      return {
        id: `${conversationId}:${msg.uuid}`,
        conversationId,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        messageIndex: index,
        inputTokens: msg.inputTokens,
        outputTokens: msg.outputTokens,
        cacheCreationTokens: msg.cacheCreationTokens,
        cacheReadTokens: msg.cacheReadTokens,
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
    for (let i = 0; i < mainMessages.length; i++) {
      const msg = mainMessages[i];
      if (!msg) continue;
      const messageId = `${conversationId}:${msg.uuid}`;

      for (let j = 0; j < msg.files.length; j++) {
        const file = msg.files[j];
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

    // Build tool calls
    const toolCalls: ToolCall[] = [];
    for (let i = 0; i < mainMessages.length; i++) {
      const msg = mainMessages[i];
      if (!msg) continue;
      const messageId = `${conversationId}:${msg.uuid}`;

      for (const tc of msg.toolCalls) {
        toolCalls.push({
          id: `${messageId}:tool:${tc.id}`,
          messageId,
          conversationId,
          type: tc.name,
          input: tc.input,
          output: tc.output,
          filePath: tc.filePath,
        });
      }
    }

    // Build file edits
    const fileEdits: FileEdit[] = [];
    for (let i = 0; i < mainMessages.length; i++) {
      const msg = mainMessages[i];
      if (!msg) continue;
      const messageId = `${conversationId}:${msg.uuid}`;

      for (let j = 0; j < msg.fileEdits.length; j++) {
        const edit = msg.fileEdits[j];
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
    // Claude Code CLI doesn't have URL-based deep linking
    return null;
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();
