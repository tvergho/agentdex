import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { OpenCodeSession } from './paths.js';

// ============ Raw JSON Types (matching OpenCode storage format) ============

interface OpenCodeSessionJson {
  id: string;
  version?: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title?: string;
  time: {
    created: number;
    updated?: number;
  };
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
}

interface OpenCodeMessageJson {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: {
    created: number;
    completed?: number;
  };
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string; // 'build', 'plan', etc.
  path?: {
    cwd?: string;
    root?: string;
  };
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  finish?: string;
  summary?: {
    title?: string;
    body?: string;
    diffs?: Array<{
      file?: string;
      additions?: number;
      deletions?: number;
    }>;
  };
  agent?: string;
  model?: {
    providerID?: string;
    modelID?: string;
  };
}

interface OpenCodePartJson {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'text' | 'tool' | 'reasoning' | 'step-start' | 'step-finish';
  // Text part
  text?: string;
  // Tool part
  callID?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: {
      start?: number;
      end?: number;
    };
  };
  // Step-finish part
  reason?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  // Reasoning part
  metadata?: {
    openai?: {
      itemId?: string;
      reasoningEncryptedContent?: string;
    };
  };
  time?: {
    start?: number;
    end?: number;
  };
}

// ============ Parsed/Normalized Types ============

export interface RawMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string | undefined;
  toolCalls: RawToolCall[];
  files: RawFile[];
  fileEdits: RawFileEdit[];
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
}

export interface RawToolCall {
  id: string;
  name: string;
  input: string;
  output?: string;
  filePath?: string;
}

export interface RawFile {
  path: string;
  role: 'context' | 'edited' | 'mentioned';
}

export interface RawFileEdit {
  filePath: string;
  editType: 'create' | 'modify' | 'delete';
  linesAdded: number;
  linesRemoved: number;
}

export interface RawConversation {
  sessionId: string;
  title: string;
  workspacePath: string;
  directory?: string;
  model?: string;
  mode?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: RawMessage[];
  files: RawFile[];
  fileEdits: RawFileEdit[];
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheCreationTokens?: number;
  totalCacheReadTokens?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
}

/**
 * Parse a session JSON file.
 */
function parseSessionFile(filePath: string): OpenCodeSessionJson | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as OpenCodeSessionJson;
  } catch {
    return null;
  }
}

/**
 * Parse a message JSON file.
 */
function parseMessageFile(filePath: string): OpenCodeMessageJson | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as OpenCodeMessageJson;
  } catch {
    return null;
  }
}

/**
 * Parse a part JSON file.
 */
function parsePartFile(filePath: string): OpenCodePartJson | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as OpenCodePartJson;
  } catch {
    return null;
  }
}

/**
 * Convert timestamp (ms) to ISO string.
 */
