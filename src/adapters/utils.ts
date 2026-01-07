/**
 * Shared utilities for adapter implementations
 */
import { createHash } from 'crypto';
import type { SourceType, SourceRef } from '../schema/index.js';

/**
 * Create a deterministic conversation ID from source and original ID.
 * Uses SHA256 hash truncated to 32 characters for consistency.
 */
export function createConversationId(source: string, originalId: string): string {
  return createHash('sha256')
    .update(`${source}:${originalId}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Create a deterministic ID for any entity (message, file edit, etc.)
 * Uses SHA256 hash truncated to 32 characters.
 */
export function createDeterministicId(...parts: (string | number)[]): string {
  return createHash('sha256')
    .update(parts.join(':'))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Create a SourceRef object with consistent structure.
 */
export function createSourceRef(
  source: SourceType,
  originalId: string,
  workspacePath: string | undefined,
  dbPath: string
): SourceRef {
  return {
    source,
    workspacePath,
    originalId,
    dbPath,
  };
}

interface ParsedTimestamps {
  createdAt: string | undefined;
  updatedAt: string | undefined;
}

/**
 * Parse raw timestamp values into ISO strings.
 * Handles various input formats (epoch ms, ISO strings, Date objects).
 * Returns undefined for invalid or missing timestamps.
 */
export function parseTimestamps(
  raw: { createdAt?: unknown; updatedAt?: unknown }
): ParsedTimestamps {
  return {
    createdAt: parseTimestamp(raw.createdAt),
    updatedAt: parseTimestamp(raw.updatedAt),
  };
}

/**
 * Parse a single timestamp value into an ISO string.
 */
export function parseTimestamp(value: unknown): string | undefined {
  if (!value) return undefined;
  try {
    return new Date(value as string | number).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Count lines in a string (for file edit calculations).
 */
export function countLines(str: string | undefined | null): number {
  if (!str) return 0;
  return str.split('\n').length;
}
