import Database from 'better-sqlite3';

export interface RawBubble {
  bubbleId: string;
  type: 'user' | 'assistant' | 'system';
  text: string;
}

export interface RawConversation {
  composerId: string;
  name: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  bubbles: RawBubble[];
}

interface ComposerDataEntry {
  composerId: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  conversation?: Array<{
    bubbleId?: string;
    type?: number;
    text?: string;
  }>;
  conversationMap?: Record<string, {
    type?: number;
    text?: string;
  }>;
  fullConversationHeadersOnly?: Array<{
    bubbleId?: string;
    type?: number;
  }>;
}

// Map numeric bubble type to role
function mapBubbleType(type: number | undefined): RawBubble['type'] {
  // Type 1 = user, Type 2 = assistant
  if (type === 1) return 'user';
  if (type === 2) return 'assistant';
  return 'user';
}

export function extractConversations(dbPath: string): RawConversation[] {
  const db = new Database(dbPath, { readonly: true });
  const conversations: RawConversation[] = [];

  try {
    // Get all composerData entries from global cursorDiskKV
    const composerRows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as Array<{ key: string; value: Buffer | string }>;

    for (const row of composerRows) {
      // Parse the value
      let valueStr: string;
      if (Buffer.isBuffer(row.value)) {
        valueStr = row.value.toString('utf-8');
      } else {
        valueStr = row.value;
      }

      let data: ComposerDataEntry;
      try {
        data = JSON.parse(valueStr);
        // Skip if parsed value is null or not an object
        if (!data || typeof data !== 'object') continue;
      } catch {
        continue;
      }

      const composerId = data.composerId || row.key.replace('composerData:', '');
      const bubbles: RawBubble[] = [];

      // Try to get bubbles from conversation array (older format)
      if (data.conversation && Array.isArray(data.conversation)) {
        for (const item of data.conversation) {
          if (item.bubbleId && item.text) {
            bubbles.push({
              bubbleId: item.bubbleId,
              type: mapBubbleType(item.type),
              text: item.text,
            });
          }
        }
      }

      // Try to get bubbles from conversationMap (newer format)
      if (bubbles.length === 0 && data.conversationMap && data.fullConversationHeadersOnly) {
        for (const header of data.fullConversationHeadersOnly) {
          if (header.bubbleId) {
            const bubbleData = data.conversationMap[header.bubbleId];
            if (bubbleData && bubbleData.text) {
              bubbles.push({
                bubbleId: header.bubbleId,
                type: mapBubbleType(header.type ?? bubbleData.type),
                text: bubbleData.text,
              });
            }
          }
        }
      }

      // Skip empty conversations
      if (bubbles.length === 0) continue;

      conversations.push({
        composerId,
        name: data.name || 'Untitled',
        createdAt: data.createdAt,
        lastUpdatedAt: data.lastUpdatedAt,
        bubbles,
      });
    }
  } finally {
    db.close();
  }

  return conversations;
}
