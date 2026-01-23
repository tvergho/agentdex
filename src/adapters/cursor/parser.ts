import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import { mkdtempSync, cpSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';

export interface RawBubble {
  bubbleId: string;
  type: 'user' | 'assistant' | 'system';
  text: string;
  files: RawFile[]; // files associated with this specific bubble
  fileEdits: RawFileEdit[]; // edits made in this bubble
  inputTokens?: number;
  outputTokens?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
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
  startLine?: number;
  endLine?: number;
  bubbleId?: string; // Associate edit with a specific bubble
  newContent?: string; // The new code content from the diff
}

export interface RawConversation {
  composerId: string;
  name: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  bubbles: RawBubble[];
  workspacePath?: string;
  projectName?: string;
  mode?: string;
  model?: string;
  files: RawFile[];
  fileEdits: RawFileEdit[];
  // PEAK view (max context window)
  // Note: Cursor conversation data doesn't track per-call tokens reliably
  // Use billing_events table for accurate SUM data
  totalInputTokens?: number;
  totalOutputTokens?: number;
  // SUM view (same as PEAK for Cursor - use billing_events for accurate data)
  sumInputTokens?: number;
  sumOutputTokens?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
}

interface FileSelection {
  uri?: {
    fsPath?: string;
    path?: string;
  };
}

interface ContextData {
  fileSelections?: FileSelection[];
  folderSelections?: Array<{ uri?: { fsPath?: string; path?: string } }>;
}

interface BubbleData {
  bubbleId?: string;
  type?: number;
  text?: string;
  relevantFiles?: string[];
  context?: ContextData;
  tokenCount?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

interface ModelConfig {
  modelName?: string;
  maxMode?: boolean;
}

interface ComposerDataEntry {
  composerId: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  forceMode?: string; // 'chat', 'edit', 'agent'
  modelConfig?: ModelConfig; // Available in schema v9+ (April 2025+)
  context?: ContextData;
  conversation?: BubbleData[];
  conversationMap?: Record<string, BubbleData>;
  fullConversationHeadersOnly?: Array<{
    bubbleId?: string;
    type?: number;
  }>;
  codeBlockData?: Record<string, Record<string, CodeBlockEntry>>;
}

// Code block entry in composerData.codeBlockData[fileUri][blockId]
interface CodeBlockEntry {
  diffId?: string;
  uri?: { fsPath?: string; path?: string };
  bubbleId?: string;
  languageId?: string;
  status?: string;
}

// Mapping from diffId to file path and bubble
interface CodeBlockMapping {
  diffId: string;
  filePath: string;
  bubbleId: string;
  languageId?: string;
}

// Diff entry structure from codeBlockDiff entries
interface DiffEntry {
  original: {
    startLineNumber: number;
    endLineNumberExclusive: number;
  };
  modified: string[];
}

// Map numeric bubble type to role
function mapBubbleType(type: number | undefined): RawBubble['type'] {
  // Type 1 = user, Type 2 = assistant
  if (type === 1) return 'user';
  if (type === 2) return 'assistant';
  return 'user';
}

function loadWorkspaceHistoryFromFiles(): string[] {
  const workspaces: string[] = [];
  
  const workspaceStorageDir = join(homedir(), 'Library/Application Support/Cursor/User/workspaceStorage');
  if (!existsSync(workspaceStorageDir)) return workspaces;
  
  try {
    const subdirs = readdirSync(workspaceStorageDir, { withFileTypes: true });
    for (const subdir of subdirs) {
      if (!subdir.isDirectory()) continue;
      
      const workspaceJsonPath = join(workspaceStorageDir, subdir.name, 'workspace.json');
      if (!existsSync(workspaceJsonPath)) continue;
      
      try {
        const content = readFileSync(workspaceJsonPath, 'utf-8');
        const data = JSON.parse(content);
        const folder = data.folder;
        if (folder?.startsWith('file://')) {
          workspaces.push(decodeURIComponent(folder.replace('file://', '')));
        }
      } catch {}
    }
  } catch {}
  
  return workspaces;
}

function resolveRelativePathsToWorkspace(
  relativePaths: string[],
  knownWorkspaces: string[]
): string | undefined {
  if (relativePaths.length === 0 || knownWorkspaces.length === 0) return undefined;
  
  const workspaceMatches = new Map<string, number>();
  
  for (const relPath of relativePaths) {
    if (!relPath || relPath.startsWith('/')) continue;
    
    for (const workspace of knownWorkspaces) {
      const fullPath = join(workspace, relPath);
      if (existsSync(fullPath)) {
        workspaceMatches.set(workspace, (workspaceMatches.get(workspace) || 0) + 1);
      }
    }
  }
  
  if (workspaceMatches.size === 0) return undefined;
  
  let bestWorkspace: string | undefined;
  let maxMatches = 0;
  for (const [workspace, count] of workspaceMatches) {
    if (count > maxMatches) {
      maxMatches = count;
      bestWorkspace = workspace;
    }
  }
  
  return bestWorkspace;
}

// Extract workspace path from file paths (handles outliers like stdlib paths)
// Optimized O(f) algorithm - single pass with early termination
function extractWorkspacePath(filePaths: string[]): string | undefined {
  if (filePaths.length === 0) return undefined;

  const projectIndicators = new Set(['src', 'lib', 'app', 'packages', 'node_modules', 'dist', 'test', 'tests', 'scripts']);
  const nonProjectDirectories = new Set(['Documents', 'Desktop', 'Downloads', 'Library', 'Applications', 'Pictures', 'Movies', 'Music']);
  const MIN_WORKSPACE_DEPTH = 4;

  const isValidWorkspacePath = (path: string): boolean => {
    const parts = path.split('/').filter(Boolean);
    if (parts.length < MIN_WORKSPACE_DEPTH) return false;
    const lastPart = parts[parts.length - 1];
    if (lastPart && nonProjectDirectories.has(lastPart)) return false;
    return true;
  };

  // Filter to absolute paths and split them in one pass
  const splitPaths: string[][] = [];
  for (const p of filePaths) {
    if (p.startsWith('/')) {
      const parts = p.split('/');
      // Remove empty first element from leading slash
      if (parts.length > 1) {
        parts.shift();
        splitPaths.push(parts);
      }
    }
  }

  if (splitPaths.length === 0) return undefined;

  const firstPath = splitPaths[0]!;
  if (firstPath.length === 0) return undefined;

  // Single pass: find common prefix parts
  const commonParts: string[] = [];
  for (let i = 0; i < firstPath.length; i++) {
    const part = firstPath[i]!;
    let allMatch = true;
    for (let j = 1; j < splitPaths.length; j++) {
      if (splitPaths[j]![i] !== part) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      commonParts.push(part);
    } else {
      break;
    }
  }

  if (commonParts.length === 0) {
    // No common prefix - use first path up to project indicator or parent of file
    let cutoff = firstPath.length;
    for (let i = 0; i < firstPath.length; i++) {
      if (projectIndicators.has(firstPath[i]!)) {
        cutoff = i;
        break;
      }
    }
    // If no indicator found, exclude the filename
    if (cutoff === firstPath.length && firstPath.length > 1) {
      const lastPart = firstPath[firstPath.length - 1];
      if (lastPart && lastPart.includes('.')) {
        cutoff = firstPath.length - 1;
      }
    }
    if (cutoff > 0) {
      const candidate = '/' + firstPath.slice(0, cutoff).join('/');
      return isValidWorkspacePath(candidate) ? candidate : undefined;
    }
    return undefined;
  }

  for (let i = 0; i < commonParts.length; i++) {
    if (projectIndicators.has(commonParts[i]!)) {
      if (i > 0) {
        const candidate = '/' + commonParts.slice(0, i).join('/');
        return isValidWorkspacePath(candidate) ? candidate : undefined;
      }
      return undefined;
    }
  }

  if (commonParts.length > 1) {
    const lastPart = commonParts[commonParts.length - 1];
    let candidate: string;
    if (lastPart && lastPart.includes('.')) {
      candidate = '/' + commonParts.slice(0, -1).join('/');
    } else {
      candidate = '/' + commonParts.join('/');
    }
    return isValidWorkspacePath(candidate) ? candidate : undefined;
  }

  return undefined;
}

function findRepoRoot(workspacePath: string): string {
  const MIN_PATH_DEPTH = 3;
  let current = workspacePath;
  
  while (current !== '/') {
    const parts = current.split('/').filter(Boolean);
    if (parts.length <= MIN_PATH_DEPTH) break;
    
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    current = dirname(current);
  }
  
  return workspacePath;
}

function extractProjectName(workspacePath: string | undefined): string | undefined {
  if (!workspacePath) return undefined;
  const parts = workspacePath.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

// Extract file paths from message text content
// Parses Cursor's code reference format (```42:186:path/to/file.ts```) and absolute paths
function extractFilePathsFromText(text: string | undefined): string[] {
  if (!text) return [];

  const paths = new Set<string>();

  // Pattern 1: Cursor's code reference format - ```lineStart:lineEnd:path``` or ```lineStart-lineEnd:path```
  // Example: ```42:186:functions/src/hubspot-etl/index.ts```
  const codeRefPattern = /```(\d+)[:\-](\d+):([^`\n]+?)```/g;
  let match;
  while ((match = codeRefPattern.exec(text)) !== null) {
    const path = match[3]?.trim();
    if (path && !path.includes(' ') && path.includes('/')) {
      // Convert to absolute path if it looks like a relative project path
      paths.add(path);
    }
  }

  // Pattern 2: Absolute file paths (macOS/Linux)
  // Match paths starting with /Users/ or /home/ followed by typical project structure
  const absolutePathPattern = /(?:^|\s|["'`(])(\/(Users|home)\/[^\s"'`)\n]+\.[a-zA-Z0-9]+)(?=[\s"'`)\n]|$)/gm;
  while ((match = absolutePathPattern.exec(text)) !== null) {
    const path = match[1]?.trim();
    if (path) {
      paths.add(path);
    }
  }

  return Array.from(paths);
}

// Extract files associated with a specific bubble
function extractBubbleFiles(bubble: BubbleData): RawFile[] {
  const filesMap = new Map<string, RawFile>();

  // Files from bubble-level context
  if (bubble.context?.fileSelections) {
    for (const selection of bubble.context.fileSelections) {
      const path = selection.uri?.fsPath || selection.uri?.path;
      if (path) {
        filesMap.set(path, { path, role: 'context' });
      }
    }
  }

  if (bubble.context?.folderSelections) {
    for (const selection of bubble.context.folderSelections) {
      const path = selection.uri?.fsPath || selection.uri?.path;
      if (path) {
        filesMap.set(path, { path, role: 'context' });
      }
    }
  }

  // Relevant files mentioned in this bubble
  if (bubble.relevantFiles) {
    for (const file of bubble.relevantFiles) {
      if (!filesMap.has(file)) {
        filesMap.set(file, { path: file, role: 'mentioned' });
      }
    }
  }

  return Array.from(filesMap.values());
}

// Collect all files from context and bubbles for conversation-level tracking
function collectFiles(
  context: ContextData | undefined,
  bubbles: BubbleData[]
): RawFile[] {
  const filesMap = new Map<string, RawFile>();

  // From conversation-level context (files added to context)
  if (context?.fileSelections) {
    for (const selection of context.fileSelections) {
      const path = selection.uri?.fsPath || selection.uri?.path;
      if (path) {
        filesMap.set(path, { path, role: 'context' });
      }
    }
  }

  if (context?.folderSelections) {
    for (const selection of context.folderSelections) {
      const path = selection.uri?.fsPath || selection.uri?.path;
      if (path) {
        filesMap.set(path, { path, role: 'context' });
      }
    }
  }

  // From bubbles (relevantFiles and per-bubble context)
  for (const bubble of bubbles) {
    // Relevant files mentioned in a bubble
    if (bubble.relevantFiles) {
      for (const file of bubble.relevantFiles) {
        if (!filesMap.has(file)) {
          filesMap.set(file, { path: file, role: 'mentioned' });
        }
      }
    }

    // Files from bubble-level context
    if (bubble.context?.fileSelections) {
      for (const selection of bubble.context.fileSelections) {
        const path = selection.uri?.fsPath || selection.uri?.path;
        if (path && !filesMap.has(path)) {
          filesMap.set(path, { path, role: 'context' });
        }
      }
    }

    if (bubble.context?.folderSelections) {
      for (const selection of bubble.context.folderSelections) {
        const path = selection.uri?.fsPath || selection.uri?.path;
        if (path && !filesMap.has(path)) {
          filesMap.set(path, { path, role: 'context' });
        }
      }
    }
  }

  return Array.from(filesMap.values());
}

// Build a mapping from diffId to file path and bubble info
function buildDiffToFileMapping(codeBlockData: Record<string, Record<string, CodeBlockEntry>> | undefined): Map<string, CodeBlockMapping> {
  const mapping = new Map<string, CodeBlockMapping>();

  if (!codeBlockData) return mapping;

  for (const [fileUri, blocks] of Object.entries(codeBlockData)) {
    // Extract file path from file:///path/to/file
    const filePath = fileUri.startsWith('file://')
      ? fileUri.replace('file://', '')
      : fileUri;

    for (const [, blockData] of Object.entries(blocks)) {
      if (blockData.diffId) {
        mapping.set(blockData.diffId, {
          diffId: blockData.diffId,
          filePath: blockData.uri?.fsPath || blockData.uri?.path || filePath,
          bubbleId: blockData.bubbleId || '',
          languageId: blockData.languageId,
        });
      }
    }
  }

  return mapping;
}

// Pre-parsed diff data structure
interface ParsedDiffRow {
  composerId: string;
  diffId: string;
  diffs: DiffEntry[];
}

// Load and parse all codeBlockDiff entries upfront
function loadAllCodeBlockDiffs(db: BetterSqliteDatabase): Map<string, ParsedDiffRow[]> {
  const diffsByComposer = new Map<string, ParsedDiffRow[]>();

  const diffRows = db
    .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'codeBlockDiff:%'")
    .all() as Array<{ key: string; value: Buffer | string }>;

  for (const row of diffRows) {
    // Extract composerId and diffId from key: codeBlockDiff:{composerId}:{diffId}
    const keyParts = row.key.split(':');
    const composerId = keyParts[1];
    const diffId = keyParts[2];
    if (!composerId || !diffId) continue;

    // Parse the diff value
    let valueStr: string;
    if (Buffer.isBuffer(row.value)) {
      valueStr = row.value.toString('utf-8');
    } else {
      valueStr = row.value;
    }

    try {
      const parsed = JSON.parse(valueStr) as { newModelDiffWrtV0?: DiffEntry[] };
      if (parsed.newModelDiffWrtV0 && Array.isArray(parsed.newModelDiffWrtV0)) {
        if (!diffsByComposer.has(composerId)) {
          diffsByComposer.set(composerId, []);
        }
        diffsByComposer.get(composerId)!.push({
          composerId,
          diffId,
          diffs: parsed.newModelDiffWrtV0,
        });
      }
    } catch {
      // Skip malformed diff entries
    }
  }

  return diffsByComposer;
}

// Extract code block diffs for a specific composer using pre-loaded data
function extractCodeBlockDiffs(
  diffsByComposer: Map<string, ParsedDiffRow[]>,
  composerId: string,
  diffMapping: Map<string, CodeBlockMapping>
): RawFileEdit[] {
  const edits: RawFileEdit[] = [];
  const composerDiffs = diffsByComposer.get(composerId);
  if (!composerDiffs) return edits;

  for (const { diffId, diffs } of composerDiffs) {
    const mapping = diffMapping.get(diffId);
    if (!mapping) continue; // Skip orphaned diffs without file mapping

    for (const diff of diffs) {
      const startLine = diff.original?.startLineNumber ?? 0;
      const endLine = diff.original?.endLineNumberExclusive ?? 0;
      const linesRemoved = endLine - startLine;
      const linesAdded = diff.modified?.length ?? 0;

      edits.push({
        filePath: mapping.filePath,
        editType: linesRemoved === 0 ? 'create' : 'modify',
        linesAdded,
        linesRemoved,
        startLine: startLine > 0 ? startLine : undefined,
        endLine: endLine > 0 ? endLine : undefined,
        bubbleId: mapping.bubbleId,
        newContent: diff.modified?.join('\n'),
      });
    }
  }

  return edits;
}

// Yield to the event loop to keep the UI responsive
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface ExtractionProgress {
  current: number;
  total: number;
}

// Pre-load all bubbles by composerId for v9+ format
// This avoids N+1 queries when processing conversations
function loadAllBubbles(db: BetterSqliteDatabase): Map<string, Map<string, BubbleData>> {
  const bubblesByComposer = new Map<string, Map<string, BubbleData>>();

  const stmt = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'");
  for (const row of stmt.iterate() as IterableIterator<{ key: string; value: Buffer | string }>) {
    // Key format: bubbleId:{composerId}:{bubbleId}
    const parts = row.key.split(':');
    if (parts.length < 3) continue;
    const composerId = parts[1]!;
    const bubbleId = parts.slice(2).join(':'); // Handle bubbleIds with colons

    try {
      const valueStr = Buffer.isBuffer(row.value) ? row.value.toString('utf-8') : row.value;
      const bubbleData = JSON.parse(valueStr) as BubbleData;
      if (!bubbleData) continue;

      let composerMap = bubblesByComposer.get(composerId);
      if (!composerMap) {
        composerMap = new Map<string, BubbleData>();
        bubblesByComposer.set(composerId, composerMap);
      }
      composerMap.set(bubbleId, bubbleData);
    } catch {
      // Skip malformed bubble data
    }
  }

  return bubblesByComposer;
}

function copyDbToTemp(dbPath: string): { tempDir: string; tempDbPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'dex-cursor-'));
  const dbName = basename(dbPath);
  const tempDbPath = join(tempDir, dbName);
  
  cpSync(dbPath, tempDbPath);
  
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (existsSync(walPath)) cpSync(walPath, `${tempDbPath}-wal`);
  if (existsSync(shmPath)) cpSync(shmPath, `${tempDbPath}-shm`);
  
  return { tempDir, tempDbPath };
}

