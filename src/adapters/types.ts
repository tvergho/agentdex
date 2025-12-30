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

/**
 * Lightweight timestamp info for incremental sync
 */
export interface ConversationTimestampInfo {
  /** Original ID in the source system */
  originalId: string;
  /** Last updated timestamp (epoch ms or undefined if not available) */
  lastUpdatedAt: number | undefined;
}

/**
 * Count combined messages where consecutive same-role messages count as 1.
 * This gives a more intuitive "turns" count rather than raw message count.
 *
 * Example: [user, assistant, assistant, assistant, user, assistant]
 * Raw count: 6, Combined count: 4 (user, assistant-run, user, assistant)
 */
export function countCombinedMessages(messages: Array<{ role: string }>): number {
  let count = 0;
  let lastRole: string | null = null;
  for (const msg of messages) {
    if (msg.role !== lastRole) {
      count++;
      lastRole = msg.role;
    }
  }
  return count;
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

  /**
   * Get lightweight timestamp info for all conversations at a location.
   * This is much faster than full extraction and is used for incremental sync
   * to determine which conversations have changed.
   * 
   * Returns undefined if the adapter doesn't support fast timestamp queries
   * (in which case full extraction will be used).
   */
  getConversationTimestamps?(location: SourceLocation): ConversationTimestampInfo[] | undefined;

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
