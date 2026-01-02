/**
 * Sync command - indexes conversations from AI coding tools into the local database
 *
 * Usage: dex sync [--force] [--source <name>]
 *
 * Detects and syncs from: Cursor, Claude Code, Codex
 * Spawns background embedding worker after sync completes
 */

import React, { useState, useEffect } from 'react';
import { render, Box, Text } from 'ink';
import { exec } from 'child_process';
import { promisify } from 'util';
import { spawnBackgroundCommand, spawnBackgroundCommandWithRetry } from '../../utils/spawn';
import { isEmbeddingInProgress } from '../../embeddings/index';

const execAsync = promisify(exec);
import { adapters } from '../../adapters/index';
import type { SourceLocation, NormalizedConversation } from '../../adapters/types';
import {
  connect,
  rebuildFtsIndex,
  rebuildScalarIndexes,
  acquireSyncLock,
  releaseSyncLock,
  getMessagesTable,
} from '../../db/index';
import {
  conversationRepo,
  messageRepo,
  toolCallRepo,
  syncStateRepo,
  filesRepo,
  messageFilesRepo,
  fileEditsRepo,
} from '../../db/repository';
import {
  setEmbeddingProgress,
  clearEmbeddingProgress,
  EMBEDDING_DIMENSIONS,
  needsEmbeddingRecovery,
  resetEmbeddingError,
} from '../../embeddings/index';
import { printRichSummary } from './stats';
import { loadConfig } from '../../config/index.js';
import { enrichUntitledConversations } from '../../features/enrichment/index.js';
import { updateSyncCache, getMessagesSinceLastIndex } from '../../utils/sync-cache';
import { syncCursorBillingSilent } from './billing';

/**
 * Count messages that still need embedding (have zero vectors or wrong dimensions).
 */
