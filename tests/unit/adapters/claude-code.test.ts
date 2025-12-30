/**
 * Unit tests for Claude Code adapter parser
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { extractConversations } from '../../../src/adapters/claude-code/parser';
import { TempDir } from '../../helpers/temp';
import { createClaudeCodeProject, type MockClaudeEntry } from '../../helpers/sources';

describe('Claude Code parser', () => {
  let temp: TempDir;

  beforeEach(() => {
    temp = new TempDir();
  });

  afterEach(async () => {
    await temp.cleanupAll();
  });

  describe('extractConversations', () => {
    it('extracts basic conversation with user and assistant messages', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          parentUuid: null,
          timestamp: '2025-01-15T10:00:00.000Z',
          message: {
            role: 'user',
            content: 'Hello, how are you?',
          },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          parentUuid: 'msg-1',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: {
            role: 'assistant',
            content: 'I am doing well, thank you!',
            model: 'claude-3-opus',
          },
        },
        {
          type: 'summary',
          summary: 'Greeting conversation',
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const conversations = extractConversations({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      expect(conversations.length).toBe(1);
      expect(conversations[0]!.title).toBe('Greeting conversation');
      expect(conversations[0]!.messages.length).toBe(2);
      expect(conversations[0]!.messages[0]!.role).toBe('user');
      expect(conversations[0]!.messages[0]!.content).toBe('Hello, how are you?');
      expect(conversations[0]!.messages[1]!.role).toBe('assistant');
      expect(conversations[0]!.model).toBe('claude-3-opus');
    });

    it('uses Untitled as default title when no summary exists', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: { role: 'assistant', content: 'Hi there' },
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const conversations = extractConversations({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      expect(conversations[0]!.title).toBe('Untitled');
    });

    it('extracts token usage from messages', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: {
            role: 'user',
            content: 'Question',
            usage: { input_tokens: 100 },
          },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: {
            role: 'assistant',
            content: 'Answer',
            usage: {
              input_tokens: 150,
              output_tokens: 200,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 25,
            },
          },
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const conversations = extractConversations({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      const conv = conversations[0]!;
      expect(conv.totalInputTokens).toBe(225);
      expect(conv.totalOutputTokens).toBe(200);
      expect(conv.totalCacheCreationTokens).toBe(50);
      expect(conv.totalCacheReadTokens).toBe(25);
    });

    it('extracts tool calls from content array', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Read the file' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me read that file.' },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { file_path: '/path/to/file.ts' },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'msg-3',
          timestamp: '2025-01-15T10:00:02.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1' },
            ],
          },
          toolUseResult: {
            type: 'text',
            filePath: '/path/to/file.ts',
            content: 'File contents here',
          },
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const conversations = extractConversations({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      const assistantMsg = conversations[0]!.messages.find((m) => m.role === 'assistant');
      expect(assistantMsg!.toolCalls.length).toBe(1);
      expect(assistantMsg!.toolCalls[0]!.name).toBe('Read');
      expect(assistantMsg!.toolCalls[0]!.filePath).toBe('/path/to/file.ts');
    });

    it('extracts file edits from Edit tool calls', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Edit the file' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will edit the file.' },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Edit',
                input: {
                  file_path: '/path/to/file.ts',
                  old_string: 'const x = 1;\nconst y = 2;',
                  new_string: 'const x = 10;\nconst y = 20;\nconst z = 30;',
                },
              },
            ],
          },
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const conversations = extractConversations({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      const conv = conversations[0]!;
      expect(conv.fileEdits.length).toBe(1);
      expect(conv.fileEdits[0]!.filePath).toBe('/path/to/file.ts');
      expect(conv.fileEdits[0]!.editType).toBe('modify');
      expect(conv.fileEdits[0]!.linesRemoved).toBe(2);
      expect(conv.fileEdits[0]!.linesAdded).toBe(3);
      expect(conv.totalLinesAdded).toBe(3);
      expect(conv.totalLinesRemoved).toBe(2);
    });

    it('extracts file edits from Write tool calls', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Create a file' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Creating file.' },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Write',
                input: {
                  file_path: '/path/to/new-file.ts',
                  content: 'line 1\nline 2\nline 3\nline 4',
                },
              },
            ],
          },
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const conversations = extractConversations({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      const conv = conversations[0]!;
      expect(conv.fileEdits.length).toBe(1);
      expect(conv.fileEdits[0]!.editType).toBe('create');
      expect(conv.fileEdits[0]!.linesAdded).toBe(4);
      expect(conv.fileEdits[0]!.linesRemoved).toBe(0);
    });

    it('extracts timestamps for createdAt and updatedAt', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Hello' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T12:30:00.000Z',
          message: { role: 'assistant', content: 'Hi' },
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const conversations = extractConversations({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      expect(conversations[0]!.createdAt).toBe('2025-01-15T10:00:00.000Z');
      expect(conversations[0]!.updatedAt).toBe('2025-01-15T12:30:00.000Z');
    });

    it('handles multiple sessions in one project', async () => {
      const baseDir = await temp.create();
      const entries1: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Session 1' },
        },
        { type: 'summary', summary: 'First session' },
      ];
      const entries2: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-2',
          timestamp: '2025-01-15T11:00:00.000Z',
          message: { role: 'user', content: 'Session 2' },
        },
        { type: 'summary', summary: 'Second session' },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries: entries1 },
        { sessionId: 'session-2', entries: entries2 },
      ]);

      const conversations = extractConversations({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      expect(conversations.length).toBe(2);
      const titles = conversations.map((c) => c.title).sort();
      expect(titles).toEqual(['First session', 'Second session']);
    });

    it('skips empty sessions', async () => {
      const baseDir = await temp.create();
      const entries: MockClaudeEntry[] = [
        { type: 'summary', summary: 'Empty session' },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const conversations = extractConversations({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      expect(conversations.length).toBe(0);
    });

    it('handles malformed JSON gracefully', async () => {
      const baseDir = await temp.create();
      const sessionsDir = await createClaudeCodeProject(baseDir, []);
      
      // Write a malformed file
      const { writeFile } = await import('fs/promises');
      const { join } = await import('path');
      await writeFile(join(sessionsDir, 'bad-session.jsonl'), 'not valid json\n{also bad');

      // Should not throw
      const conversations = extractConversations({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      expect(conversations.length).toBe(0);
    });

    it('categorizes files by tool type', async () => {
      const baseDir = await temp.create();
      // Each tool_result needs its own entry with toolUseResult to track the file
      const entries: MockClaudeEntry[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          timestamp: '2025-01-15T10:00:00.000Z',
          message: { role: 'user', content: 'Do things' },
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2025-01-15T10:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/read.ts' } },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'msg-3',
          timestamp: '2025-01-15T10:00:02.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1' }],
          },
          toolUseResult: { filePath: '/read.ts', type: 'text' },
        },
        {
          type: 'assistant',
          uuid: 'msg-4',
          timestamp: '2025-01-15T10:00:03.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/write.ts', content: 'x' } },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'msg-5',
          timestamp: '2025-01-15T10:00:04.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't2' }],
          },
          toolUseResult: { filePath: '/write.ts', type: 'text' },
        },
      ];

      const sessionsDir = await createClaudeCodeProject(baseDir, [
        { sessionId: 'session-1', entries },
      ]);

      const conversations = extractConversations({
        sessionsDir,
        workspacePath: '/home/user/project',
      });

      const files = conversations[0]!.files;
      const readFile = files.find((f) => f.path === '/read.ts');
      const writeFile = files.find((f) => f.path === '/write.ts');

      expect(readFile!.role).toBe('context');
      expect(writeFile!.role).toBe('edited');
    });
  });
});

