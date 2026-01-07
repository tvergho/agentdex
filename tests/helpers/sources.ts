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
  isSidechain?: boolean;
  message?: {
    role: 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string }>;
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