function timestampToIso(ts: number | undefined): string | undefined {
  if (!ts) return undefined;
  try {
    return new Date(ts).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Count lines in a string.
 */
function countLines(str: string): number {
  if (!str) return 0;
  return str.split('\n').length;
}

/**
 * Extract file path from tool input.
 */
function extractFilePath(input: Record<string, unknown>): string | undefined {
  // Common patterns for file paths in tool inputs
  return (
    (input.filePath as string) ||
    (input.file_path as string) ||
    (input.path as string) ||
    (input.file as string)
  );
}

/**
 * Determine file role based on tool name.
 */
function getFileRole(toolName: string): RawFile['role'] {
  const contextTools = ['read', 'glob', 'grep', 'list', 'webfetch'];
  const editTools = ['write', 'edit'];

  const lowerName = toolName.toLowerCase();

  if (contextTools.some((t) => lowerName.includes(t))) {
    return 'context';
  }
  if (editTools.some((t) => lowerName.includes(t))) {
    return 'edited';
  }
  return 'mentioned';
}

/**
 * Extract file edits from tool calls.
 */
function extractFileEditsFromToolCall(
  toolName: string,
  input: Record<string, unknown>
): RawFileEdit | null {
  const lowerName = toolName.toLowerCase();

  if (lowerName === 'edit') {
    const filePath = extractFilePath(input);
    const oldString = (input.oldString as string) || (input.old_string as string) || '';
    const newString = (input.newString as string) || (input.new_string as string) || '';

    if (filePath) {
      return {
        filePath,
        editType: 'modify',
        linesRemoved: countLines(oldString),
        linesAdded: countLines(newString),
      };
    }
  } else if (lowerName === 'write') {
    const filePath = extractFilePath(input);
    const content = (input.content as string) || '';

    if (filePath) {
      return {
        filePath,
        editType: 'create',
        linesRemoved: 0,
        linesAdded: countLines(content),
      };
    }
  }

  return null;
}

/**
 * Extract all conversations from a session.
 */
export function extractConversation(session: OpenCodeSession): RawConversation | null {
  const storagePath = join(session.sessionFile, '..', '..', '..');
  const partBaseDir = join(storagePath, 'part');

  // Parse session file
  const sessionData = parseSessionFile(session.sessionFile);
  if (!sessionData) {
    return null;
  }

  // Skip sub-sessions (those with parentID are typically agent sub-conversations)
  if (sessionData.parentID) {
    return null;
  }

  // Find all message files for this session
  const messageDir = session.messageDir;
  if (!existsSync(messageDir)) {
    return null;
  }

  const messageFiles = readdirSync(messageDir).filter(
    (f) => f.endsWith('.json') && f.startsWith('msg_')
  );

  if (messageFiles.length === 0) {
    return null;
  }

  // Parse all messages
  const messages: Array<{ msg: OpenCodeMessageJson; parts: OpenCodePartJson[] }> = [];

  for (const messageFile of messageFiles) {
    const msgData = parseMessageFile(join(messageDir, messageFile));
    if (!msgData) continue;

    // Find parts for this message
    const messageId = messageFile.replace('.json', '');
    const partDir = join(partBaseDir, messageId);
    const parts: OpenCodePartJson[] = [];

    if (existsSync(partDir)) {
      const partFiles = readdirSync(partDir).filter(
        (f) => f.endsWith('.json') && f.startsWith('prt_')
      );

      for (const partFile of partFiles) {
        const partData = parsePartFile(join(partDir, partFile));
        if (partData) {
          parts.push(partData);
        }
      }
    }

    messages.push({ msg: msgData, parts });
  }

  // Sort messages by creation time
  messages.sort((a, b) => a.msg.time.created - b.msg.time.created);

  // Convert to RawMessages
  const rawMessages: RawMessage[] = [];
  const allFiles: RawFile[] = [];
  const allEdits: RawFileEdit[] = [];
  const seenPaths = new Set<string>();
  let model: string | undefined;
  let mode: string | undefined;

  for (const { msg, parts } of messages) {
    // Extract text content from parts
    let content = '';
    const toolCalls: RawToolCall[] = [];
    const files: RawFile[] = [];
    const fileEdits: RawFileEdit[] = [];

    const isAssistant = msg.role === 'assistant';
    
    for (const part of parts) {
      if (part.type === 'text' && part.text) {
        content += part.text;
      } else if (part.type === 'tool' && part.tool && part.state) {
        const tc: RawToolCall = {
          id: part.callID || part.id,
          name: part.tool,
          input: JSON.stringify(part.state.input || {}),
          output: part.state.output,
          filePath: part.state.input ? extractFilePath(part.state.input) : undefined,
        };
        toolCalls.push(tc);

        // For assistant messages, interleave tool output in content
        if (isAssistant && tc.output) {
          const fileName = tc.filePath ? tc.filePath.split('/').pop() : '';
          content += '\n\n---\n';
          content += `**${tc.name}**${fileName ? ` \`${fileName}\`` : ''}\n`;
          content += '```\n';
          content += tc.output;
          content += '\n```\n---\n';
        }

        // Extract file from tool call
        if (tc.filePath && !seenPaths.has(tc.filePath)) {
          seenPaths.add(tc.filePath);
          const role = getFileRole(tc.name);
          files.push({ path: tc.filePath, role });
          allFiles.push({ path: tc.filePath, role });
        }

        // Extract file edits from tool call
        if (part.state.input) {
          const edit = extractFileEditsFromToolCall(part.tool, part.state.input);
          if (edit) {
            fileEdits.push(edit);
            allEdits.push(edit);
          }
        }
      }
    }

    // Get tokens from message or step-finish parts
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let cacheCreationTokens: number | undefined;

    // First check message-level tokens
    if (msg.tokens) {
      inputTokens = msg.tokens.input;
      outputTokens = msg.tokens.output;
      cacheReadTokens = msg.tokens.cache?.read;
      cacheCreationTokens = msg.tokens.cache?.write;
    }

    // Also check step-finish parts for aggregated tokens
    for (const part of parts) {
      if (part.type === 'step-finish' && part.tokens) {
        // Prefer step-finish tokens as they may be more accurate
        inputTokens = (inputTokens || 0) + (part.tokens.input || 0);
        outputTokens = (outputTokens || 0) + (part.tokens.output || 0);
        if (part.tokens.cache?.read) {
          cacheReadTokens = (cacheReadTokens || 0) + part.tokens.cache.read;
        }
        if (part.tokens.cache?.write) {
          cacheCreationTokens = (cacheCreationTokens || 0) + part.tokens.cache.write;
        }
      }
    }

    // Calculate per-message line totals
    const totalLinesAdded = fileEdits.reduce((sum, e) => sum + e.linesAdded, 0);
    const totalLinesRemoved = fileEdits.reduce((sum, e) => sum + e.linesRemoved, 0);

    // Track model and mode
    if (!model && msg.modelID) {
      model = msg.modelID;
    }
    if (!mode && msg.mode) {
      mode = msg.mode;
    }

    rawMessages.push({
      id: msg.id,
      role: msg.role,
      content,
      timestamp: timestampToIso(msg.time.created),
      toolCalls,
      files,
      fileEdits,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
      totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
    });
  }

  if (rawMessages.length === 0) {
    return null;
  }

  // Calculate conversation-level token totals
  // For input context, find the peak (each API call has full context)
  // For output tokens, SUM (each output is new content)
  let peakMessage: RawMessage | undefined;
  let peakContext = 0;
  for (const m of rawMessages) {
    const totalContext =
      (m.inputTokens || 0) + (m.cacheCreationTokens || 0) + (m.cacheReadTokens || 0);
    if (totalContext > peakContext) {
      peakContext = totalContext;
      peakMessage = m;
    }
  }
  const totalInputTokens = peakContext || 0;
  const totalCacheCreationTokens = peakMessage?.cacheCreationTokens || 0;
  const totalCacheReadTokens = peakMessage?.cacheReadTokens || 0;
  const totalOutputTokens = rawMessages.reduce((sum, m) => sum + (m.outputTokens || 0), 0);

  // Calculate total line changes
  const totalLinesAdded = allEdits.reduce((sum, e) => sum + e.linesAdded, 0);
  const totalLinesRemoved = allEdits.reduce((sum, e) => sum + e.linesRemoved, 0);

  return {
    sessionId: session.sessionId,
    title: sessionData.title || 'Untitled',
    workspacePath: session.workspacePath,
    directory: sessionData.directory,
    model,
    mode,
    createdAt: timestampToIso(sessionData.time.created),
    updatedAt: timestampToIso(sessionData.time.updated),
    messages: rawMessages,
    files: allFiles,
    fileEdits: allEdits,
    totalInputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
    totalOutputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
    totalCacheCreationTokens: totalCacheCreationTokens > 0 ? totalCacheCreationTokens : undefined,
    totalCacheReadTokens: totalCacheReadTokens > 0 ? totalCacheReadTokens : undefined,
    totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
    totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
  };
}
