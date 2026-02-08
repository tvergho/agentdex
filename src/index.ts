#!/usr/bin/env node

// Global error handlers - must be set up FIRST to catch native crashes
// LanceDB uses native bindings that can crash without proper JS errors
process.on('uncaughtException', (error) => {
  console.error('[dex] Fatal error:', error.message || error);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason, _promise) => {
  console.error('[dex] Unhandled promise rejection:', reason);
  process.exit(1);
});

// Handle SIGTERM/SIGINT gracefully
let isShuttingDown = false;
const gracefulShutdown = (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`\n[dex] Received ${signal}, shutting down...`);
  process.exit(0);
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

import { Command } from 'commander';
import { createRequire } from 'module';
import { syncCommand } from './cli/commands/sync';
import { searchCommand } from './cli/commands/search';
import { listCommand } from './cli/commands/list';
import { showCommand } from './cli/commands/show';
import { statusCommand } from './cli/commands/status';
import { statsCommand } from './cli/commands/stats';
import { exportCommand } from './cli/commands/export';
import { backupCommand } from './cli/commands/backup';
import { importCommand } from './cli/commands/import';
import { unifiedCommand } from './cli/commands/unified';
import { configCommand } from './cli/commands/config';
import { embedCommand } from './cli/commands/embed';
import { chatCommand } from './cli/commands/chat';
import { billingImportCommand, billingStatsCommand, billingSyncCommand } from './cli/commands/billing';
import { reviewCommand } from './cli/commands/review';
import { reflectCommand } from './cli/commands/reflect';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };

const program = new Command()
  .name('dex')
  .description('Universal search for your coding agent conversations')
  .version(packageJson.version);

program
  .command('sync')
  .description('Index conversations from all sources')
  .option('-f, --force', 'Force re-index all conversations')
  .action(syncCommand);

program
  .command('search [query...]')
  .description('Full-text search across conversations')
  .option('-l, --limit <number>', 'Maximum number of results', '20')
  .option('-f, --file <pattern>', 'Filter by file path (e.g., auth.ts, src/components)')
  .option('-s, --source <source>', 'Filter by source (cursor, claude-code, codex, opencode)')
  .option('-m, --model <model>', 'Filter by model (opus, sonnet, gpt-4, etc.)')
  .option('-p, --project <path>', 'Filter by project/workspace path (substring match)')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--offset <number>', 'Skip first N results (for pagination)')
  .option('-j, --json', 'Output as JSON (for MCP/agent use)')
  .action((queryParts: string[], options) => searchCommand(queryParts.join(' '), options));

program
  .command('list')
  .description('Browse recent conversations')
  .option('-l, --limit <number>', 'Maximum number of conversations', '20')
  .option('-s, --source <source>', 'Filter by source (cursor, claude-code, codex, opencode)')
  .option('-p, --project <path>', 'Filter by project/workspace path (substring match)')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--offset <number>', 'Skip first N results (for pagination)')
  .option('-j, --json', 'Output as JSON (for MCP/agent use)')
  .action(listCommand);

program
  .command('show <id...>')
  .description('View a conversation')
  .option('-j, --json', 'Output as JSON (for MCP/agent use)')
  .option('--format <format>', 'Content format: full, stripped, user_only, outline', 'full')
  .option('--expand <index>', 'Expand around message index (use with --before/--after)')
  .option('--before <n>', 'Messages before expand point', '2')
  .option('--after <n>', 'Messages after expand point', '2')
  .option('--max-tokens <n>', 'Truncate if total tokens exceed this limit')
  .action(showCommand);

program
  .command('status')
  .description('Check embedding generation progress')
  .action(statusCommand);

program
  .command('stats')
  .description('View usage analytics and statistics')
  .option('-p, --period <days>', 'Time period in days', '30')
  .option('-s, --summary', 'Print quick summary (non-interactive)')
  .option('-j, --json', 'Output as JSON (for MCP/agent use)')
  .action(statsCommand);

program
  .command('export')
  .description('Export conversations as markdown files')
  .option('-o, --output <dir>', 'Output directory', './agentdex-export')
  .option('-p, --project <path>', 'Filter by project/workspace path')
  .option('-s, --source <source>', 'Filter by source (cursor, claude-code, codex, opencode)')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .option('--id <id>', 'Export a single conversation by ID')
  .action(exportCommand);

program
  .command('backup')
  .description('Export full database for backup/migration')
  .option('-o, --output <file>', 'Output file (default: dex-backup-TIMESTAMP.json)')
  .option('-p, --project <path>', 'Filter by project/workspace path')
  .option('-s, --source <source>', 'Filter by source (cursor, claude-code, codex, opencode)')
  .option('--from <date>', 'Start date (YYYY-MM-DD)')
  .option('--to <date>', 'End date (YYYY-MM-DD)')
  .action(backupCommand);

