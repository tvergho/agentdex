# agentdex

**Local search engine for your AI coding conversations.**

[agentdex.sh](https://agentdex.sh)

agentdex indexes conversations from AI coding assistants (Cursor, Claude Code, Codex, OpenCode) into a local database with full-text search. Find that conversation where you debugged that tricky auth issue, or search across all your pair programming sessions.

## Features

- 🔍 **Full-text search** across all your AI conversations
- 🧠 **Semantic search** - finds related content even without exact keyword matches
- 📄 **File path search** - find conversations by file (e.g., `--file auth.ts`)
- 🖥️ **Interactive TUI** with vim-style navigation (j/k, Enter, Esc)
- 📁 **Project context** - see which files were discussed
- 🔄 **Incremental sync** - only indexes new conversations
- 📊 **Analytics dashboard** - token usage, activity heatmaps, project stats
- 📤 **Export & backup** - markdown exports and JSON backups for portability
- 🏠 **Fully local** - your data never leaves your machine

## Supported Sources

| Source | Status |
|--------|--------|
| Cursor | ✅ Supported |
| Claude Code | ✅ Supported |
| Codex CLI | ✅ Supported |
| OpenCode | ✅ Supported |

## Installation

```bash
npm install -g agentdex
```

This installs the `dex` command globally.

### From Source

Requires [Bun](https://bun.sh) or Node.js 18+:

```bash
git clone https://github.com/tvergho/agentdex.git
cd agentdex
bun install
```

## Quick Start

```bash
# Index your conversations
dex sync

# Search for something
dex search "authentication middleware"

# List all conversations
dex list

# View a specific conversation
dex show <conversation-id>
```

## Usage

### Search

```bash
# Search by content
dex search "your query"

# Search by file path
dex search --file auth.ts
dex search --file src/components

# Combined: content + file filter
dex search "authentication bug" --file auth.ts

# Filter by source or model
dex search "bug" --source cursor
dex search "refactor" --model opus
```

Navigate the interactive TUI:
- `j/k` or `↑/↓` - Move selection
- `Enter` - Expand/drill down
- `Esc` - Go back
- `g/G` - Jump to top/bottom
- `q` - Quit

The search has 4 levels of detail:
1. **Results list** - Matching conversations with snippets
2. **Matches view** - All matches within a conversation
3. **Conversation view** - Full conversation with messages
4. **Message view** - Complete message content

### Sync

```bash
# Sync from all sources
dex sync

# Force full re-sync
dex sync --force
```

### List

```bash
# List recent conversations
dex list

# Limit results
dex list --limit 10
```

### Export

Export conversations as readable markdown files:

```bash
# Export all conversations
dex export

# Export to custom directory
dex export --output ~/my-exports

# Filter by source
dex export --source cursor

# Filter by project (substring match)
dex export --project myapp

# Filter by date range
dex export --from 2025-01-01 --to 2025-01-31

# Export single conversation
dex export --id <conversation-id>
```

Output structure:
```
agentdex-export/
└── cursor/
    └── my-project/
        └── 2025-01-15_fixing-auth-bug.md
```

### Backup & Import

Full database backup for migration between machines:

```bash
# Create backup
dex backup

# Import on another machine
dex import backup.json

# Preview import without writing
dex import backup.json --dry-run
```

### Stats

View usage analytics and statistics:

```bash
# Interactive dashboard
dex stats

# Quick summary (non-interactive)
dex stats --summary

# Different time periods
dex stats --period 7
dex stats --period 90
```

## Data Storage

All data is stored locally in `~/.dex/`:

```
~/.dex/
├── lancedb/              # Main database (conversations, messages, FTS index)
├── models/               # Embedding models (downloaded on first use)
├── embed-config.json     # Auto-benchmarked embedding settings
└── embedding-progress.json
```

## Development

```bash
# Run in development mode
dex <command>

# Type checking
bun run typecheck

# Linting
bun run lint
bun run lint:fix

# Run tests
bun run test:all

# Reset database (for testing)
bun run reset
```

## How It Works

1. **Sync** reads conversation data from source applications (e.g., Cursor's SQLite database)
2. Data is normalized into a unified schema and stored in LanceDB
3. **Search** combines full-text search (BM25) with semantic vector search for best results
4. Results are presented in an interactive terminal UI built with Ink

## Configuration

### Settings

```bash
# Open interactive settings
dex config
```

The config menu lets you:
- Connect API keys for title generation (uses Claude or Codex to generate titles for untitled conversations)
- View credential status

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DEX_DATA_DIR` | Custom data directory | `~/.dex` |

Example:
```bash
DEX_DATA_DIR=~/my-dex-data dex sync
```

## Uninstall

To completely remove agentdex and all indexed data:

```bash
rm -rf ~/.dex
```

If using a custom data directory, remove that instead.

## Privacy

agentdex is fully local:
- All data stays on your machine in `~/.dex/`
- No network requests (except downloading the embedding model and llama-server binary once)
- No telemetry or analytics

## License

MIT