async function countPendingEmbeddings(): Promise<number> {
  try {
    const table = await getMessagesTable();
    const allMessages = await table.query().select(['vector']).toArray();

    return allMessages.filter((row) => {
      const vector = row.vector;
      if (!vector) return true;
      const arr = Array.isArray(vector) ? vector : Array.from(vector as Float32Array);
      // Check for zero vectors OR wrong dimensions (model changed)
      if (arr.length !== EMBEDDING_DIMENSIONS) return true;
      return arr.every((v) => v === 0);
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Kill any running embedding processes to prevent LanceDB commit conflicts.
 * The embedding worker will be restarted after sync completes.
 * Also resets the progress state so the worker can be respawned.
 */
async function killEmbeddingProcesses(): Promise<void> {
  try {
    // Find and kill any bun processes running embed.ts
    // This is platform-specific but works on macOS/Linux
    if (process.platform !== 'win32') {
      await execAsync('pkill -f "dex embed" 2>/dev/null; pkill -f "embed\\.ts" 2>/dev/null; pkill -f "node.*embed" 2>/dev/null; pkill -f "bun.*embed" 2>/dev/null; true').catch(() => {});
    }
    // Also kill any llama-server processes that might be running
    if (process.platform !== 'win32') {
      await execAsync('pkill -f "llama-server" 2>/dev/null || true').catch(() => {});
    }
  } catch {
    // Ignore errors - process may not exist
  }

  // Reset the progress file status since we just killed any running process.
  // The embed worker determines what to embed by checking for zero vectors,
  // so it will correctly resume from where it left off.
  clearEmbeddingProgress();
}

export interface SyncProgress {
  phase:
    | 'detecting'
    | 'discovering'
    | 'extracting'
    | 'syncing'
    | 'indexing'
    | 'enriching'
    | 'done'
    | 'error';
  currentSource?: string;
  currentProject?: string;
  projectsFound: number;
  projectsProcessed: number;
  conversationsFound: number;
  conversationsIndexed: number;
  conversationsSkipped: number;
  messagesIndexed: number;
  error?: string;
  embeddingStarted?: boolean;
  extractionProgress?: { current: number; total: number };
  enrichmentProgress?: { current: number; total: number };
}

/**
 * Quick check if any source has new data to sync.
 * This is much faster than running full sync because it only checks mtimes.
 * Returns true if sync is needed, false if everything is up to date.
 */
export async function needsSync(): Promise<boolean> {
  try {
    await connect();

    for (const adapter of adapters) {
      const available = await adapter.detect();
      if (!available) continue;

      const locations = await adapter.discover();

      for (const location of locations) {
        const syncState = await syncStateRepo.get(adapter.name, location.dbPath);
        // If no sync state exists, or mtime has changed, sync is needed
        if (!syncState || syncState.lastMtime < location.mtime) {
          return true;
        }
      }
    }

    return false;
  } catch {
    // On error, assume sync is needed
    return true;
  }
}

interface SyncOptions {
  force?: boolean;
}

function _formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function SyncUI({ progress }: { progress: SyncProgress }) {
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (progress.phase === 'done' || progress.phase === 'error') return;

    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % spinner.length);
    }, 80);

    return () => clearInterval(timer);
  }, [progress.phase]);

  if (progress.phase === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ Error: {progress.error}</Text>
      </Box>
    );
  }

  if (progress.phase === 'done') {
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Sync complete</Text>
        <Text dimColor>
          {progress.projectsProcessed} projects, {progress.conversationsIndexed} conversations,{' '}
          {progress.messagesIndexed} messages
        </Text>
        {progress.embeddingStarted && (
          <Text color="cyan">
            Embeddings generating in background. Run "dex status" to check progress.
          </Text>
        )}
      </Box>
    );
  }

  // Format project name for display
  const projectDisplay = progress.currentProject
    ? progress.currentProject.length > 50
      ? '...' + progress.currentProject.slice(-47)
      : progress.currentProject
    : null;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{spinner[frame]} </Text>
        <Text>
          {progress.phase === 'detecting' && 'Detecting sources...'}
          {progress.phase === 'discovering' && `Discovering ${progress.currentSource}...`}
          {progress.phase === 'extracting' && (
            progress.extractionProgress
              ? `Extracting ${progress.currentSource} (${progress.extractionProgress.current}/${progress.extractionProgress.total})...`
              : `Extracting ${progress.currentSource} conversations...`
          )}
          {progress.phase === 'syncing' && `Syncing ${progress.currentSource}...`}
          {progress.phase === 'indexing' && 'Building search index...'}
          {progress.phase === 'enriching' && (
            progress.enrichmentProgress
              ? `Generating titles (${progress.enrichmentProgress.current}/${progress.enrichmentProgress.total})...`
              : 'Generating titles...'
          )}
        </Text>
      </Box>

      {projectDisplay && (
        <Box marginLeft={2}>
          <Text color="magenta">{projectDisplay}</Text>
        </Box>
      )}

      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>
          Projects: {progress.projectsProcessed}/{progress.projectsFound} | Conversations:{' '}
          {progress.conversationsIndexed}
          {progress.conversationsSkipped > 0 && ` (${progress.conversationsSkipped} empty skipped)`}
          {' '}| Messages: {progress.messagesIndexed}
        </Text>
      </Box>
    </Box>
  );
}

async function spawnBackgroundEmbedding(): Promise<boolean> {
  // Check if embedding is already running to prevent duplicate processes
  if (isEmbeddingInProgress()) {
    return true;
  }
  // Spawn background embedding process with low priority (nice 19 = lowest priority)
  // This minimizes impact on user's foreground work
  // Use retry mechanism to ensure the process actually starts
  return spawnBackgroundCommandWithRetry('embed', 'embed', {
    maxRetries: 3,
    verifyDelayMs: 1500,
  });
}

