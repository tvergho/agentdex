/**
 * Backup command - exports full dex state as JSON for migration between machines
 *
 * Usage: dex backup [options]
 *
 * Options:
 *   -o, --output <file>    Output file (default: dex-backup-TIMESTAMP.json)
 *   -p, --project <path>   Filter by project/workspace path (optional)
 *   -s, --source <source>  Filter by source (cursor, claude-code, codex)
 *   --from <date>          Start date filter (optional)
 *   --to <date>            End date filter (optional)
 */

import { writeFile } from 'fs/promises';
import { hostname } from 'os';
import { connect } from '../../db/index';
import {
  conversationRepo,
  messageRepo,
  toolCallRepo,
  filesRepo,
  messageFilesRepo,
  fileEditsRepo,
} from '../../db/repository';
import { isValidDate } from '../../utils/export';
import type { ExportArchive, ExportedConversation } from '../../schema/index';

interface BackupOptions {
  output?: string;
  project?: string;
  source?: string;
  from?: string;
  to?: string;
}

export async function backupCommand(options: BackupOptions): Promise<void> {
  // Validate date options if provided
  if (options.from && !isValidDate(options.from)) {
    console.error(`Invalid --from date: ${options.from}`);
    console.error('Use ISO 8601 format (e.g., 2024-01-15) or YYYY-MM-DD');
    process.exit(1);
  }
  if (options.to && !isValidDate(options.to)) {
    console.error(`Invalid --to date: ${options.to}`);
    console.error('Use ISO 8601 format (e.g., 2024-01-15) or YYYY-MM-DD');
    process.exit(1);
  }

  // Validate source option if provided
  const validSources = ['cursor', 'claude-code', 'codex'];
  if (options.source && !validSources.includes(options.source)) {
    console.error(`Invalid --source: ${options.source}`);
    console.error(`Valid sources: ${validSources.join(', ')}`);
    process.exit(1);
  }

  await connect();

  // Fetch conversations based on filters
  console.log('Finding conversations...');

  const conversations = await conversationRepo.findByFilters({
    source: options.source,
    workspacePath: options.project,
    fromDate: options.from,
    toDate: options.to,
  });

  if (conversations.length === 0) {
    console.log('No conversations found matching the specified filters.');
    return;
  }

  console.log(`Found ${conversations.length} conversation(s) to backup.`);
  console.log('Collecting related data...');

  // Collect all data for each conversation
  const exportedConversations: ExportedConversation[] = [];

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i]!;

    try {
      // Fetch all related data in parallel
      const [messages, toolCalls, files, messageFiles, fileEdits] = await Promise.all([
        messageRepo.findByConversation(conv.id),
        toolCallRepo.findByConversation(conv.id),
        filesRepo.findByConversation(conv.id),
        messageFilesRepo.findByConversation(conv.id),
        fileEditsRepo.findByConversation(conv.id),
      ]);

      exportedConversations.push({
        conversation: conv,
        messages,
        toolCalls,
        files,
        messageFiles,
        fileEdits,
      });

      // Progress indicator
      if ((i + 1) % 10 === 0 || i + 1 === conversations.length) {
        console.log(`Processed ${i + 1}/${conversations.length} conversations...`);
      }
    } catch (err) {
      console.error(`Error processing conversation ${conv.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Build the archive
  const archive: ExportArchive = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    machine: hostname(),
    conversations: exportedConversations,
  };

  // Determine output filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputFile = options.output || `dex-backup-${timestamp}.json`;

  // Write the archive
  console.log('Writing backup file...');

  const jsonContent = JSON.stringify(archive, null, 2);
  await writeFile(outputFile, jsonContent, 'utf-8');

  // Calculate stats
  const totalMessages = exportedConversations.reduce((sum, c) => sum + c.messages.length, 0);
  const totalToolCalls = exportedConversations.reduce((sum, c) => sum + c.toolCalls.length, 0);
  const totalFiles = exportedConversations.reduce((sum, c) => sum + c.files.length, 0);
  const totalFileEdits = exportedConversations.reduce((sum, c) => sum + c.fileEdits.length, 0);
  const fileSizeKB = Math.round(jsonContent.length / 1024);

  // Summary
  console.log('');
  console.log('Backup complete!');
  console.log(`  File: ${outputFile}`);
  console.log(`  Size: ${fileSizeKB} KB`);
  console.log('');
  console.log('Contents:');
  console.log(`  Conversations: ${exportedConversations.length}`);
  console.log(`  Messages: ${totalMessages}`);
  console.log(`  Tool calls: ${totalToolCalls}`);
  console.log(`  Files: ${totalFiles}`);
  console.log(`  File edits: ${totalFileEdits}`);
  console.log('');
  console.log('To import this backup on another machine:');
  console.log(`  dex import ${outputFile}`);
}
