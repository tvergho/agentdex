# agentdex

**Local search engine for your AI coding conversations.**

[agentdex.sh](https://agentdex.sh)

agentdex indexes conversations from AI coding assistants (Cursor, Claude Code, Codex, OpenCode) into a local database with full-text and semantic search. Find that conversation where you debugged that tricky auth issue, correlate git commits to AI sessions, or analyze your coding patterns.

## Features

- **Full-text search** across all your AI conversations
- **Semantic search** - finds related content even without exact keyword matches
- **File path search** - find conversations by file (e.g., `--file auth.ts`)
- **Interactive TUI** with vim-style navigation (j/k, Enter, Esc)
- **Project context** - see which files were discussed and edited
- **Incremental sync** - only indexes new conversations
- **Analytics dashboard** - token usage, activity heatmaps, project stats, billing
- **Export & backup** - markdown exports and JSON backups for portability
- **Git correlation** - `dex review` maps commits to AI conversations
- **MCP server** - integrate with AI agents via Model Context Protocol
- **AI chat** - `dex chat` launches an AI assistant with access to your conversation history
- **Fully local** - your data never leaves your machine

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

# Launch the home screen (search, recent, stats tabs)
dex

# Search for something
dex search "authentication middleware"

# View analytics
dex stats
```

## Commands

### `dex` (Home Screen)

Run `dex` with no arguments to open the interactive home screen with tabs:
- **Search** - Full-text and semantic search
- **Recent** - Browse recent conversations
- **Stats** - Analytics overview

### `dex search <query>`

Search conversations with powerful filtering:

```bash
# Search by content
dex search "your query"

# Search by file path
dex search --file auth.ts
dex search --file src/components

# Combined: content + file filter
dex search "authentication bug" --file auth.ts

# Filter by source, model, project, or date
dex search "bug" --source cursor
dex search "refactor" --model opus
dex search "fix" --project myapp
dex search "deploy" --from 2025-01-01 --to 2025-01-31
```

**Navigation (4 levels of detail):**
1. **Results list** - Matching conversations with snippets
2. **Matches view** - All matches within a conversation
3. **Conversation view** - Full conversation with messages
4. **Message view** - Complete message content with tool outputs

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `j/k` | Navigate up/down |
| `Enter` | Drill down / expand |
| `Esc` | Go back |
| `q` | Quit |
| `v` | Multi-select mode |
| `Space` | Toggle selection (in multi-select) |
| `e` | Export selected |
| `n/p` | Next/prev message (in message view) |
| `Tab` | Navigate tool outputs (in message view) |

### `dex list`

List conversations with metadata:

```bash
dex list                    # Recent conversations
dex list --limit 50         # More results
dex list --source cursor    # Filter by source
dex list -j                 # JSON output
```

### `dex show <id>`

View a complete conversation:

```bash
dex show <conversation-id>
dex show <id> --format stripped   # Remove tool outputs
dex show <id> --format user_only  # Only user messages
dex show <id> -j                  # JSON output
```

### `dex sync`

Index conversations from all detected sources:

```bash
dex sync           # Incremental sync (new conversations only)
dex sync --force   # Full re-sync
```

### `dex stats`

Interactive analytics dashboard with tabs:
- **Overview** - Total conversations, messages, tokens
- **Tokens** - Usage by source/model, cache efficiency
- **Activity** - Heatmaps, streaks, hourly/weekly patterns
- **Projects** - Breakdown by project/workspace
- **Files** - Most edited file types
- **Timeline** - Token usage over time by source

```bash
dex stats              # Interactive dashboard
dex stats --summary    # Quick non-interactive summary
dex stats --period 90  # Last 90 days
dex stats -j           # JSON output
```

Press `v` in the dashboard to toggle between **billing** (sum) and **peak** token views.

### `dex export`

Export conversations as markdown:

```bash
dex export                          # All to ./agentdex-export
dex export -o ~/exports             # Custom directory
dex export --source cursor          # Filter by source
dex export --project myapp          # Filter by project
dex export --from 2025-01-01        # Date range
dex export --id <id>                # Single conversation
```

### `dex backup` / `dex import`

Full database backup for migration:

```bash
dex backup                          # Creates dex-backup-TIMESTAMP.json
dex backup -o my-backup.json        # Custom filename

dex import backup.json              # Import on another machine
dex import backup.json --dry-run    # Preview first
dex import backup.json --force      # Overwrite existing
```

### `dex status`

Check semantic search embedding progress:

```bash
dex status
```

Shows model download status, processing throughput, and completion percentage.

### `dex config`

Interactive settings for providers and features:

```bash
dex config
```

- Connect API keys for title generation
- View credential status
- Configure enrichment settings

### `dex chat`

Launch an AI chat with access to your conversation history:

```bash
dex chat                # Interactive TUI
dex chat -p             # Print mode (stdout)
dex chat "query"        # Start with a query
```

Uses OpenCode with the dex MCP server for conversation search.

### `dex review [branch]`

Correlate git commits with AI conversations:

```bash
dex review                      # Review current branch vs main
dex review feature-branch       # Specific branch
dex review -b develop           # Custom base branch
dex review --export ./review    # Export as markdown + HTML viewer
```

Shows which conversations contributed to which commits with confidence scoring.

### `dex billing`

Cursor billing data (requires Cursor API credentials):

```bash
dex billing sync              # Fetch from Cursor API
dex billing import data.csv   # Import from CSV
dex billing stats             # View billing analytics
```

## MCP Server

agentdex exposes an MCP (Model Context Protocol) server for AI agent integration:

```bash
dex serve   # Start MCP server (usually auto-launched)
```

**Available tools:**
- `stats` - Get overview statistics
- `list` - Browse conversations with filters
- `search` - Search by content/file with hybrid search
- `get` - Retrieve full conversation content

Configure in your MCP client to give AI agents access to your coding history.

## Data Storage

All data is stored locally in `~/.dex/`:

```
~/.dex/
├── lancedb/                  # Main database
├── models/                   # Embedding model (downloaded on first use)
├── config.json               # Provider credentials
├── embed-config.json         # Auto-benchmarked settings
└── embedding-progress.json   # Embedding state
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DEX_DATA_DIR` | Custom data directory | `~/.dex` |

## Development

```bash
bun run dev <command>   # Run in development
bun run typecheck       # Type checking
bun run lint            # Linting
bun run test:all        # All tests
bun run reset           # Reset database
```

## Privacy

agentdex is fully local:
- All data stays on your machine in `~/.dex/`
- No network requests except downloading the embedding model once
- No telemetry or analytics

## License

MIT
