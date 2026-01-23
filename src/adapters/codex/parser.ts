import { readFileSync } from 'fs';
import { countLines } from '../utils.js';

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

interface CodexCustomToolCall {
  type: 'custom_tool_call';
  name: string;
  input: string;
  call_id: string;
  status?: string;
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
    repository_url?: string;
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
    last_token_usage?: {
      input_tokens?: number;
      cached_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

type CodexPayload =
  | CodexSessionMeta
  | CodexMessage
  | CodexFunctionCall
  | CodexCustomToolCall
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
  fileEdits: RawFileEdit[];
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
  workspacePath?: string;
  projectName?: string;
  cwd?: string;
  gitBranch?: string;
  gitCommitHash?: string;
  gitRepositoryUrl?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: RawMessage[];
  files: RawFile[];
  fileEdits: RawFileEdit[];
  // PEAK view (max context window, no compaction in Codex)
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  // SUM view (total across all API calls, matches billing)
  sumInputTokens?: number;
  sumOutputTokens?: number;
  sumCacheReadTokens?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
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
  const writeTools = ['write_file', 'apply_diff', 'apply_patch', 'create_file', 'edit_file'];

  const lowerName = toolName.toLowerCase();

  if (readTools.some((t) => lowerName.includes(t))) {
    return 'context';
  }
  if (writeTools.some((t) => lowerName.includes(t))) {
    return 'edited';
  }
  return 'mentioned';
}

// Extract workspace path from file paths (with fallback for mixed system paths)
function extractWorkspacePath(filePaths: string[]): string | undefined {
  if (filePaths.length === 0) return undefined;

  const absolutePaths = filePaths.filter((p) => p.startsWith('/'));
  if (absolutePaths.length === 0) return undefined;

  const projectIndicators = ['src', 'lib', 'app', 'packages', 'node_modules', 'dist', 'test', 'tests', 'scripts'];

  const deriveFromPaths = (paths: string[]): string | undefined => {
    const splitPaths = paths
      .map((p) => p.split('/').filter(Boolean))
      .filter((parts) => parts.length > 0);
    if (splitPaths.length === 0) return undefined;

    const firstPath = splitPaths[0];
    if (!firstPath || firstPath.length === 0) return undefined;

    const commonParts: string[] = [];
    for (let i = 0; i < firstPath.length; i++) {
      const part = firstPath[i];
      if (part && splitPaths.every((p) => p[i] === part)) {
        commonParts.push(part);
      } else {
        break;
      }
    }

    if (commonParts.length === 0) return undefined;

    const projectIdx = commonParts.findIndex((p) => projectIndicators.includes(p));
    if (projectIdx > 0) {
      return '/' + commonParts.slice(0, projectIdx).join('/');
    }

    if (commonParts.length > 1) {
      const lastPart = commonParts[commonParts.length - 1];
      if (lastPart && lastPart.includes('.')) {
        return '/' + commonParts.slice(0, -1).join('/');
      }
      return '/' + commonParts.join('/');
    }

    return undefined;
  };

  const fromAll = deriveFromPaths(absolutePaths);
  if (fromAll) return fromAll;

  const candidateCounts = new Map<string, number>();
  for (const absPath of absolutePaths) {
    const candidate = deriveFromPaths([absPath]);
    if (!candidate) continue;
    candidateCounts.set(candidate, (candidateCounts.get(candidate) ?? 0) + 1);
  }

  if (candidateCounts.size === 0) return undefined;

  const [bestWorkspace] = Array.from(candidateCounts.entries())
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))[0]!;

  return bestWorkspace;
}

function extractProjectName(workspacePath: string | undefined): string | undefined {
  if (!workspacePath) return undefined;
  const parts = workspacePath.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

/**
 * Parse apply_patch unified diff format to extract file edits.
 * Format:
 * *** Begin Patch
 * *** Add File: path/to/new-file.ts
 * +line 1
 * +line 2
 * *** End Patch
 * *** Begin Patch
 * *** Update File: path/to/existing.ts
 * @@
 * -old line
 * +new line
 * @@
 * *** End Patch
 */
function parseApplyPatch(patchInput: string): RawFileEdit[] {
  const edits: RawFileEdit[] = [];
  const lines = patchInput.split('\n');
  let currentFile: RawFileEdit | null = null;

  for (const line of lines) {
    if (line.startsWith('*** Add File:')) {
      currentFile = {
        filePath: line.replace('*** Add File:', '').trim(),
        editType: 'create',
        linesAdded: 0,
        linesRemoved: 0,
      };
      edits.push(currentFile);
    } else if (line.startsWith('*** Update File:')) {
      currentFile = {
        filePath: line.replace('*** Update File:', '').trim(),
        editType: 'modify',
        linesAdded: 0,
        linesRemoved: 0,
      };
      edits.push(currentFile);
    } else if (line.startsWith('*** Delete File:')) {
      currentFile = {
        filePath: line.replace('*** Delete File:', '').trim(),
        editType: 'delete',
        linesAdded: 0,
        linesRemoved: 0,
      };
      edits.push(currentFile);
    } else if (currentFile) {
      // Count line additions and removals
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentFile.linesAdded++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentFile.linesRemoved++;
      }
    }
  }

  return edits;
}

