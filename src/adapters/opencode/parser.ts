import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { OpenCodeSession } from './paths.js';
import { countLines } from '../utils.js';

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
  text?: string;
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
  snapshot?: string;
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
  gitSnapshot?: string;
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
  newContent?: string;
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
  // PEAK view (sum-of-peaks, but no compaction in OpenCode so just single peak)
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheCreationTokens?: number;
  totalCacheReadTokens?: number;
  // SUM view (total across all API calls, matches billing)
  sumInputTokens?: number;
  sumOutputTokens?: number;
  sumCacheCreationTokens?: number;
  sumCacheReadTokens?: number;
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
        newContent: newString,
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
        newContent: content,
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

    let gitSnapshot: string | undefined;

    for (const part of parts) {
      if (part.type === 'step-start' && part.snapshot && !gitSnapshot) {
        gitSnapshot = part.snapshot;
      }
      if (part.type === 'step-finish') {
        if (part.tokens) {
          inputTokens = (inputTokens || 0) + (part.tokens.input || 0);
          outputTokens = (outputTokens || 0) + (part.tokens.output || 0);
          if (part.tokens.cache?.read) {
            cacheReadTokens = (cacheReadTokens || 0) + part.tokens.cache.read;
          }
          if (part.tokens.cache?.write) {
            cacheCreationTokens = (cacheCreationTokens || 0) + part.tokens.cache.write;
          }
        }
        if (part.snapshot && !gitSnapshot) {
          gitSnapshot = part.snapshot;
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
      gitSnapshot,
    });
  }

  if (rawMessages.length === 0) {
    return null;
  }

  // Calculate both PEAK and SUM token views:
  // - PEAK (sum-of-peaks): Sum of peak context from each segment between compactions
  //   Compaction is detected heuristically when context drops by >50%
  // - SUM: Total across all API calls (matches billing methodology)

  // SUM view - total across all API calls
  let sumInputTokens = 0;
  let sumCacheCreationTokens = 0;
  let sumCacheReadTokens = 0;
  let sumOutputTokens = 0;

  // PEAK view (sum-of-peaks) - track peak within each segment, sum across segments
  // A segment boundary is detected when context drops significantly (compaction heuristic)
  const COMPACTION_DROP_THRESHOLD = 0.5; // 50% drop indicates compaction
  let segmentPeakInput = 0;
  let segmentPeakCacheCreation = 0;
  let segmentPeakCacheRead = 0;
  let segmentPeakOutput = 0;
  let segmentPeakContext = 0;
  let prevContext = 0;

  // Accumulated peaks across all segments
  let totalPeakInput = 0;
  let totalPeakCacheCreation = 0;
  let totalPeakCacheRead = 0;
  let totalPeakOutput = 0;

  for (const m of rawMessages) {
    // Sum all tokens (billing view)
    sumInputTokens += m.inputTokens || 0;
    sumCacheCreationTokens += m.cacheCreationTokens || 0;
    sumCacheReadTokens += m.cacheReadTokens || 0;
    sumOutputTokens += m.outputTokens || 0;

    // Calculate this message's context
    const msgContext = (m.inputTokens || 0) + (m.cacheCreationTokens || 0) + (m.cacheReadTokens || 0);

    // Detect compaction: significant drop in context size
    const isCompaction = prevContext > 0 && msgContext > 0 &&
      msgContext < prevContext * COMPACTION_DROP_THRESHOLD;

    if (isCompaction) {
      // End previous segment - add its peak to totals
      totalPeakInput += segmentPeakInput;
      totalPeakCacheCreation += segmentPeakCacheCreation;
      totalPeakCacheRead += segmentPeakCacheRead;
      totalPeakOutput += segmentPeakOutput;

      // Start new segment with this message's context
      segmentPeakInput = m.inputTokens || 0;
      segmentPeakCacheCreation = m.cacheCreationTokens || 0;
      segmentPeakCacheRead = m.cacheReadTokens || 0;
      segmentPeakOutput = m.outputTokens || 0;
      segmentPeakContext = msgContext;
    } else {
      // Track peak context within current segment
      if (msgContext > segmentPeakContext) {
        segmentPeakContext = msgContext;
        segmentPeakInput = m.inputTokens || 0;
        segmentPeakCacheCreation = m.cacheCreationTokens || 0;
        segmentPeakCacheRead = m.cacheReadTokens || 0;
        segmentPeakOutput = m.outputTokens || 0;
      }
    }

    prevContext = msgContext;
  }

  // Don't forget to add the final segment's peak
  totalPeakInput += segmentPeakInput;
  totalPeakCacheCreation += segmentPeakCacheCreation;
  totalPeakCacheRead += segmentPeakCacheRead;
  totalPeakOutput += segmentPeakOutput;

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
    // PEAK view (sum-of-peaks across detected compaction segments)
    totalInputTokens: totalPeakInput > 0 ? totalPeakInput : undefined,
    totalOutputTokens: totalPeakOutput > 0 ? totalPeakOutput : undefined,
    totalCacheCreationTokens: totalPeakCacheCreation > 0 ? totalPeakCacheCreation : undefined,
    totalCacheReadTokens: totalPeakCacheRead > 0 ? totalPeakCacheRead : undefined,
    // SUM view (total across all API calls, matches billing)
    sumInputTokens: sumInputTokens > 0 ? sumInputTokens : undefined,
    sumOutputTokens: sumOutputTokens > 0 ? sumOutputTokens : undefined,
    sumCacheCreationTokens: sumCacheCreationTokens > 0 ? sumCacheCreationTokens : undefined,
    sumCacheReadTokens: sumCacheReadTokens > 0 ? sumCacheReadTokens : undefined,
    totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
    totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
  };
}
