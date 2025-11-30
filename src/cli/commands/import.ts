/**
 * Import command - imports conversations from a backup archive
 *
 * Usage: dex import <file> [options]
 *
 * Options:
 *   --dry-run    Preview what would be imported without writing
 *   --force      Overwrite existing conversations (default: skip)
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { connect, rebuildFtsIndex } from '../../db/index';
import {
  conversationRepo,
  messageRepo,
  toolCallRepo,
  filesRepo,
  messageFilesRepo,
  fileEditsRepo,
} from '../../db/repository';
import { ExportArchive } from '../../schema/index';

interface ImportOptions {
  dryRun?: boolean;
  force?: boolean;
}

export async function importCommand(file: string, options: ImportOptions): Promise<void> {
  // Validate file exists
  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  // Read and parse the archive
  console.log(`Reading backup file: ${file}`);

  let archive: ExportArchive;
  try {
    const content = await readFile(file, 'utf-8');
    const parsed = JSON.parse(content);

    // Validate against schema
    const result = ExportArchive.safeParse(parsed);
    if (!result.success) {
      console.error('Invalid backup file format:');
      console.error(result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'));
      process.exit(1);
    }

    archive = result.data;
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`Invalid JSON in backup file: ${err.message}`);
    } else {
      console.error(`Error reading backup file: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }

  // Display archive info
  console.log('');
  console.log('Backup Info:');
  console.log(`  Version: ${archive.version}`);
  console.log(`  Exported: ${new Date(archive.exportedAt).toLocaleString()}`);
  if (archive.machine) {
    console.log(`  Machine: ${archive.machine}`);
  }
  console.log(`  Conversations: ${archive.conversations.length}`);
  console.log('');

  if (archive.conversations.length === 0) {
    console.log('No conversations to import.');
    return;
  }

  await connect();

  // Check which conversations already exist
  const existingIds = new Set<string>();
  for (const exported of archive.conversations) {
    const exists = await conversationRepo.exists(exported.conversation.id);
    if (exists) {
      existingIds.add(exported.conversation.id);
    }
  }

  const newCount = archive.conversations.length - existingIds.size;
  const existingCount = existingIds.size;

  console.log(`Found ${newCount} new conversation(s) and ${existingCount} existing.`);

  if (options.force && existingCount > 0) {
    console.log(`--force flag: Will overwrite ${existingCount} existing conversation(s).`);
  } else if (existingCount > 0) {
    console.log(`Will skip ${existingCount} existing conversation(s). Use --force to overwrite.`);
  }

  if (options.dryRun) {
    console.log('');
    console.log('Dry run - no changes made.');
    console.log('');
    console.log('Would import:');

    let wouldImport = 0;
    let wouldSkip = 0;

    for (const exported of archive.conversations) {
      const exists = existingIds.has(exported.conversation.id);

      if (exists && !options.force) {
        wouldSkip++;
        continue;
      }

      wouldImport++;
      const action = exists ? '[overwrite]' : '[new]';
      console.log(`  ${action} ${exported.conversation.title}`);
    }

    console.log('');
    console.log(`Summary: ${wouldImport} to import, ${wouldSkip} to skip.`);
    return;
  }

  // Perform the import
  console.log('');
  console.log('Importing...');

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < archive.conversations.length; i++) {
    const exported = archive.conversations[i]!;
    const conv = exported.conversation;
    const exists = existingIds.has(conv.id);

    // Skip existing unless --force
    if (exists && !options.force) {
      skipped++;
      continue;
    }

    try {
      // If overwriting, delete existing data first
      if (exists) {
        await Promise.all([
          messageRepo.deleteByConversation(conv.id),
          toolCallRepo.deleteByConversation(conv.id),
          filesRepo.deleteByConversation(conv.id),
          messageFilesRepo.deleteByConversation(conv.id),
          fileEditsRepo.deleteByConversation(conv.id),
          conversationRepo.delete(conv.id),
        ]);
      }

      // Insert conversation
      await conversationRepo.upsert(conv);

      // Insert related data
      await Promise.all([
        messageRepo.bulkInsert(exported.messages),
        toolCallRepo.bulkInsert(exported.toolCalls),
        filesRepo.bulkInsert(exported.files),
        messageFilesRepo.bulkInsert(exported.messageFiles),
        fileEditsRepo.bulkInsert(exported.fileEdits),
      ]);

      imported++;

      // Progress indicator
      if (imported % 10 === 0 || i + 1 === archive.conversations.length) {
        console.log(`Imported ${imported} conversation(s)...`);
      }
    } catch (err) {
      errors++;
      console.error(`Error importing "${conv.title}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Rebuild FTS index if we imported anything
  if (imported > 0) {
    console.log('Rebuilding search index...');
    try {
      await rebuildFtsIndex();
    } catch (err) {
      console.error(`Warning: Failed to rebuild FTS index: ${err instanceof Error ? err.message : String(err)}`);
      console.error('Search may not work correctly until next sync.');
    }
  }

  // Summary
  console.log('');
  console.log('Import complete!');
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped: ${skipped}`);
  if (errors > 0) {
    console.log(`  Errors: ${errors}`);
  }

  if (imported > 0) {
    console.log('');
    console.log('Note: Embedding vectors were not imported. Run `dex sync` to generate embeddings for semantic search.');
  }
}
