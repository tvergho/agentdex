import React, { useState, useEffect, useMemo } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index.js';
import { conversationRepo, messageRepo } from '../../db/repository.js';
import type { Conversation, Message } from '../../schema/index.js';

function MessageView({
  message,
  width,
}: {
  message: Message;
  width: number;
}) {
  const roleLabel = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'System';
  const roleColor = message.role === 'user' ? 'green' : message.role === 'assistant' ? 'blue' : 'yellow';

  // Truncate very long messages for display
  const maxContentLength = width * 20; // ~20 lines worth
  const content = message.content.length > maxContentLength
    ? message.content.slice(0, maxContentLength) + '\n… (truncated)'
    : message.content;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={roleColor} bold>[{roleLabel}]</Text>
      <Box marginLeft={2}>
        <Text wrap="wrap">{content}</Text>
      </Box>
    </Box>
  );
}

function ShowApp({ conversationId }: { conversationId: string }) {
  const { exit } = useApp();
  const { width, height } = useScreenSize();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    async function loadConversation() {
      try {
        await connect();
        const conv = await conversationRepo.findById(conversationId);
        if (!conv) {
          setError(`Conversation not found: ${conversationId}`);
          return;
        }
        setConversation(conv);

        const msgs = await messageRepo.findByConversation(conversationId);
        setMessages(msgs);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    loadConversation();
  }, [conversationId]);

  const headerHeight = 4;
  const footerHeight = 2;
  const availableHeight = height - headerHeight - footerHeight;

  // Simple line-based scrolling
  const maxOffset = Math.max(0, messages.length - 1);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
      return;
    }

    if (messages.length === 0) return;

    if (input === 'j' || key.downArrow) {
      setScrollOffset((o) => Math.min(o + 1, maxOffset));
    } else if (input === 'k' || key.upArrow) {
      setScrollOffset((o) => Math.max(o - 1, 0));
    } else if (input === 'g') {
      setScrollOffset(0);
    } else if (input === 'G') {
      setScrollOffset(maxOffset);
    }
  });

  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="cyan">Loading conversation...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box width={width} height={height} flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press q to exit</Text>
      </Box>
    );
  }

  if (!conversation) {
    return (
      <Box width={width} height={height} flexDirection="column" padding={1}>
        <Text color="red">Conversation not found</Text>
        <Text dimColor>Press q to exit</Text>
      </Box>
    );
  }

  // Show messages starting from scrollOffset
  const visibleMessages = messages.slice(scrollOffset, scrollOffset + Math.max(1, Math.floor(availableHeight / 4)));

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">{conversation.title}</Text>
        <Text dimColor>
          [{conversation.source}] · {conversation.messageCount} messages
          {messages.length > 0 && ` · Viewing ${scrollOffset + 1}-${Math.min(scrollOffset + visibleMessages.length, messages.length)} of ${messages.length}`}
        </Text>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
        {visibleMessages.map((msg) => (
          <MessageView key={msg.id} message={msg} width={width - 4} />
        ))}
      </Box>

      {/* Footer */}
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>j/k: scroll · g/G: top/bottom · q: quit</Text>
      </Box>
    </Box>
  );
}

async function plainShow(conversationId: string): Promise<void> {
  await connect();

  const conversation = await conversationRepo.findById(conversationId);
  if (!conversation) {
    console.error(`Conversation not found: ${conversationId}`);
    process.exit(1);
  }

  const messages = await messageRepo.findByConversation(conversationId);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(conversation.title);
  console.log(`[${conversation.source}] · ${conversation.messageCount} messages`);
  console.log(`${'─'.repeat(60)}\n`);

  for (const msg of messages) {
    const roleLabel = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Assistant' : 'System';
    console.log(`[${roleLabel}]`);

    const content = msg.content.length > 4000 ? msg.content.slice(0, 4000) + '\n… (truncated)' : msg.content;
    console.log(content);
    console.log('');
  }
}

export async function showCommand(conversationId: string): Promise<void> {
  if (!process.stdin.isTTY) {
    await plainShow(conversationId);
    return;
  }

  const app = withFullScreen(<ShowApp conversationId={conversationId} />);
  await app.start();
  await app.waitUntilExit();
}