export async function runSync(
  options: SyncOptions,
  onProgress: (progress: SyncProgress) => void
): Promise<void> {
  const progress: SyncProgress = {
    phase: 'detecting',
    projectsFound: 0,
    projectsProcessed: 0,
    conversationsFound: 0,
    conversationsIndexed: 0,
    conversationsSkipped: 0,
    messagesIndexed: 0,
  };

  // Auto-recover from embedding errors before sync
  // This ensures embedding can restart after crashes or interruptions
  if (needsEmbeddingRecovery()) {
    resetEmbeddingError();
  }

  // Try to acquire sync lock to prevent concurrent operations
  if (!acquireSyncLock()) {
    progress.phase = 'error';
    progress.error = 'Another sync is already running. Please wait for it to complete.';
    onProgress({ ...progress });
    return;
  }

  try {
    // Connect to database
    console.error('[sync] Connecting to database...');
    await connect();
    console.error('[sync] Database connected');

    // ========== PHASE 1: Collect all data from all adapters (PARALLEL) ==========
    // This is fast - just reading files, no DB operations yet
    const allConversations: { normalized: NormalizedConversation; adapter: typeof adapters[0]; location: SourceLocation }[] = [];
    const locationsToSync: { adapter: typeof adapters[0]; location: SourceLocation }[] = [];

    // Phase 1a: Detect all available adapters in parallel
    progress.phase = 'detecting';
    onProgress({ ...progress });

    const adapterAvailability = await Promise.all(
      adapters.map(async (adapter) => {
        try {
          return {
            adapter,
            available: await adapter.detect(),
          };
        } catch (error) {
          // Log but don't fail - skip adapters that error during detection
          console.error(`[sync] Error detecting ${adapter.name}:`, error);
          return { adapter, available: false };
        }
      })
    );
    const availableAdapters = adapterAvailability
      .filter(({ available }) => available)
      .map(({ adapter }) => adapter);

    // Phase 1b: Discover all locations in parallel across adapters
    progress.phase = 'discovering';
    onProgress({ ...progress });

    const adapterLocations = await Promise.all(
      availableAdapters.map(async (adapter) => {
        try {
          return {
            adapter,
            locations: await adapter.discover(),
          };
        } catch (error) {
          // Log but don't fail - skip adapters that error during discovery
          console.error(`[sync] Error discovering ${adapter.name}:`, error);
          return { adapter, locations: [] };
        }
      })
    );

    // Phase 1c: Filter locations that need syncing and extract in parallel
    progress.phase = 'extracting';
    progress.currentSource = 'all sources';
    onProgress({ ...progress });

    // Gather all locations that need syncing, using fast timestamp check when available
    const locationsNeedingSync: { adapter: typeof adapters[0]; location: SourceLocation }[] = [];

    for (const { adapter, locations } of adapterLocations) {
      for (const location of locations) {
        if (!options.force) {
          const syncState = await syncStateRepo.get(adapter.name, location.dbPath);
          if (syncState && syncState.lastMtime >= location.mtime) {
            continue; // Skip - no changes since last sync
          }

          // File mtime changed, but check if any conversations actually changed
          // This is faster than full extraction for large sources
          if (adapter.getConversationTimestamps) {
            try {
              const sourceTimestamps = adapter.getConversationTimestamps(location);
              if (sourceTimestamps) {
                const storedTimestamps = await conversationRepo.getTimestampsBySource(adapter.name);
                
                // Check if any timestamps differ or if there are new conversations
                let hasChanges = false;
                for (const { originalId, lastUpdatedAt } of sourceTimestamps) {
                  const storedTs = storedTimestamps.get(originalId);
                  if (storedTs === undefined) {
                    // New conversation
                    hasChanges = true;
                    break;
                  }
                  if (lastUpdatedAt !== undefined && storedTs !== lastUpdatedAt) {
                    // Updated conversation
                    hasChanges = true;
                    break;
                  }
                }
                
                // Also check for deleted conversations (in stored but not in source)
                if (!hasChanges) {
                  const sourceIds = new Set(sourceTimestamps.map(t => t.originalId));
                  for (const storedId of storedTimestamps.keys()) {
                    if (!sourceIds.has(storedId)) {
                      // Conversation was deleted in source
                      hasChanges = true;
                      break;
                    }
                  }
                }
                
                if (!hasChanges) {
                  // No changes detected via timestamp check, skip extraction
                  // But still update sync state mtime so we don't recheck next time
                  await syncStateRepo.set({
                    source: adapter.name,
                    workspacePath: location.workspacePath,
                    dbPath: location.dbPath,
                    lastSyncedAt: new Date().toISOString(),
                    lastMtime: location.mtime,
                  });
                  console.error(`[sync] ${adapter.name}: No conversation changes detected (fast check)`);
                  continue;
                }
              }
            } catch (error) {
              // Fast check failed, fall back to full extraction
              console.error(`[sync] ${adapter.name}: Fast timestamp check failed, using full extraction:`, error);
            }
          }
        }
        locationsNeedingSync.push({ adapter, location });
        locationsToSync.push({ adapter, location });
      }
    }

    // Extract from all locations in parallel (with concurrency limit to avoid overwhelming the system)
    const EXTRACTION_CONCURRENCY = 4;
    const extractionResults: { adapter: typeof adapters[0]; location: SourceLocation; rawConversations: unknown[] }[] = [];

    for (let i = 0; i < locationsNeedingSync.length; i += EXTRACTION_CONCURRENCY) {
      const batch = locationsNeedingSync.slice(i, i + EXTRACTION_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async ({ adapter, location }) => {
          // Capture adapter name in closure to avoid race condition with parallel extractions
          const adapterName = adapter.name;
          progress.currentSource = adapterName;
          progress.extractionProgress = undefined; // Reset for new extraction
          onProgress({ ...progress });
          try {
            const rawConversations = await adapter.extract(location, (extractionProg) => {
              // Use captured adapterName, not progress.currentSource (which may have changed)
              progress.currentSource = adapterName;
              progress.extractionProgress = extractionProg;
              onProgress({ ...progress });
            });
            return { adapter, location, rawConversations };
          } catch (error) {
            // Log but don't fail - skip locations that error during extraction
            console.error(`[sync] Error extracting from ${adapterName} at ${location.dbPath}:`, error);
            return { adapter, location, rawConversations: [] };
          }
        })
      );
      extractionResults.push(...batchResults);
    }

    // Normalize all conversations (this is CPU-bound but fast)
    for (const { adapter, location, rawConversations } of extractionResults) {
      for (const raw of rawConversations) {
        const normalized = adapter.normalize(raw, location);
        allConversations.push({ normalized, adapter, location });
      }
    }

    progress.conversationsFound = allConversations.length;

    // Group conversations by project path for progress display
    const projectPaths = new Set(allConversations.map(c => c.normalized.conversation.workspacePath || 'unknown'));
    progress.projectsFound = projectPaths.size;
    onProgress({ ...progress });

    if (allConversations.length === 0) {
      progress.phase = 'done';
      progress.currentSource = undefined;
      onProgress({ ...progress });
      return;
    }

    // ========== PHASE 2: Filter to only NEW conversations (incremental sync) ==========
    progress.phase = 'syncing';
    progress.currentSource = 'all sources';
    onProgress({ ...progress });

    // Get all candidate conversation IDs
    const candidateIds = allConversations.map((c) => c.normalized.conversation.id);

    // In force mode, we re-sync everything; otherwise only sync new conversations
    let conversationsToSync = allConversations;
    let existingIds = new Set<string>();

    if (options.force) {
      // Kill any running embedding processes to prevent conflicts during sync
      // Only kill if we're actually going to modify the database (force mode with data)
      await killEmbeddingProcesses();

      // Force mode: delete all existing data and re-sync everything
      // Track what to delete by source
      const deleteBySource = new Map<string, Set<string>>();
      for (const { adapter, location } of allConversations) {
        const key = adapter.name;
        if (!deleteBySource.has(key)) {
          deleteBySource.set(key, new Set());
        }
        deleteBySource.get(key)!.add(location.workspacePath);
      }

      // Delete existing conversations by source
      for (const [source, workspacePaths] of deleteBySource) {
        for (const workspacePath of workspacePaths) {
          await conversationRepo.deleteBySource(source, workspacePath);
        }
      }

      // Delete related data for all conversations using bulk delete
      // Process in batches to avoid SQL IN clause limits (typically ~1000 items)
      const BULK_DELETE_BATCH_SIZE = 500;
      for (let i = 0; i < candidateIds.length; i += BULK_DELETE_BATCH_SIZE) {
        const batchIds = candidateIds.slice(i, i + BULK_DELETE_BATCH_SIZE);
        await Promise.all([
          messageRepo.deleteByConversationIds(batchIds),
          toolCallRepo.deleteByConversationIds(batchIds),
          filesRepo.deleteByConversationIds(batchIds),
          messageFilesRepo.deleteByConversationIds(batchIds),
          fileEditsRepo.deleteByConversationIds(batchIds),
        ]);
      }
    } else {
      // Incremental mode: sync NEW conversations + UPDATED conversations (more messages)
      const existingMetadata = await conversationRepo.getExistingConversationMetadata(candidateIds);
      existingIds = new Set(existingMetadata.keys());

      // Separate into new vs updated conversations
      const newConversations: typeof allConversations = [];
      const updatedConversations: typeof allConversations = [];

      for (const conv of allConversations) {
        const id = conv.normalized.conversation.id;
        const existing = existingMetadata.get(id);

        if (!existing) {
          // Brand new conversation
          newConversations.push(conv);
        } else {
          // Check if conversation has been updated (more messages or newer timestamp)
          const newMsgCount = conv.normalized.conversation.messageCount || 0;
          const newUpdatedAt = conv.normalized.conversation.updatedAt;
          const existingMsgCount = existing.messageCount;
          const existingUpdatedAt = existing.updatedAt;

          // Consider updated if:
          // 1. Has more messages, OR
          // 2. Has a newer updated_at timestamp
          const hasMoreMessages = newMsgCount > existingMsgCount;
          const hasNewerTimestamp = newUpdatedAt && existingUpdatedAt && newUpdatedAt > existingUpdatedAt;

          if (hasMoreMessages || hasNewerTimestamp) {
            updatedConversations.push(conv);
          }
        }
      }

      // For updated conversations, delete old data first
      if (updatedConversations.length > 0) {
        // Kill embedding processes since we're modifying the database
        await killEmbeddingProcesses();

        const updatedIds = updatedConversations.map((c) => c.normalized.conversation.id);

        // Delete old messages, tool calls, files, etc. for updated conversations
        // Process in batches to avoid SQL IN clause limits
        const BULK_DELETE_BATCH_SIZE = 500;
        for (let i = 0; i < updatedIds.length; i += BULK_DELETE_BATCH_SIZE) {
          const batchIds = updatedIds.slice(i, i + BULK_DELETE_BATCH_SIZE);
          await Promise.all([
            messageRepo.deleteByConversationIds(batchIds),
            toolCallRepo.deleteByConversationIds(batchIds),
            filesRepo.deleteByConversationIds(batchIds),
            messageFilesRepo.deleteByConversationIds(batchIds),
            fileEditsRepo.deleteByConversationIds(batchIds),
          ]);
        }
      }

      // Combine new and updated conversations for syncing
      conversationsToSync = [...newConversations, ...updatedConversations];
    }

    // If nothing new to sync, still check for pending embeddings before exiting
    if (conversationsToSync.length === 0) {
      // Check for pending embeddings even if no new conversations
      const pendingEmbeddings = await countPendingEmbeddings();
      if (pendingEmbeddings > 0) {
        setEmbeddingProgress({
          status: 'idle',
          total: pendingEmbeddings,
          completed: 0,
        });
        const started = await spawnBackgroundEmbedding();
        progress.embeddingStarted = started;
      }

      updateSyncCache(0, false);

      progress.phase = 'done';
      progress.currentSource = undefined;
      progress.conversationsIndexed = 0;
      progress.messagesIndexed = 0;
      onProgress({ ...progress });
      return;
    }

    // For incremental mode, kill embedding processes only if we have work to do
    // (Force mode already killed processes above before deletions)
    if (!options.force) {
      await killEmbeddingProcesses();
    }

    // ========== PHASE 3: Collect data from NEW conversations only ==========
    const newConvRows: Parameters<typeof conversationRepo.upsert>[0][] = [];
    const newMessages: Parameters<typeof messageRepo.bulkInsert>[0] = [];
    const newToolCalls: Parameters<typeof toolCallRepo.bulkInsert>[0] = [];
    const newFiles: Parameters<typeof filesRepo.bulkInsert>[0] = [];
    const newMessageFiles: Parameters<typeof messageFilesRepo.bulkInsert>[0] = [];
    const newFileEdits: Parameters<typeof fileEditsRepo.bulkInsert>[0] = [];

    let emptyConversationsSkipped = 0;
    for (const { normalized } of conversationsToSync) {
      // Skip conversations with no messages (empty/abandoned)
      if (normalized.messages.length === 0) {
        emptyConversationsSkipped++;
        continue;
      }

      newConvRows.push(normalized.conversation);
      newMessages.push(...normalized.messages);

      if (normalized.toolCalls.length > 0) {
        newToolCalls.push(...normalized.toolCalls);
      }
      if (normalized.files && normalized.files.length > 0) {
        newFiles.push(...normalized.files);
      }
      if (normalized.messageFiles && normalized.messageFiles.length > 0) {
        newMessageFiles.push(...normalized.messageFiles);
      }
      if (normalized.fileEdits && normalized.fileEdits.length > 0) {
        newFileEdits.push(...normalized.fileEdits);
      }
    }

    // ========== PHASE 4: Bulk insert new data (parallel writes to different tables) ==========
    // For incremental sync, we only add new data (no deletes needed)
    // Conversations must be inserted first (foreign key dependency), then others in parallel
    await conversationRepo.bulkUpsert(newConvRows);
    progress.conversationsIndexed = newConvRows.length;
    progress.conversationsSkipped = emptyConversationsSkipped;
    progress.projectsProcessed = projectPaths.size;
    onProgress({ ...progress });

    // Get existing IDs for all tables in parallel (for idempotent inserts)
    // This prevents duplicates if sync is interrupted and rerun
    const [existingMsgIds, existingToolCallIds, existingFileIds, existingMsgFileIds, existingEditIds] =
      await Promise.all([
        messageRepo.getExistingIds(newMessages.map((m) => m.id)),
        toolCallRepo.getExistingIds(newToolCalls.map((tc) => tc.id)),
        filesRepo.getExistingIds(newFiles.map((f) => f.id)),
        messageFilesRepo.getExistingIds(newMessageFiles.map((f) => f.id)),
        fileEditsRepo.getExistingIds(newFileEdits.map((e) => e.id)),
      ]);

    // Insert messages, tool calls, files, etc. in parallel (different tables)
    // Use bulkInsertNew for idempotent inserts that skip existing records
    const parallelInserts: Promise<number | void>[] = [];

    if (newMessages.length > 0) {
      parallelInserts.push(
        messageRepo.bulkInsertNew(newMessages, existingMsgIds).then((count) => {
          progress.messagesIndexed = count;
          onProgress({ ...progress });
        })
      );
    }

    if (newToolCalls.length > 0) {
      parallelInserts.push(toolCallRepo.bulkInsertNew(newToolCalls, existingToolCallIds));
    }

    if (newFiles.length > 0) {
      parallelInserts.push(filesRepo.bulkInsertNew(newFiles, existingFileIds));
    }

    if (newMessageFiles.length > 0) {
      parallelInserts.push(messageFilesRepo.bulkInsertNew(newMessageFiles, existingMsgFileIds));
    }

    if (newFileEdits.length > 0) {
      parallelInserts.push(fileEditsRepo.bulkInsertNew(newFileEdits, existingEditIds));
    }

    await Promise.all(parallelInserts);

    // ========== PHASE 5: Update sync state ==========
    for (const { adapter, location } of locationsToSync) {
      await syncStateRepo.set({
        source: adapter.name,
        workspacePath: location.workspacePath,
        dbPath: location.dbPath,
        lastSyncedAt: new Date().toISOString(),
        lastMtime: location.mtime,
      });
    }

    // ========== PHASE 6: Rebuild indexes ==========
    // FTS index must always be rebuilt - unindexed messages won't appear in search.
    // Scalar indexes (btree on conversation_id, file_path) are optional optimizations.
    const SCALAR_INDEX_THRESHOLD = 100;
    const cumulativeUnindexed = getMessagesSinceLastIndex() + newMessages.length;
    const shouldRebuildScalarIndexes = options.force || cumulativeUnindexed >= SCALAR_INDEX_THRESHOLD;

    if (newMessages.length > 0) {
      progress.phase = 'indexing';
      progress.currentSource = undefined;
      progress.currentProject = undefined;
      onProgress({ ...progress });

      await rebuildFtsIndex();
      if (shouldRebuildScalarIndexes) {
        await rebuildScalarIndexes();
      }
    }

    // ========== PHASE 6b: Spawn embedding worker if needed ==========
    // Check for pending embeddings (messages with zero vectors).
    // This handles both new messages and previously interrupted embedding runs.
    const pendingEmbeddings = await countPendingEmbeddings();
    if (pendingEmbeddings > 0) {
      setEmbeddingProgress({
        status: 'idle',
        total: pendingEmbeddings,
        completed: 0,
      });

      const started = await spawnBackgroundEmbedding();
      progress.embeddingStarted = started;
    }

    // ========== PHASE 6c: Sync Cursor billing (silent, non-blocking) ==========
    try {
      const billingResult = await syncCursorBillingSilent();
      if (billingResult.success && billingResult.eventsCount && billingResult.eventsCount > 0) {
        console.error(`[sync] Synced ${billingResult.eventsCount} Cursor billing events`);
      }
    } catch {
      // Billing sync failure should not block the main sync
    }

    // ========== PHASE 7: Enrich untitled conversations (if enabled) ==========
    const config = loadConfig();
    const claudeEnrichEnabled = config.providers.claudeCode.enabled && config.providers.claudeCode.autoEnrichSummaries;
    const codexEnrichEnabled = config.providers.codex.enabled && config.providers.codex.autoEnrichSummaries;

    if (claudeEnrichEnabled || codexEnrichEnabled) {
      progress.phase = 'enriching';
      progress.currentSource = undefined;
      progress.currentProject = undefined;
      onProgress({ ...progress });

      try {
        await enrichUntitledConversations((current, total) => {
          progress.enrichmentProgress = { current, total };
          onProgress({ ...progress });
        });
      } catch (err) {
        // Log enrichment errors but don't fail sync
        console.error('Enrichment failed:', err);
      }
    }

    updateSyncCache(newMessages.length, shouldRebuildScalarIndexes);

    progress.phase = 'done';
    progress.currentSource = undefined;
    progress.currentProject = undefined;
    onProgress({ ...progress });

    // Note: We no longer force exit here. The caller (SyncApp) will handle process exit
    // after the UI has properly rendered. This avoids race conditions where the embed
    // process spawn might not complete before exit.
  } catch (error) {
    progress.phase = 'error';
    progress.error = error instanceof Error ? error.message : String(error);
    onProgress({ ...progress });
    throw error;
  } finally {
    // Always release the lock when sync completes or fails
    releaseSyncLock();
  }
}

function SyncApp({ options }: { options: SyncOptions }) {
  const [progress, setProgress] = useState<SyncProgress>({
    phase: 'detecting',
    projectsFound: 0,
    projectsProcessed: 0,
    conversationsFound: 0,
    conversationsIndexed: 0,
    conversationsSkipped: 0,
    messagesIndexed: 0,
  });

  useEffect(() => {
    runSync(options, setProgress)
      .then(() => {
        // Give UI time to render final state, then exit
        // The embed process is already spawned and detached by runSync
        setTimeout(() => process.exit(0), 500);
      })
      .catch(() => {
        // Error is already captured in progress, exit with error code
        setTimeout(() => process.exit(1), 500);
      });
  }, []);

  return <SyncUI progress={progress} />;
}

export async function syncCommand(options: SyncOptions): Promise<void> {
  const { waitUntilExit } = render(<SyncApp options={options} />);
  await waitUntilExit();

  // Note: process.exit(0) is called in runSync() after phase='done'
  // to avoid LanceDB native binding cleanup crash
}