function cleanupTempDb(tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}

function openCursorDb(dbPath: string): BetterSqliteDatabase {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('cache_size = -2000');
  db.pragma('mmap_size = 0');
  return db;
}

// Batch size for connection cycling - balance between lock release frequency and overhead
const COMPOSER_BATCH_SIZE = 100;

/**
 * Metadata for a conversation - used for quick timestamp checks without full extraction
 */
export interface ConversationTimestamp {
  composerId: string;
  lastUpdatedAt: number | undefined;
}

/**
 * Get just the timestamps for all conversations.
 * This is MUCH faster than full extraction since we only parse the timestamp field.
 * Used for incremental sync to check which conversations have changed.
 */
export function getConversationTimestamps(dbPath: string): ConversationTimestamp[] {
  const { tempDir, tempDbPath } = copyDbToTemp(dbPath);
  const timestamps: ConversationTimestamp[] = [];
  
  try {
    const db = openCursorDb(tempDbPath);
    try {
      const stmt = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'");
      for (const row of stmt.iterate() as IterableIterator<{ key: string; value: Buffer | string }>) {
        const composerId = row.key.replace('composerData:', '');
        
        let lastUpdatedAt: number | undefined;
        try {
          const valueStr = Buffer.isBuffer(row.value) ? row.value.toString('utf-8') : row.value;
          const match = valueStr.match(/"lastUpdatedAt"\s*:\s*(\d+)/);
          if (match) {
            lastUpdatedAt = parseInt(match[1]!, 10);
          }
        } catch {}
        
        timestamps.push({ composerId, lastUpdatedAt });
      }
    } finally {
      db.close();
    }
  } finally {
    cleanupTempDb(tempDir);
  }
  
  return timestamps;
}

