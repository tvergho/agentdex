/**
 * Database test harness for integration tests
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
  Conversation,
  Message,
  ConversationFile,
  ToolCall,
  FileEdit,
  BillingEvent,
} from '../../src/schema/index';
import { resetConnection } from '../../src/db/index';

// Store original env value
let originalDataDir: string | undefined;

/**
 * Database test harness that creates an isolated test database
 */
export class TestDatabase {
  private tempDir: string | null = null;

  /**
   * Set up a temporary database directory
   */
  async setup(): Promise<void> {
    // Store original
    originalDataDir = process.env.DEX_DATA_DIR;

    // Reset any existing connection to ensure fresh start
    resetConnection();

    // Create temp directory
    this.tempDir = await mkdtemp(join(tmpdir(), 'dex-test-db-'));

    // Override the data directory
    process.env.DEX_DATA_DIR = this.tempDir;
  }

  /**
   * Get the temporary directory path
   */
  getDataDir(): string {
    if (!this.tempDir) {
      throw new Error('TestDatabase not set up. Call setup() first.');
    }
    return this.tempDir;
  }

  /**
   * Seed the database with test data
   */
  async seed(data: {
    conversations?: Conversation[];
    messages?: Message[];
    files?: ConversationFile[];
    toolCalls?: ToolCall[];
    fileEdits?: FileEdit[];
    billingEvents?: BillingEvent[];
  }): Promise<void> {
    const { connect } = await import('../../src/db/index');
    const {
      conversationRepo,
      messageRepo,
      filesRepo,
      toolCallRepo,
      fileEditsRepo,
      billingEventsRepo,
    } = await import('../../src/db/repository');

    await connect();

    if (data.conversations) {
      for (const conv of data.conversations) {
        await conversationRepo.upsert(conv);
      }
    }

    if (data.messages) {
      await messageRepo.bulkInsert(data.messages);
    }

    if (data.files) {
      await filesRepo.bulkInsert(data.files);
    }

    if (data.toolCalls) {
      await toolCallRepo.bulkInsert(data.toolCalls);
    }

    if (data.fileEdits) {
      await fileEditsRepo.bulkInsert(data.fileEdits);
    }

    if (data.billingEvents) {
      await billingEventsRepo.bulkInsert(data.billingEvents);
    }
  }

  /**
   * Clean up the temporary database
   */
  async teardown(): Promise<void> {
    // Reset connection before cleanup to release file handles
    resetConnection();

    // Restore original env
    if (originalDataDir !== undefined) {
      process.env.DEX_DATA_DIR = originalDataDir;
    } else {
      delete process.env.DEX_DATA_DIR;
    }

    // Remove temp directory
    if (this.tempDir) {
      await rm(this.tempDir, { recursive: true, force: true });
      this.tempDir = null;
    }
  }
}

/**
 * Run a test with an isolated database
 * Handles setup and teardown automatically
 */
export async function withTestDatabase(
  fn: (db: TestDatabase) => Promise<void>
): Promise<void> {
  const db = new TestDatabase();
  await db.setup();
  try {
    await fn(db);
  } finally {
    await db.teardown();
  }
}

