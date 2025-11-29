import { readFileSync } from 'fs';

// Raw types matching the JSONL structure

interface CodexMessageContent {
  type: 'input_text' | 'output_text';
  text?: string;
}

interface CodexMessage {
  type: 'message';
  role: 'user' | 'assistant';
  content: CodexMessageContent[];
}

interface CodexFunctionCall {
  type: 'function_call';
  name: string;
  arguments: string;
  call_id: string;
}

interface CodexFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

interface CodexSessionMeta {
  type: 'session_meta';
  id: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  instructions?: string;
  source?: string;
  model_provider?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
  };
}

interface CodexTokenCount {
  type: 'token_count';
  info?: {
    total_token_usage?: {
      input_tokens?: number;
      cached_input_tokens?: number;
      output_tokens?: number;
      reasoning_output_tokens?: number;
    };
  };
}

type CodexPayload =
  | CodexSessionMeta
  | CodexMessage
  | CodexFunctionCall
  | CodexFunctionCallOutput
  | CodexTokenCount
  | { type: string }; // Catch-all for other types

interface CodexEntry {
  timestamp: string;
  type: 'session_meta' | 'response_item' | 'event_msg' | 'turn_context';
  payload: CodexPayload;
}

// Parsed/normalized types
export interface RawMessage {
  index: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string | undefined;
  toolCalls: RawToolCall[];
  files: RawFile[];
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

export interface RawConversation {
  sessionId: string;
  title: string;
  workspacePath?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: RawMessage[];
  files: RawFile[];
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
}

/**
 * Parse a single JSONL file and return entries.
 */
function parseJsonlFile(filePath: string): CodexEntry[] {
  const entries: CodexEntry[] = [];

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as CodexEntry;
        entries.push(entry);
      } catch {
        // Skip malformed JSON lines
      }
    }
  } catch {
    // Skip files we can't read
  }

  return entries;
}

/**
 * Extract text content from a message's content array.
 */
function extractTextContent(content: CodexMessageContent[]): string {
  return content
    .filter((c) => (c.type === 'input_text' || c.type === 'output_text') && c.text)
    .map((c) => c.text!)
    .join('\n');
}

/**
 * Check if content contains system/environment context that should be filtered.
 */
function isSystemContent(text: string): boolean {
  // Filter out environment context and instruction blocks
  return (
    text.includes('<environment_context>') ||
    text.includes('<INSTRUCTIONS>') ||
    text.includes('# AGENTS.md instructions') ||
    text.includes('# CLAUDE.md')
  );
}

/**
 * Extract file path from tool call arguments.
 */
function extractFilePath(toolName: string, argsJson: string): string | undefined {
  try {
    const args = JSON.parse(argsJson);
    // Common field names for file paths
    return args.filePath || args.path || args.file || args.target;
  } catch {
    return undefined;
  }
}

/**
 * Determine file role based on tool name.
 */
function getFileRole(toolName: string): RawFile['role'] {
  const readTools = ['read_file', 'list_directory', 'glob', 'grep', 'search'];
  const writeTools = ['write_file', 'apply_diff', 'create_file', 'edit_file'];

  const lowerName = toolName.toLowerCase();

  if (readTools.some((t) => lowerName.includes(t))) {
    return 'context';
  }
  if (writeTools.some((t) => lowerName.includes(t))) {
    return 'edited';
  }
  return 'mentioned';
}

/**
 * Extract conversation from a Codex session JSONL file.
 */
