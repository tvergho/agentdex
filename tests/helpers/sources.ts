/**
 * Mock source data generators for adapter tests
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

// ============ Claude Code Mock Data ============

export interface MockClaudeEntry {
  type: 'user' | 'assistant' | 'summary';
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  message?: {
    role: 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  summary?: string;
  toolUseResult?: {
    type?: string;
    filePath?: string;
    content?: string;
  };
}

export async function createClaudeCodeProject(
  baseDir: string,
  sessions: Array<{
    sessionId: string;
    entries: MockClaudeEntry[];
  }>
): Promise<string> {
  const sessionsDir = join(baseDir, '.claude', 'projects', 'test-project');
  await mkdir(sessionsDir, { recursive: true });

  for (const session of sessions) {
    const jsonl = session.entries.map((e) => JSON.stringify(e)).join('\n');
    await writeFile(join(sessionsDir, `${session.sessionId}.jsonl`), jsonl);
  }

  return sessionsDir;
}

// ============ Codex Mock Data ============

export interface MockCodexEntry {
  timestamp: string;
  type: 'session_meta' | 'response_item' | 'event_msg' | 'turn_context';
  payload: {
    type?: string;
    id?: string;
    cwd?: string;
    role?: 'user' | 'assistant';
    content?: Array<{ type: string; text?: string }>;
    name?: string;
    arguments?: string;
    call_id?: string;
    output?: string;
    model?: string;
    info?: {
      total_token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
      last_token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };
  };
}

export async function createCodexSession(
  baseDir: string,
  sessionId: string,
  entries: MockCodexEntry[]
): Promise<string> {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  const sessionDir = join(baseDir, '.codex', 'sessions', String(year), month, day);
  await mkdir(sessionDir, { recursive: true });

  const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
  const filePath = join(sessionDir, `${sessionId}.jsonl`);
  await writeFile(filePath, jsonl);

  return filePath;
}

// ============ OpenCode Mock Data ============

export interface MockOpenCodeSession {
  id: string;
  projectID: string;
  directory: string;
  title?: string;
  time: {
    created: number;
    updated?: number;
  };
}

export interface MockOpenCodeMessage {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: {
    created: number;
  };
  modelID?: string;
  tokens?: {
    input?: number;
    output?: number;
  };
}

export interface MockOpenCodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'text' | 'tool';
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    input?: Record<string, unknown>;
    output?: string;
  };
}

export async function createOpenCodeStorage(
  baseDir: string,
  data: {
    session: MockOpenCodeSession;
    messages: MockOpenCodeMessage[];
    parts: MockOpenCodePart[];
  }
): Promise<{
  storagePath: string;
  sessionFile: string;
  messageDir: string;
}> {
  const storagePath = join(baseDir, '.local', 'share', 'opencode', 'storage');
  const sessionDir = join(storagePath, 'session', data.session.projectID);
  const messageDir = join(storagePath, 'message', data.session.id);
  const partBaseDir = join(storagePath, 'part');

  await mkdir(sessionDir, { recursive: true });
  await mkdir(messageDir, { recursive: true });

  // Write session file
  const sessionFile = join(sessionDir, `${data.session.id}.json`);
  await writeFile(sessionFile, JSON.stringify(data.session));

  // Write message files
  for (const msg of data.messages) {
    const msgFile = join(messageDir, `${msg.id}.json`);
    await writeFile(msgFile, JSON.stringify(msg));
  }

  // Write part files
  for (const part of data.parts) {
    const partDir = join(partBaseDir, part.messageID);
    await mkdir(partDir, { recursive: true });
    const partFile = join(partDir, `${part.id}.json`);
    await writeFile(partFile, JSON.stringify(part));
  }

  return { storagePath, sessionFile, messageDir };
}

// ============ Cursor Mock Data (SQLite is more complex) ============

// For Cursor, we'll test the parser functions directly with mock data
// rather than creating a full SQLite database

export interface MockCursorBubble {
  bubbleId: string;
  type: number; // 1 = user, 2 = assistant
  text: string;
  relevantFiles?: string[];
  tokenCount?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface MockCursorComposerData {
  composerId: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  forceMode?: string;
  conversation?: MockCursorBubble[];
  conversationMap?: Record<string, MockCursorBubble>;
  fullConversationHeadersOnly?: Array<{ bubbleId: string; type?: number }>;
  context?: {
    fileSelections?: Array<{ uri?: { fsPath?: string } }>;
  };
  codeBlockData?: Record<string, Record<string, { diffId?: string; uri?: { fsPath?: string }; bubbleId?: string }>>;
}

// Helper to create a minimal conversation entry for testing
export function createMockCursorConversation(
  composerId: string,
  bubbles: MockCursorBubble[],
  options: {
    name?: string;
    forceMode?: string;
    fileSelections?: string[];
  } = {}
): MockCursorComposerData {
  return {
    composerId,
    name: options.name ?? 'Test Conversation',
    createdAt: Date.now() - 3600000, // 1 hour ago
    lastUpdatedAt: Date.now(),
    forceMode: options.forceMode,
    conversation: bubbles,
    context: options.fileSelections
      ? { fileSelections: options.fileSelections.map((p) => ({ uri: { fsPath: p } })) }
      : undefined,
  };
}

export function createMockCursorBubble(
  type: 'user' | 'assistant',
  text: string,
  options: {
    bubbleId?: string;
    relevantFiles?: string[];
    inputTokens?: number;
    outputTokens?: number;
  } = {}
): MockCursorBubble {
  return {
    bubbleId: options.bubbleId ?? `bubble-${Math.random().toString(36).slice(2, 10)}`,
    type: type === 'user' ? 1 : 2,
    text,
    relevantFiles: options.relevantFiles,
    tokenCount:
      options.inputTokens || options.outputTokens
        ? { inputTokens: options.inputTokens, outputTokens: options.outputTokens }
        : undefined,
  };
}

