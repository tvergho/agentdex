import type { Conversation, Message, ToolCall, SourceRef, SourceType, ConversationFile, MessageFile, FileEdit } from '../schema/index';

export interface SourceLocation {
  source: SourceType;
  workspacePath: string;
  dbPath: string;
  mtime: number;
}

export interface NormalizedConversation {
  conversation: Conversation;
  messages: Message[];
  toolCalls: ToolCall[];
  files?: ConversationFile[];
  messageFiles?: MessageFile[];
  fileEdits?: FileEdit[];
}

export interface ExtractionProgress {
  current: number;
  total: number;
}

export interface SourceAdapter {
  name: SourceType;

  /** Check if this source is available on this machine */
  detect(): Promise<boolean>;

  /**
   * Quick mtime check for the source root (O(1) stat calls).
   * Returns the mtime of the root directory, or null if unavailable.
   * Used by needsSync() to avoid expensive discovery when nothing changed.
   */
  getQuickMtime(): number | null;

  /** Find all instances/workspaces of this source */
  discover(): Promise<SourceLocation[]>;

  /** Extract raw conversations from a source location */
  extract(
    location: SourceLocation,
    onProgress?: (progress: ExtractionProgress) => void
  ): Promise<unknown[]>;

  /** Convert raw conversation to unified schema */
  normalize(raw: unknown, location: SourceLocation): NormalizedConversation;

  /** Get a URL/path to open the original conversation (if possible) */
  getDeepLink(ref: SourceRef): string | null;
}
