/**
 * Unit tests for Cursor adapter parser
 * 
 * This file uses Node's native test runner and can be run with:
 *   bun run test:cursor
 * 
 * The main cursor.test.ts is skipped in Bun due to better-sqlite3 issues.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { extractConversations } from '../../../src/adapters/cursor/parser';
import Database from 'better-sqlite3';

// ============ Mock Data Helpers ============

interface MockCursorBubble {
  bubbleId: string;
  type: number;
  text: string;
  relevantFiles?: string[];
  context?: { fileSelections?: Array<{ uri?: { fsPath?: string } }> };
  tokenCount?: { inputTokens?: number; outputTokens?: number };
}

interface MockCursorComposerData {
  composerId: string;
  name?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  forceMode?: string;
  modelConfig?: { modelName?: string };
  conversation?: MockCursorBubble[];
  conversationMap?: Record<string, MockCursorBubble>;
  fullConversationHeadersOnly?: Array<{ bubbleId: string; type?: number }>;
  context?: { fileSelections?: Array<{ uri?: { fsPath?: string } }> };
  codeBlockData?: Record<string, Record<string, { diffId?: string; uri?: { fsPath?: string }; bubbleId?: string }>>;
}

function createMockBubble(
  type: 'user' | 'assistant',
  text: string,
  options: { bubbleId?: string; relevantFiles?: string[]; inputTokens?: number; outputTokens?: number } = {}
): MockCursorBubble {
  return {
    bubbleId: options.bubbleId ?? `bubble-${Math.random().toString(36).slice(2, 10)}`,
    type: type === 'user' ? 1 : 2,
    text,
    relevantFiles: options.relevantFiles,
    tokenCount: options.inputTokens || options.outputTokens
      ? { inputTokens: options.inputTokens, outputTokens: options.outputTokens }
      : undefined,
  };
}

function createMockConversation(
  composerId: string,
  bubbles: MockCursorBubble[],
  options: { name?: string; forceMode?: string; modelName?: string; fileSelections?: string[] } = {}
): MockCursorComposerData {
  return {
    composerId,
    name: options.name ?? 'Test Conversation',
    createdAt: Date.now() - 3600000,
    lastUpdatedAt: Date.now(),
    forceMode: options.forceMode,
    modelConfig: options.modelName ? { modelName: options.modelName } : undefined,
    conversation: bubbles,
    context: options.fileSelections
      ? { fileSelections: options.fileSelections.map((p) => ({ uri: { fsPath: p } })) }
      : undefined,
  };
}

async function createDatabase(dbPath: string, conversations: MockCursorComposerData[]): Promise<void> {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)`);
  const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  
  for (const conv of conversations) {
    insert.run(`composerData:${conv.composerId}`, JSON.stringify(conv));
  }
  db.close();
}

// ============ Tests ============

describe('Cursor parser', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cursor-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('extracts basic conversation with user and assistant messages', async () => {
    const dbPath = join(tempDir, 'state.vscdb');
    const bubbles = [
      createMockBubble('user', 'Hello, how are you?', { bubbleId: 'b1' }),
      createMockBubble('assistant', 'I am doing well!', { bubbleId: 'b2' }),
    ];
    const conversation = createMockConversation('comp-1', bubbles, { name: 'Greeting Chat' });
    
    await createDatabase(dbPath, [conversation]);
    const conversations = await extractConversations(dbPath);

    assert.strictEqual(conversations.length, 1);
    assert.strictEqual(conversations[0]!.name, 'Greeting Chat');
    assert.strictEqual(conversations[0]!.bubbles.length, 2);
    assert.strictEqual(conversations[0]!.bubbles[0]!.type, 'user');
    assert.strictEqual(conversations[0]!.bubbles[0]!.text, 'Hello, how are you?');
    assert.strictEqual(conversations[0]!.bubbles[1]!.type, 'assistant');
  });

  it('extracts mode from forceMode', async () => {
    const dbPath = join(tempDir, 'state.vscdb');
    const conversation = createMockConversation(
      'comp-1',
      [createMockBubble('user', 'Hello')],
      { forceMode: 'agent' }
    );
    
    await createDatabase(dbPath, [conversation]);
    const conversations = await extractConversations(dbPath);

    assert.strictEqual(conversations[0]!.mode, 'agent');
  });

  it('extracts model from modelConfig', async () => {
    const dbPath = join(tempDir, 'state.vscdb');
    const conversation = createMockConversation(
      'comp-1',
      [createMockBubble('user', 'Hello')],
      { modelName: 'gpt-4-turbo' }
    );
    
    await createDatabase(dbPath, [conversation]);
    const conversations = await extractConversations(dbPath);

    assert.strictEqual(conversations[0]!.model, 'gpt-4-turbo');
  });

  it('extracts token usage from bubbles', async () => {
    const dbPath = join(tempDir, 'state.vscdb');
    const bubbles = [
      createMockBubble('user', 'Q1', { bubbleId: 'b1', inputTokens: 100 }),
      createMockBubble('assistant', 'A1', { bubbleId: 'b2', inputTokens: 500, outputTokens: 200 }),
      createMockBubble('user', 'Q2', { bubbleId: 'b3', inputTokens: 600 }),
      createMockBubble('assistant', 'A2', { bubbleId: 'b4', inputTokens: 800, outputTokens: 150 }),
    ];
    const conversation = createMockConversation('comp-1', bubbles);
    
    await createDatabase(dbPath, [conversation]);
    const conversations = await extractConversations(dbPath);

    // Input tokens = MAX (peak context), output = SUM
    assert.strictEqual(conversations[0]!.totalInputTokens, 800);
    assert.strictEqual(conversations[0]!.totalOutputTokens, 350);
  });

  it('extracts files from context fileSelections', async () => {
    const dbPath = join(tempDir, 'state.vscdb');
    const conversation = createMockConversation(
      'comp-1',
      [createMockBubble('user', 'Hello')],
      { fileSelections: ['/home/user/project/src/index.ts', '/home/user/project/src/utils.ts'] }
    );
    
    await createDatabase(dbPath, [conversation]);
    const conversations = await extractConversations(dbPath);

    assert.strictEqual(conversations[0]!.files.length, 2);
    assert.strictEqual(conversations[0]!.files[0]!.path, '/home/user/project/src/index.ts');
    assert.strictEqual(conversations[0]!.files[0]!.role, 'context');
  });

  it('extracts files from relevantFiles', async () => {
    const dbPath = join(tempDir, 'state.vscdb');
    const bubbles = [
      createMockBubble('user', 'Look at these', {
        bubbleId: 'b1',
        relevantFiles: ['/home/user/project/src/api.ts'],
      }),
    ];
    const conversation = createMockConversation('comp-1', bubbles);
    
    await createDatabase(dbPath, [conversation]);
    const conversations = await extractConversations(dbPath);

    const apiFile = conversations[0]!.files.find((f) => f.path === '/home/user/project/src/api.ts');
    assert.ok(apiFile);
    assert.strictEqual(apiFile.role, 'mentioned');
  });

  it('handles multiple conversations', async () => {
    const dbPath = join(tempDir, 'state.vscdb');
    const conv1 = createMockConversation('comp-1', [createMockBubble('user', 'First')], { name: 'First Chat' });
    const conv2 = createMockConversation('comp-2', [createMockBubble('user', 'Second')], { name: 'Second Chat' });
    
    await createDatabase(dbPath, [conv1, conv2]);
    const conversations = await extractConversations(dbPath);

    assert.strictEqual(conversations.length, 2);
    const names = conversations.map((c) => c.name).sort();
    assert.deepStrictEqual(names, ['First Chat', 'Second Chat']);
  });

  it('skips conversations with no bubbles', async () => {
    const dbPath = join(tempDir, 'state.vscdb');
    const emptyConv = createMockConversation('comp-1', [], { name: 'Empty' });
    const validConv = createMockConversation('comp-2', [createMockBubble('user', 'Hello')], { name: 'Valid' });
    
    await createDatabase(dbPath, [emptyConv, validConv]);
    const conversations = await extractConversations(dbPath);

    assert.strictEqual(conversations.length, 1);
    assert.strictEqual(conversations[0]!.name, 'Valid');
  });

  it('uses Untitled as default name', async () => {
    const dbPath = join(tempDir, 'state.vscdb');
    const conversation = createMockConversation('comp-1', [createMockBubble('user', 'Hello')]);
    delete (conversation as any).name;
    
    await createDatabase(dbPath, [conversation]);
    const conversations = await extractConversations(dbPath);

    assert.strictEqual(conversations[0]!.name, 'Untitled');
  });

  it('handles malformed JSON gracefully', async () => {
    const dbPath = join(tempDir, 'state.vscdb');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)`);
    const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    
    insert.run('composerData:bad', 'not valid json');
    const validConv = createMockConversation('good', [createMockBubble('user', 'Hello')], { name: 'Valid' });
    insert.run('composerData:good', JSON.stringify(validConv));
    db.close();

    const conversations = await extractConversations(dbPath);

    assert.strictEqual(conversations.length, 1);
    assert.strictEqual(conversations[0]!.name, 'Valid');
  });
});