program
  .command('import <file>')
  .description('Import conversations from a backup archive')
  .option('--dry-run', 'Preview what would be imported without writing')
  .option('--force', 'Overwrite existing conversations')
  .action(importCommand);

program
  .command('config')
  .description('Open settings')
  .action(configCommand);

program
  .command('chat [query...]')
  .description('Start an AI chat session with dex tools (requires OpenCode)')
  .option('-p, --print', 'Print mode: output response to stdout without TUI')
  .action((queryParts: string[], options: { print?: boolean }) => 
    chatCommand({ query: queryParts.join(' '), print: options.print }));

program
  .command('review [branch]')
  .description('Correlate git commits with chat conversations')
  .option('-b, --base <branch>', 'Base branch to compare against', 'main')
  .option('-l, --limit <number>', 'Maximum number of commits to analyze', '100')
  .option('-r, --repo <path>', 'Repository path (defaults to current directory)')
  .option('-j, --json', 'Output as JSON')
  .option('-e, --export <path>', 'Export review as markdown to directory')
  .action(reviewCommand);

program
  .command('reflect [project]')
  .description('Analyze conversations to generate CLAUDE.md files')
  .option('-d, --days <n>', 'Time window in days', '90')
  .option('-s, --source <source>', 'Filter by source (cursor, claude-code, codex, opencode)')
  .option('--dry-run', 'Preview output without writing files')
  .option('-o, --output <dir>', 'Custom output directory')
  .option('--json', 'Output as JSON')
  .option('--force', 'Regenerate from scratch (ignore existing CLAUDE.md)')
  .option('-m, --model <model>', 'Model ID (default: claude-opus-4-6)')
  .option('--no-prs', 'Skip GitHub PR review analysis')
  .action(reflectCommand);

program
  .command('review-web <exportPath>')
  .description('Start web server for existing review export')
  .option('-p, --port <number>', 'Port to run server on', '3456')
  .action(async (exportPath: string, options: { port?: string }) => {
    const fs = await import('fs');
    const path = await import('path');
    const dataPath = path.default.join(exportPath, 'data.json');

    if (!fs.default.existsSync(dataPath)) {
      console.error(`Error: ${dataPath} not found. Run 'dex review --export ${exportPath}' first.`);
      process.exit(1);
    }

    const data = JSON.parse(fs.default.readFileSync(dataPath, 'utf-8'));
    const { startReviewServer } = await import('./cli/commands/review-web/server.js');
    const { default: open } = await import('open');

    const port = parseInt(options.port || '3456', 10);
    const { port: actualPort } = await startReviewServer({ data, port });
    const url = `http://localhost:${actualPort}`;

    console.log(`\n🌐 Review server running at ${url}`);
    console.log('   Press Ctrl+C to stop\n');
    await open(url);
  });

const billing = program
  .command('billing')
  .description('Manage Cursor billing data');

billing
  .command('import <file>')
  .description('Import billing events from a Cursor CSV export')
  .option('--dry-run', 'Preview what would be imported without writing')
  .action(billingImportCommand);

billing
  .command('stats')
  .description('Show billing data statistics')
  .action(billingStatsCommand);

billing
  .command('sync')
  .description('Fetch and sync billing data directly from Cursor API')
  .option('--dry-run', 'Preview what would be synced without writing')
  .option('--days <number>', 'Number of days of history to fetch', '365')
  .action(billingSyncCommand);

// MCP server command
program
  .command('serve')
  .description('Start MCP server for agent integration (stdio transport)')
  .action(async () => {
    const { startMcpServer } = await import('./mcp/server');
    await startMcpServer();
  });

// Internal command for background embedding (hidden from help)
program
  .command('embed', { hidden: true })
  .option('--benchmark', 'Run benchmark to find optimal settings')
  .action(embedCommand);

// Internal command for getting counts (used by unified.tsx background checks)
program
  .command('count', { hidden: true })
  .option('--messages', 'Count messages')
  .option('--conversations', 'Count conversations')
  .action(async (options: { messages?: boolean; conversations?: boolean }) => {
    const { connect } = await import('./db/index');
    const { conversationRepo, messageRepo } = await import('./db/repository');
    await connect();
    if (options.messages) {
      const count = await messageRepo.count();
      console.log(count);
    } else {
      // Default to conversation count
      const count = await conversationRepo.count();
      console.log(count);
    }
    process.exit(0);
  });

// Default action when no subcommand is provided
program.action(async () => {
  await unifiedCommand();
});

program.parse();