export async function extractConversations(
  dbPath: string,
  onProgress?: (progress: ExtractionProgress) => void
): Promise<RawConversation[]> {
  const { tempDir, tempDbPath } = copyDbToTemp(dbPath);
  
  try {
    return await extractFromDb(tempDbPath, onProgress);
  } finally {
    cleanupTempDb(tempDir);
  }
}

function loadWorkspaceHistory(): string[] {
  return loadWorkspaceHistoryFromFiles();
}

async function extractFromDb(
  dbPath: string,
  onProgress?: (progress: ExtractionProgress) => void
): Promise<RawConversation[]> {
  const conversations: RawConversation[] = [];

  let diffsByComposer: Map<string, ParsedDiffRow[]>;
  let bubblesByComposer: Map<string, Map<string, BubbleData>>;
  let knownWorkspaces: string[];
  let totalCount: number;

  {
    const db = openCursorDb(dbPath);
    try {
      diffsByComposer = loadAllCodeBlockDiffs(db);
      bubblesByComposer = loadAllBubbles(db);
      knownWorkspaces = loadWorkspaceHistory();
      totalCount = (db.prepare("SELECT COUNT(*) as count FROM cursorDiskKV WHERE key LIKE 'composerData:%'").get() as { count: number }).count;
    } finally {
      db.close();
    }
  }

  // Phase 2: Process composer data in batches with connection cycling
  // This releases SQLite locks between batches, allowing Cursor to checkpoint
  let processedCount = 0;

  for (let offset = 0; offset < totalCount; offset += COMPOSER_BATCH_SIZE) {
    // Open a fresh connection for each batch
    const db = openCursorDb(dbPath);
    try {
      const batchStmt = db.prepare(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT ? OFFSET ?"
      );
      const batch = batchStmt.all(COMPOSER_BATCH_SIZE, offset) as Array<{ key: string; value: Buffer | string }>;

      for (const row of batch) {
        processedCount++;
        if (processedCount % 100 === 0) {
          onProgress?.({ current: processedCount, total: totalCount });
        }
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
      const bubbleDataList: BubbleData[] = [];

      // Try to get bubbles from conversation array (older format)
      if (data.conversation && Array.isArray(data.conversation)) {
        for (const item of data.conversation) {
          if (item.bubbleId && item.text) {
            // Extract per-bubble files
            const bubbleFiles = extractBubbleFiles(item);
            bubbles.push({
              bubbleId: item.bubbleId,
              type: mapBubbleType(item.type),
              text: item.text,
              files: bubbleFiles,
              fileEdits: [], // Will be populated after diff extraction
              inputTokens: item.tokenCount?.inputTokens,
              outputTokens: item.tokenCount?.outputTokens,
            });
            bubbleDataList.push(item);
          }
        }
      }

      // Try to get bubbles from conversationMap (newer format)
      if (bubbles.length === 0 && data.conversationMap && data.fullConversationHeadersOnly) {
        for (const header of data.fullConversationHeadersOnly) {
          if (header.bubbleId) {
            const bubbleData = data.conversationMap[header.bubbleId];
            if (bubbleData && bubbleData.text) {
              const bubbleFiles = extractBubbleFiles(bubbleData);
              bubbles.push({
                bubbleId: header.bubbleId,
                type: mapBubbleType(header.type ?? bubbleData.type),
                text: bubbleData.text,
                files: bubbleFiles,
                fileEdits: [], // Will be populated after diff extraction
                inputTokens: bubbleData.tokenCount?.inputTokens,
                outputTokens: bubbleData.tokenCount?.outputTokens,
              });
              bubbleDataList.push(bubbleData);
            }
          }
        }
      }

      // Try to get bubbles from separate bubbleId entries (newest format - v9+)
      // In this format, conversationMap is empty but bubbles are stored as separate entries
      if (bubbles.length === 0 && data.fullConversationHeadersOnly && data.fullConversationHeadersOnly.length > 0) {
        // Use pre-loaded bubble map (O(1) lookup instead of per-conversation query)
        const bubbleMap = bubblesByComposer.get(composerId);

        // Iterate through headers and look up from the pre-loaded map
        for (const header of data.fullConversationHeadersOnly) {
          if (header.bubbleId && bubbleMap) {
            const bubbleData = bubbleMap.get(header.bubbleId);
            if (bubbleData && bubbleData.text) {
              const bubbleFiles = extractBubbleFiles(bubbleData);
              bubbles.push({
                bubbleId: header.bubbleId,
                type: mapBubbleType(header.type ?? bubbleData.type),
                text: bubbleData.text,
                files: bubbleFiles,
                fileEdits: [], // Will be populated after diff extraction
                inputTokens: bubbleData.tokenCount?.inputTokens,
                outputTokens: bubbleData.tokenCount?.outputTokens,
              });
              bubbleDataList.push(bubbleData);
            }
          }
        }
      }

      // Skip empty conversations
      if (bubbles.length === 0) continue;

      // Extract file edits from codeBlockDiff entries (using pre-loaded diffs)
      const diffMapping = buildDiffToFileMapping(data.codeBlockData);
      const allFileEdits = extractCodeBlockDiffs(diffsByComposer, composerId, diffMapping);

      // Build a map of bubbleId -> original position in the conversation
      // This includes ALL bubbles, even tool-only ones without text
      const bubbleIdToOriginalIndex = new Map<string, number>();
      const headers = data.fullConversationHeadersOnly || [];
      for (let i = 0; i < headers.length; i++) {
        const header = headers[i];
        if (header?.bubbleId) {
          bubbleIdToOriginalIndex.set(header.bubbleId, i);
        }
      }
      // Also check conversation array for older format
      if (bubbleIdToOriginalIndex.size === 0 && data.conversation) {
        for (let i = 0; i < data.conversation.length; i++) {
          const item = data.conversation[i];
          if (item?.bubbleId) {
            bubbleIdToOriginalIndex.set(item.bubbleId, i);
          }
        }
      }

      // Associate edits with bubbles by bubbleId
      // Map our filtered bubbles to their original positions
      const bubbleIdToFilteredIndex = new Map<string, number>();
      const filteredBubbleOriginalIndices: Array<{ bubbleId: string; originalIndex: number; filteredIndex: number }> = [];
      for (let i = 0; i < bubbles.length; i++) {
        const bubble = bubbles[i]!;
        bubbleIdToFilteredIndex.set(bubble.bubbleId, i);
        const origIdx = bubbleIdToOriginalIndex.get(bubble.bubbleId) ?? i;
        filteredBubbleOriginalIndices.push({
          bubbleId: bubble.bubbleId,
          originalIndex: origIdx,
          filteredIndex: i,
        });
      }

      // Sort by original index to enable binary search for nearest prior
      filteredBubbleOriginalIndices.sort((a, b) => a.originalIndex - b.originalIndex);

      // Find the nearest prior assistant bubble for orphaned edits
      function findNearestPriorAssistant(editOriginalIndex: number): number {
        let nearestIdx = -1;
        for (const entry of filteredBubbleOriginalIndices) {
          if (entry.originalIndex > editOriginalIndex) break;
          if (bubbles[entry.filteredIndex]!.type === 'assistant') {
            nearestIdx = entry.filteredIndex;
          }
        }
        // If no prior assistant found, use the first assistant in the conversation
        if (nearestIdx < 0) {
          for (let i = 0; i < bubbles.length; i++) {
            if (bubbles[i]!.type === 'assistant') {
              nearestIdx = i;
              break;
            }
          }
        }
        return nearestIdx;
      }

      for (const edit of allFileEdits) {
        if (edit.bubbleId) {
          const bubbleIndex = bubbleIdToFilteredIndex.get(edit.bubbleId);
          if (bubbleIndex !== undefined) {
            // Exact match - associate with this bubble
            bubbles[bubbleIndex]!.fileEdits.push(edit);
          } else {
            // bubbleId points to a tool-only bubble not in our filtered list
            // Find the nearest prior assistant based on original conversation order
            const editOriginalIndex = bubbleIdToOriginalIndex.get(edit.bubbleId) ?? Infinity;
            const nearestAssistantIdx = findNearestPriorAssistant(editOriginalIndex);
            if (nearestAssistantIdx >= 0) {
              bubbles[nearestAssistantIdx]!.fileEdits.push(edit);
            }
          }
        } else {
          // No bubbleId - associate with the last assistant bubble
          const lastAssistantIdx = findNearestPriorAssistant(Infinity);
          if (lastAssistantIdx >= 0) {
            bubbles[lastAssistantIdx]!.fileEdits.push(edit);
          }
        }
      }

      // Append file edit content to assistant bubbles (using array + join for efficiency)
      for (const bubble of bubbles) {
        if (bubble.type === 'assistant' && bubble.fileEdits.length > 0) {
          const editParts: string[] = [bubble.text];
          for (const edit of bubble.fileEdits) {
            if (edit.newContent) {
              const fileName = edit.filePath.split('/').pop() || edit.filePath;
              editParts.push(`\n\n---\n**Edit** \`${fileName}\` (+${edit.linesAdded}/-${edit.linesRemoved})\n\`\`\`\n${edit.newContent}\n\`\`\`\n---`);
            }
          }
          if (editParts.length > 1) {
            bubble.text = editParts.join('');
          }
        }
      }

      // Calculate per-bubble line totals
      for (const bubble of bubbles) {
        const totalAdded = bubble.fileEdits.reduce((sum, e) => sum + e.linesAdded, 0);
        const totalRemoved = bubble.fileEdits.reduce((sum, e) => sum + e.linesRemoved, 0);
        bubble.totalLinesAdded = totalAdded > 0 ? totalAdded : undefined;
        bubble.totalLinesRemoved = totalRemoved > 0 ? totalRemoved : undefined;
      }

      // Calculate conversation-level totals
      const totalLinesAdded = allFileEdits.reduce((sum, e) => sum + e.linesAdded, 0);
      const totalLinesRemoved = allFileEdits.reduce((sum, e) => sum + e.linesRemoved, 0);

      const files = collectFiles(data.context, bubbleDataList);
      const textFilePaths = bubbleDataList.flatMap((b) => extractFilePathsFromText(b.text));

      const filePaths = [
        ...files.map((f) => f.path),
        ...allFileEdits.map((edit) => edit.filePath),
        ...textFilePaths,
      ];
      let workspacePath = extractWorkspacePath(filePaths);
      
      if (!workspacePath && textFilePaths.length > 0) {
        workspacePath = resolveRelativePathsToWorkspace(textFilePaths, knownWorkspaces);
      }
      
      if (workspacePath) {
        workspacePath = findRepoRoot(workspacePath);
      }
      
      const projectName = extractProjectName(workspacePath);

      // Calculate token usage with sum-of-peaks for PEAK view
      // For input tokens, track peak context per segment (between compactions).
      // A compaction is detected when context drops by 50% or more.
      // SUM view totals all tokens across all API calls (matches billing).
      // For output tokens, SUM is always correct since each output is new content.
      const COMPACTION_DROP_THRESHOLD = 0.5;

      let segmentPeakInput = 0;
      let totalPeakInput = 0;
      let sumInputTokens = 0;
      let prevInput = 0;

      for (const bubble of bubbles) {
        const inputTokens = bubble.inputTokens || 0;

        // Accumulate sum (all API calls)
        sumInputTokens += inputTokens;

        // Check for compaction (50% or greater drop in context)
        const isCompaction = prevInput > 0 && inputTokens > 0 &&
          inputTokens < prevInput * COMPACTION_DROP_THRESHOLD;

        if (isCompaction) {
          // End previous segment - add its peak to totals
          totalPeakInput += segmentPeakInput;
          segmentPeakInput = inputTokens;
        } else {
          // Track peak within current segment
          if (inputTokens > segmentPeakInput) {
            segmentPeakInput = inputTokens;
          }
        }

        prevInput = inputTokens;
      }

      // Add the final segment's peak
      totalPeakInput += segmentPeakInput;

      const totalOutputTokens = bubbles.reduce((sum, b) => sum + (b.outputTokens || 0), 0);

      conversations.push({
        composerId,
        name: data.name || 'Untitled',
        createdAt: data.createdAt,
        lastUpdatedAt: data.lastUpdatedAt,
        bubbles,
        workspacePath,
        projectName,
        mode: data.forceMode,
        model: data.modelConfig?.modelName,
        files,
        fileEdits: allFileEdits,
        // PEAK view (sum of peaks across compaction segments)
        totalInputTokens: totalPeakInput > 0 ? totalPeakInput : undefined,
        totalOutputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
        // SUM view (total across all API calls)
        sumInputTokens: sumInputTokens > 0 ? sumInputTokens : undefined,
        sumOutputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
        totalLinesAdded: totalLinesAdded > 0 ? totalLinesAdded : undefined,
        totalLinesRemoved: totalLinesRemoved > 0 ? totalLinesRemoved : undefined,
      });
      }
    } finally {
      db.close();
    }

    // Yield to event loop between batches to allow Cursor to checkpoint
    await yieldToEventLoop();
  }

  return conversations;
}