/**
 * Extract file edits from tool calls (apply_patch and write_file).
 */
function extractFileEditsFromToolCalls(toolCalls: RawToolCall[]): RawFileEdit[] {
  const edits: RawFileEdit[] = [];

  for (const tc of toolCalls) {
    const lowerName = tc.name.toLowerCase();

    if (lowerName === 'apply_patch') {
      // The input is the patch content directly
      const patchEdits = parseApplyPatch(tc.input);
      edits.push(...patchEdits);
    } else if (lowerName === 'write_file' || lowerName === 'create_file') {
      try {
        const args = JSON.parse(tc.input);
        const filePath = args.path || args.filePath || args.file;
        const content = args.content || '';

        if (filePath) {
          edits.push({
            filePath,
            editType: 'create',
            linesAdded: countLines(content),
            linesRemoved: 0,
          });
        }
      } catch {
        // Skip malformed input
      }
    }
  }

  return edits;
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
  const sessionMetaEntry = entries.find((e) => e.type === 'session_meta');
  const sessionMeta = sessionMetaEntry?.payload as CodexSessionMeta | undefined;

  // Extract model/cwd from turn_context if available (can appear multiple times)
  let model: string | undefined;
  let turnContextCwd: string | undefined;
  for (const entry of entries) {
    if (entry.type === 'turn_context') {
      const payload = entry.payload as { model?: string; cwd?: string };
      if (!model && payload.model) {
        model = payload.model;
      }
      if (!turnContextCwd && payload.cwd) {
        turnContextCwd = payload.cwd;
      }
    }
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
  const allEdits: RawFileEdit[] = [];
  const seenPaths = new Set<string>();
  let messageIndex = 0;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let title = 'Untitled';

  // Track current message's tool calls and edits
  let currentToolCalls: RawToolCall[] = [];
  let currentFiles: RawFile[] = [];
  let currentEdits: RawFileEdit[] = [];

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

        if (msg.role === 'user' && title === 'Untitled') {
          const lines = content.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('<') && !trimmed.startsWith('#')) {
              title = trimmed.slice(0, 100);
              break;
            }
          }
        }

        // If this is an assistant message, attach any pending tool calls and edits
        const toolCalls = msg.role === 'assistant' ? currentToolCalls : [];
        const files = msg.role === 'assistant' ? currentFiles : [];
        const fileEdits = msg.role === 'assistant' ? currentEdits : [];

        // For assistant messages, append tool outputs to content
        let finalContent = content;
        if (msg.role === 'assistant' && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            if (tc.output) {
              const fileName = tc.filePath ? tc.filePath.split('/').pop() : '';
              finalContent += '\n\n---\n';
              finalContent += `**${tc.name}**${fileName ? ` \`${fileName}\`` : ''}\n`;
              finalContent += '```\n';
              finalContent += tc.output;
              finalContent += '\n```\n---';
            }
          }
        }

        // Calculate per-message line totals
        const totalLinesAdded = fileEdits.reduce((sum, e) => sum + e.linesAdded, 0);
        const totalLinesRemoved = fileEdits.reduce((sum, e) => sum + e.linesRemoved, 0);

        messages.push({
          index: messageIndex++,
          role: msg.role,
          content: finalContent,
          timestamp: entry.timestamp,
          toolCalls,
          files,
          fileEdits,
          totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
          totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
        });

        // Add edits to conversation-level list
        allEdits.push(...fileEdits);

        // Reset tool call and edit tracking after attaching to assistant message
        if (msg.role === 'assistant') {
          currentToolCalls = [];
          currentFiles = [];
          currentEdits = [];
        }
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        // Handle both function_call (older) and custom_tool_call (newer) formats
        const isCustom = payload.type === 'custom_tool_call';
        const fc = payload as CodexFunctionCall | CodexCustomToolCall;
        const output = toolOutputs.get(fc.call_id);
        // custom_tool_call uses 'input', function_call uses 'arguments'
        const inputStr = isCustom ? (fc as CodexCustomToolCall).input : (fc as CodexFunctionCall).arguments;
        const filePath = extractFilePath(fc.name, inputStr);

        const toolCall: RawToolCall = {
          id: fc.call_id,
          name: fc.name,
          input: inputStr,
          output,
          filePath,
        };
        currentToolCalls.push(toolCall);

        // Extract file edits from this tool call
        const editsFromCall = extractFileEditsFromToolCalls([toolCall]);
        currentEdits.push(...editsFromCall);

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

  // Extract token usage from token_count events
  // Track both PEAK (sum-of-peaks across compaction segments) and SUM (cumulative) views
  const tokenCountEntries = entries.filter(
    (e) => e.type === 'event_msg' && (e.payload as CodexTokenCount).type === 'token_count'
  );

  // SUM view - cumulative totals from last event (matches billing)
  let sumInputTokens: number | undefined;
  let sumCacheReadTokens: number | undefined;
  let sumOutputTokens: number | undefined;

  // PEAK view (sum-of-peaks) - track peak within each segment, sum across segments
  // A segment boundary is detected when context drops significantly (compaction heuristic)
  const COMPACTION_DROP_THRESHOLD = 0.5; // 50% drop indicates compaction
  let segmentPeakInput = 0;
  let segmentPeakCacheRead = 0;
  let segmentPeakOutput = 0;
  let segmentPeakContext = 0;
  let prevContext = 0;

  // Accumulated peaks across all segments
  let totalPeakInput = 0;
  let totalPeakCacheRead = 0;
  let totalPeakOutput = 0;

  // Track previous cumulative to calculate per-call deltas
  let prevCumulativeInput = 0;
  let prevCumulativeCached = 0;

  for (const tokenEntry of tokenCountEntries) {
    const tokenPayload = tokenEntry?.payload as CodexTokenCount;
    const totalUsage = tokenPayload?.info?.total_token_usage;
    const lastUsage = tokenPayload?.info?.last_token_usage;

    if (totalUsage) {
      // Update SUM view with latest cumulative
      sumInputTokens = totalUsage.input_tokens;
      sumCacheReadTokens = totalUsage.cached_input_tokens;
      sumOutputTokens = totalUsage.output_tokens;

      // Calculate per-call context (delta from previous cumulative)
      const currInput = totalUsage.input_tokens || 0;
      const currCached = totalUsage.cached_input_tokens || 0;

      // Use last_token_usage if available for more accurate per-call data
      const callInput = lastUsage?.input_tokens ?? (currInput - prevCumulativeInput);
      const callCached = lastUsage?.cached_input_tokens ?? (currCached - prevCumulativeCached);
      const callContext = callInput + callCached;
      const callOutput = lastUsage?.output_tokens ?? totalUsage.output_tokens ?? 0;

      // Detect compaction: significant drop in context size
      const isCompaction = prevContext > 0 && callContext > 0 &&
        callContext < prevContext * COMPACTION_DROP_THRESHOLD;

      if (isCompaction) {
        // End previous segment - add its peak to totals
        totalPeakInput += segmentPeakInput;
        totalPeakCacheRead += segmentPeakCacheRead;
        totalPeakOutput += segmentPeakOutput;

        // Start new segment
        segmentPeakInput = callInput;
        segmentPeakCacheRead = callCached;
        segmentPeakOutput = callOutput;
        segmentPeakContext = callContext;
      } else {
        // Track peak context within current segment
        if (callContext > segmentPeakContext) {
          segmentPeakContext = callContext;
          segmentPeakInput = callInput;
          segmentPeakCacheRead = callCached;
          segmentPeakOutput = callOutput;
        }
      }

      prevContext = callContext;
      prevCumulativeInput = currInput;
      prevCumulativeCached = currCached;
    }
  }

  // Add the final segment's peak
  totalPeakInput += segmentPeakInput;
  totalPeakCacheRead += segmentPeakCacheRead;
  totalPeakOutput += segmentPeakOutput;

  // Use sum-of-peaks for PEAK view, fallback to SUM if no peaks tracked
  const totalInputTokens = totalPeakInput > 0 ? totalPeakInput : sumInputTokens;
  const totalCacheReadTokens = totalPeakCacheRead > 0 ? totalPeakCacheRead : sumCacheReadTokens;
  const totalOutputTokens = totalPeakOutput > 0 ? totalPeakOutput : sumOutputTokens;

  if (messages.length === 0) {
    return null;
  }

  // Calculate total line changes
  const totalLinesAdded = allEdits.reduce((sum, e) => sum + e.linesAdded, 0);
  const totalLinesRemoved = allEdits.reduce((sum, e) => sum + e.linesRemoved, 0);

  const sessionCwd = sessionMeta?.cwd?.trim() || undefined;
  const workspaceFromFiles = extractWorkspacePath([
    ...allFiles.map((f) => f.path),
    ...allEdits.map((e) => e.filePath),
  ]);
  const workspacePath = sessionCwd || turnContextCwd || workspaceFromFiles;
  const projectName = extractProjectName(workspacePath) || extractProjectName(workspaceFromFiles);

  return {
    sessionId,
    title,
    workspacePath,
    projectName,
    cwd: sessionCwd || turnContextCwd,
    gitBranch: sessionMeta?.git?.branch,
    gitCommitHash: sessionMeta?.git?.commit_hash,
    gitRepositoryUrl: sessionMeta?.git?.repository_url,
    model,
    createdAt,
    updatedAt,
    messages,
    files: allFiles,
    fileEdits: allEdits,
    // PEAK view (max context window)
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    // SUM view (cumulative, matches billing)
    sumInputTokens,
    sumOutputTokens,
    sumCacheReadTokens,
    totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
    totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
  };
}
