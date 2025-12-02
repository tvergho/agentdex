/**
 * Fast sync state cache using a JSON file instead of LanceDB.
 * This avoids expensive LanceDB initialization just to check if sync is needed.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDataDir } from './config';
import { adapters } from '../adapters/index';

interface SyncCache {
  // Map of adapter name -> last known quick mtime
  adapterMtimes: Record<string, number>;
  // Timestamp of last sync completion
  lastSyncAt: number;
}

const CACHE_FILE = 'sync-cache.json';

function getCachePath(): string {
  return join(getDataDir(), CACHE_FILE);
}

function loadCache(): SyncCache | null {
  const path = getCachePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function saveCache(cache: SyncCache): void {
  const path = getCachePath();
  try {
    writeFileSync(path, JSON.stringify(cache, null, 2));
  } catch {
    // Ignore write errors
  }
}

/**
 * Quick check if sync is needed by comparing adapter root mtimes.
 * This is O(n) where n = number of adapters (4), with just 1 stat call per adapter.
 * Returns true if sync is likely needed, false if everything appears up to date.
 */
export function quickNeedsSync(): boolean {
  const cache = loadCache();

  // If no cache, sync is needed
  if (!cache) return true;

  for (const adapter of adapters) {
    const quickMtime = adapter.getQuickMtime();
    const cachedMtime = cache.adapterMtimes[adapter.name];

    // If adapter is available but wasn't in cache, sync needed
    if (quickMtime !== null && cachedMtime === undefined) {
      return true;
    }

    // If mtime changed, sync needed
    if (quickMtime !== null && quickMtime > (cachedMtime || 0)) {
      return true;
    }
  }

  return false;
}

/**
 * Update the sync cache after a successful sync.
 * Called by sync.tsx after sync completes.
 */
export function updateSyncCache(): void {
  const cache: SyncCache = {
    adapterMtimes: {},
    lastSyncAt: Date.now(),
  };

  for (const adapter of adapters) {
    const mtime = adapter.getQuickMtime();
    if (mtime !== null) {
      cache.adapterMtimes[adapter.name] = mtime;
    }
  }

  saveCache(cache);
}

/**
 * Get the last sync timestamp (for display purposes).
 */
export function getLastSyncTime(): number | null {
  const cache = loadCache();
  return cache?.lastSyncAt ?? null;
}
