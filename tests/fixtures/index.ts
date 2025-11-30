/**
 * Test fixture factories for creating consistent test data
 */

import type {
  Conversation,
  Message,
  ConversationFile,
  ToolCall,
  FileEdit,
  SourceRef,
} from '../../src/schema/index';

// Generate a random ID suffix
function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Create a test conversation with sensible defaults
 */
export function createConversation(overrides?: Partial<Conversation>): Conversation {
  const id = `conv-${randomId()}`;
  const source = overrides?.source ?? 'cursor';

  return {
    id,
    source,
    title: 'Test Conversation',
    subtitle: undefined,
    workspacePath: '/home/user/project',
    projectName: 'project',
    model: 'gpt-4',
    mode: 'chat',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 0,
    sourceRef: {
      source,
      originalId: `orig-${randomId()}`,
      dbPath: '/path/to/db',
      workspacePath: '/home/user/project',
    },
    totalInputTokens: 100,
    totalOutputTokens: 200,
    totalCacheCreationTokens: undefined,
    totalCacheReadTokens: undefined,
    totalLinesAdded: 50,
    totalLinesRemoved: 10,
    ...overrides,
  };
}

/**
 * Create a test message with sensible defaults
 */
export function createMessage(
  conversationId: string,
  overrides?: Partial<Message>
): Message {
  return {
    id: `msg-${randomId()}`,
    conversationId,
    role: 'user',
    content: 'This is a test message content.',
    timestamp: new Date().toISOString(),
    messageIndex: 0,
    inputTokens: 50,
    outputTokens: 0,
    cacheCreationTokens: undefined,
    cacheReadTokens: undefined,
    totalLinesAdded: undefined,
    totalLinesRemoved: undefined,
    ...overrides,
  };
}

/**
 * Create a test conversation file with sensible defaults
 */
export function createConversationFile(
  conversationId: string,
  overrides?: Partial<ConversationFile>
): ConversationFile {
  return {
    id: `file-${randomId()}`,
    conversationId,
    filePath: '/home/user/project/src/index.ts',
    role: 'context',
    ...overrides,
  };
}

/**
 * Create a test tool call with sensible defaults
 */
export function createToolCall(
  messageId: string,
  conversationId: string,
  overrides?: Partial<ToolCall>
): ToolCall {
  return {
    id: `tool-${randomId()}`,
    messageId,
    conversationId,
    type: 'file_edit',
    input: 'Edit file content',
    output: 'File edited successfully',
    filePath: '/home/user/project/src/index.ts',
    ...overrides,
  };
}

/**
 * Create a test file edit with sensible defaults
 */
export function createFileEdit(
  messageId: string,
  conversationId: string,
  overrides?: Partial<FileEdit>
): FileEdit {
  return {
    id: `edit-${randomId()}`,
    messageId,
    conversationId,
    filePath: '/home/user/project/src/index.ts',
    editType: 'modify',
    linesAdded: 10,
    linesRemoved: 5,
    startLine: 1,
    endLine: 20,
    ...overrides,
  };
}

/**
 * Create a full conversation with messages
 */
export function createConversationWithMessages(
  messageCount: number,
  conversationOverrides?: Partial<Conversation>
): { conversation: Conversation; messages: Message[] } {
  const conversation = createConversation({
    messageCount,
    ...conversationOverrides,
  });

  const messages: Message[] = [];
  for (let i = 0; i < messageCount; i++) {
    messages.push(
      createMessage(conversation.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i + 1} content. ${i % 2 === 0 ? 'User question here.' : 'Assistant response here.'}`,
        messageIndex: i,
      })
    );
  }

  return { conversation, messages };
}

/**
 * Fixtures namespace for convenient access
 */
export const fixtures = {
  conversation: createConversation,
  message: createMessage,
  file: createConversationFile,
  toolCall: createToolCall,
  fileEdit: createFileEdit,
  conversationWithMessages: createConversationWithMessages,
};