export function extractConversation(sessionId: string, filePath: string): RawConversation | null {
  const entries = parseJsonlFile(filePath);

  if (entries.length === 0) {
    return null;
  }

  // Extract session metadata
  const sessionMetaEntry = entries.find(
    (e) => e.type === 'session_meta' && (e.payload as CodexSessionMeta).type === 'session_meta'
  );
  const sessionMeta = sessionMetaEntry?.payload as CodexSessionMeta | undefined;

  // Extract model from turn_context if available
  let model: string | undefined;
  const turnContextEntry = entries.find((e) => e.type === 'turn_context');
  if (turnContextEntry) {
    const payload = turnContextEntry.payload as { model?: string };
    model = payload.model;
  }

  // Build a map of call_id -> output for function call results
  const toolOutputs = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === 'response_item') {
      const payload = entry.payload as CodexFunctionCallOutput;
      if (payload.type === 'function_call_output' && payload.call_id) {
        toolOutputs.set(payload.call_id, payload.output || '');
      }
    }
  }

  // Extract messages and tool calls
  const messages: RawMessage[] = [];
  const allFiles: RawFile[] = [];
  const seenPaths = new Set<string>();
  let messageIndex = 0;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let title = 'Untitled';

  // Track current message's tool calls
  let currentToolCalls: RawToolCall[] = [];
  let currentFiles: RawFile[] = [];

  for (const entry of entries) {
    // Track timestamps
    if (entry.timestamp) {
      if (!createdAt || entry.timestamp < createdAt) {
        createdAt = entry.timestamp;
      }
      if (!updatedAt || entry.timestamp > updatedAt) {
        updatedAt = entry.timestamp;
      }
    }

    if (entry.type === 'response_item') {
      const payload = entry.payload;

      if (payload.type === 'message') {
        const msg = payload as CodexMessage;
        const content = extractTextContent(msg.content);

        // Skip empty or system content
        if (!content.trim() || isSystemContent(content)) {
          continue;
        }

        // Use first user message as title
        if (msg.role === 'user' && title === 'Untitled') {
          title = content.slice(0, 100).split('\n')[0] || 'Untitled';
        }

        // If this is an assistant message, attach any pending tool calls
        const toolCalls = msg.role === 'assistant' ? currentToolCalls : [];
        const files = msg.role === 'assistant' ? currentFiles : [];

        messages.push({
          index: messageIndex++,
          role: msg.role,
          content,
          timestamp: entry.timestamp,
          toolCalls,
          files,
        });

        // Reset tool call tracking after attaching to assistant message
        if (msg.role === 'assistant') {
          currentToolCalls = [];
          currentFiles = [];
        }
      } else if (payload.type === 'function_call') {
        const fc = payload as CodexFunctionCall;
        const output = toolOutputs.get(fc.call_id);
        const filePath = extractFilePath(fc.name, fc.arguments);

        currentToolCalls.push({
          id: fc.call_id,
          name: fc.name,
          input: fc.arguments,
          output,
          filePath,
        });

        // Track files
        if (filePath && !seenPaths.has(filePath)) {
          seenPaths.add(filePath);
          const file: RawFile = { path: filePath, role: getFileRole(fc.name) };
          currentFiles.push(file);
          allFiles.push(file);
        }
      }
    }
  }

  // Extract token usage from the last token_count event
  let totalInputTokens: number | undefined;
  let totalOutputTokens: number | undefined;
  let totalCacheReadTokens: number | undefined;

  // Find all token_count events and use the last one
  const tokenCountEntries = entries.filter(
    (e) => e.type === 'event_msg' && (e.payload as CodexTokenCount).type === 'token_count'
  );

  if (tokenCountEntries.length > 0) {
    const lastTokenEntry = tokenCountEntries[tokenCountEntries.length - 1];
    const tokenPayload = lastTokenEntry?.payload as CodexTokenCount;
    const usage = tokenPayload?.info?.total_token_usage;

    if (usage) {
      totalInputTokens = usage.input_tokens;
      totalOutputTokens = usage.output_tokens;
      totalCacheReadTokens = usage.cached_input_tokens;
    }
  }

  if (messages.length === 0) {
    return null;
  }

  return {
    sessionId,
    title,
    workspacePath: sessionMeta?.cwd,
    cwd: sessionMeta?.cwd,
    gitBranch: sessionMeta?.git?.branch,
    model,
    createdAt,
    updatedAt,
    messages,
    files: allFiles,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
  };
}
