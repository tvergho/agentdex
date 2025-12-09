import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { withRetry, withConnectionRecovery, acquireSyncLock, releaseSyncLock, isTransientError, isCorruptedDatabaseError, extractCorruptedTableName } from '../../../src/db/index';

// Mock the config module to use a temp directory
const originalEnv = process.env.DEX_DATA_DIR;
let tempDir: string;

beforeEach(() => {
  tempDir = join('/tmp', `dex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  process.env.DEX_DATA_DIR = tempDir;
});

afterEach(() => {
  process.env.DEX_DATA_DIR = originalEnv;
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('withRetry', () => {
  it('returns result on success', async () => {
    const result = await withRetry(async () => 'success');
    expect(result).toBe('success');
  });

  it('retries on commit conflict errors', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Commit conflict detected');
      }
      return 'success after retries';
    });
    
    expect(result).toBe('success after retries');
    expect(attempts).toBe(3);
  });

  it('throws non-commit-conflict errors immediately', async () => {
    let attempts = 0;
    
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('Some other error');
      })
    ).rejects.toThrow('Some other error');
    
    expect(attempts).toBe(1);
  });

  it('throws after max retries on persistent conflict', async () => {
    let attempts = 0;
    
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('Commit conflict');
      }, 3)
    ).rejects.toThrow('Commit conflict');
    
    expect(attempts).toBe(4); // Initial + 3 retries
  });

  it('uses custom retry count', async () => {
    let attempts = 0;
    
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('concurrent commit error');
      }, 5)
    ).rejects.toThrow('concurrent commit error');
    
    expect(attempts).toBe(6); // Initial + 5 retries
  });

  it('handles async operations correctly', async () => {
    let value = 0;
    
    const result = await withRetry(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      value++;
      return value;
    });
    
    expect(result).toBe(1);
  });
});

describe('acquireSyncLock / releaseSyncLock', () => {
  it('acquires lock when none exists', () => {
    const acquired = acquireSyncLock();
    expect(acquired).toBe(true);
    
    // Verify lock file exists
    const lockPath = join(tempDir, 'sync.lock');
    expect(existsSync(lockPath)).toBe(true);
    
    // Clean up
    releaseSyncLock();
  });

  it('prevents acquiring lock when already held', () => {
    const first = acquireSyncLock();
    expect(first).toBe(true);
    
    // Second attempt should fail
    const second = acquireSyncLock();
    expect(second).toBe(false);
    
    // Clean up
    releaseSyncLock();
  });

  it('releases lock correctly', () => {
    acquireSyncLock();
    releaseSyncLock();
    
    // Lock file should be removed
    const lockPath = join(tempDir, 'sync.lock');
    expect(existsSync(lockPath)).toBe(false);
    
    // Should be able to acquire again
    const acquired = acquireSyncLock();
    expect(acquired).toBe(true);
    releaseSyncLock();
  });

  it('removes stale lock from dead process', () => {
    const lockPath = join(tempDir, 'sync.lock');
    
    // Create a lock file with a non-existent PID
    const staleLock = {
      pid: 99999999, // Very unlikely to exist
      startedAt: Date.now() - 1000, // Recent but process is dead
    };
    writeFileSync(lockPath, JSON.stringify(staleLock));
    
    // Should be able to acquire lock (stale lock removed)
    const acquired = acquireSyncLock();
    expect(acquired).toBe(true);
    
    releaseSyncLock();
  });

  it('removes very old stale lock', () => {
    const lockPath = join(tempDir, 'sync.lock');
    
    // Create a lock file that's older than 5 minutes
    const staleLock = {
      pid: process.pid, // Our own PID, but very old
      startedAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago
    };
    writeFileSync(lockPath, JSON.stringify(staleLock));
    
    // Should be able to acquire lock (old lock removed)
    const acquired = acquireSyncLock();
    expect(acquired).toBe(true);
    
    releaseSyncLock();
  });

  it('handles corrupted lock file', () => {
    const lockPath = join(tempDir, 'sync.lock');
    
    // Create a corrupted lock file
    writeFileSync(lockPath, 'not valid json');
    
    // Should be able to acquire lock (corrupted lock removed)
    const acquired = acquireSyncLock();
    expect(acquired).toBe(true);
    
    releaseSyncLock();
  });

  it('only releases lock owned by current process', () => {
    const lockPath = join(tempDir, 'sync.lock');
    
    // Create a lock file owned by a different PID
    const otherLock = {
      pid: process.pid + 1, // Different PID
      startedAt: Date.now(),
    };
    writeFileSync(lockPath, JSON.stringify(otherLock));
    
    // Release should not remove the lock (we don't own it)
    releaseSyncLock();
    
    // Lock file should still exist
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe('isTransientError', () => {
  it('returns true for commit conflict errors', () => {
    expect(isTransientError(new Error('Commit conflict detected'))).toBe(true);
    expect(isTransientError(new Error('concurrent commit error'))).toBe(true);
  });

  it('returns false for Not found .lance errors (handled by isCorruptedDatabaseError)', () => {
    // These are now handled by withConnectionRecovery, not withRetry
    expect(isTransientError(new Error('Not found: some/file.lance'))).toBe(false);
    expect(isTransientError(new Error('External error: Not found'))).toBe(false);
  });

  it('returns false for Failed to get next batch errors (handled by isCorruptedDatabaseError)', () => {
    // These are now handled by withConnectionRecovery, not withRetry
    expect(isTransientError(new Error('Failed to get next batch from stream'))).toBe(false);
  });

  it('returns false for .lance file errors (handled by isCorruptedDatabaseError)', () => {
    // These are now handled by withConnectionRecovery, not withRetry
    expect(isTransientError(new Error('Error reading file.lance'))).toBe(false);
    expect(isTransientError(new Error('messages.lance not accessible'))).toBe(false);
  });

  it('returns true for LanceError without file issues', () => {
    // Generic LanceError without file issues is still transient
    expect(isTransientError(new Error('LanceError: IO timeout'))).toBe(true);
  });

  it('returns false for LanceError with Not found or .lance', () => {
    // LanceError with file issues goes through corruption recovery path
    expect(isTransientError(new Error('LanceError: Not found'))).toBe(false);
    expect(isTransientError(new Error('LanceError: file.lance missing'))).toBe(false);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientError(new Error('Some other error'))).toBe(false);
    expect(isTransientError(new Error('Database connection failed'))).toBe(false);
    expect(isTransientError(new Error('Invalid query'))).toBe(false);
  });

  it('returns false for non-Error objects', () => {
    expect(isTransientError('string error')).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError({ message: 'Not found' })).toBe(false);
  });
});

describe('isCorruptedDatabaseError', () => {
  it('returns true for Not found .lance errors', () => {
    expect(isCorruptedDatabaseError(new Error('Not found: ~/.dex/lancedb/conversations.lance/data/abc123.lance'))).toBe(true);
    expect(isCorruptedDatabaseError(new Error('LanceError(IO): External error: Not found: some/file.lance'))).toBe(true);
  });

  it('returns true for Failed to get next batch with .lance', () => {
    expect(isCorruptedDatabaseError(new Error('Failed to get next batch from stream: lance error: LanceError(IO): External error: Not found: file.lance'))).toBe(true);
  });

  it('returns false for Not found without .lance', () => {
    expect(isCorruptedDatabaseError(new Error('Not found: some/other/file.txt'))).toBe(false);
  });

  it('returns false for generic errors', () => {
    expect(isCorruptedDatabaseError(new Error('Some other error'))).toBe(false);
    expect(isCorruptedDatabaseError(new Error('LanceError: timeout'))).toBe(false);
  });

  it('returns false for non-Error objects', () => {
    expect(isCorruptedDatabaseError('string error')).toBe(false);
    expect(isCorruptedDatabaseError(null)).toBe(false);
    expect(isCorruptedDatabaseError(undefined)).toBe(false);
  });
});

describe('extractCorruptedTableName', () => {
  it('extracts table name from error message', () => {
    expect(extractCorruptedTableName(new Error('Not found: ~/.dex/lancedb/conversations.lance/data/abc123.lance'))).toBe('conversations');
    expect(extractCorruptedTableName(new Error('Not found: ~/.dex/lancedb/messages.lance/data/xyz.lance'))).toBe('messages');
  });

  it('returns null for errors without table name', () => {
    expect(extractCorruptedTableName(new Error('Some other error'))).toBe(null);
    expect(extractCorruptedTableName(new Error('Not found: file.txt'))).toBe(null);
  });

  it('returns null for non-Error objects', () => {
    expect(extractCorruptedTableName('string error')).toBe(null);
    expect(extractCorruptedTableName(null)).toBe(null);
  });
});

describe('withRetry transient errors', () => {
  it('does not retry Not found .lance errors (now handled by withConnectionRecovery)', async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('Not found: some/data.lance');
      })
    ).rejects.toThrow('Not found');
    expect(attempts).toBe(1); // No retry for file errors
  });

  it('retries on LanceError without file issues', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('LanceError: IO timeout'); // No "Not found" or ".lance"
      }
      return 'success';
    });

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });
});

describe('withConnectionRecovery', () => {
  it('returns result on success', async () => {
    const result = await withConnectionRecovery(async () => 'success');
    expect(result).toBe('success');
  });

  it('retries on corrupted database errors (Not found .lance)', async () => {
    let attempts = 0;
    // Note: In real usage this would reset the connection, but we're testing the retry logic
    const result = await withConnectionRecovery(async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error('Not found: ~/.dex/lancedb/messages.lance/data/abc.lance');
      }
      return 'success after recovery';
    });

    expect(result).toBe('success after recovery');
    expect(attempts).toBe(2);
  });

  it('retries on commit conflict errors', async () => {
    let attempts = 0;
    const result = await withConnectionRecovery(async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error('Commit conflict detected');
      }
      return 'success';
    });

    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('throws non-recoverable errors immediately', async () => {
    let attempts = 0;
    await expect(
      withConnectionRecovery(async () => {
        attempts++;
        throw new Error('Some other error');
      })
    ).rejects.toThrow('Some other error');
    expect(attempts).toBe(1);
  });

  it('throws after max retries on persistent corruption', async () => {
    let attempts = 0;
    await expect(
      withConnectionRecovery(async () => {
        attempts++;
        throw new Error('Not found: ~/.dex/lancedb/messages.lance/data/abc.lance');
      }, 2)
    ).rejects.toThrow('Not found');
    expect(attempts).toBe(3); // Initial + 2 retries
  });
});

