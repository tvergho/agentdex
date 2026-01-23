# CLAUDE.md - agentdex Project Guide

## Project Overview

agentdex is a local search engine for coding agent conversations. It indexes conversations from various AI coding tools (Cursor, Claude Code, Codex, OpenCode) into a local LanceDB database with full-text and semantic search.

## Tech Stack

- **Runtime**: Bun (preferred) or Node.js with tsx
- **Language**: TypeScript (strict mode)
- **Database**: LanceDB (embedded vector/FTS database)
- **UI**: Ink (React for CLI) + fullscreen-ink for terminal UI
- **Schema Validation**: Zod
- **MCP**: Model Context Protocol server for AI agent integration

## Project Structure

```
src/
├── adapters/           # Source-specific data extraction
│   ├── cursor/         # Cursor IDE adapter
│   ├── claude-code/    # Claude Code CLI adapter
│   ├── codex/          # Codex CLI adapter
│   ├── opencode/       # OpenCode CLI adapter
│   ├── types.ts        # Adapter interface definitions
│   └── index.ts        # Adapter registry
├── cli/
│   ├── commands/       # CLI command implementations
│   │   ├── unified.tsx # Home screen with tabs (default `dex` command)
│   │   ├── search.tsx  # Direct search with 4-level navigation
│   │   ├── list.tsx    # List conversations (non-TTY fallback)
│   │   ├── show.tsx    # Show single conversation
│   │   ├── sync.tsx    # Sync data from sources
│   │   ├── status.tsx  # Embedding progress status
│   │   ├── stats.tsx   # Analytics dashboard with 6 tabs
│   │   ├── config.tsx  # Provider settings TUI
│   │   ├── chat.ts     # AI chat with dex integration
│   │   ├── review.ts   # Git commit correlation
│   │   ├── review-export.ts  # Review markdown export
│   │   ├── review-web/ # Review HTML viewer
│   │   ├── export.ts   # Export as markdown files
│   │   ├── backup.ts   # Full database backup (JSON)
│   │   ├── import.ts   # Import from backup
│   │   ├── billing.ts  # Cursor billing commands
│   │   └── embed.ts    # Background embedding worker
│   ├── components/     # Reusable UI components
│   │   ├── ConversationView.tsx
│   │   ├── MessageDetailView.tsx
│   │   ├── MatchesView.tsx
│   │   ├── ResultRow.tsx
│   │   ├── HighlightedText.tsx
│   │   ├── ActivityHeatmap.tsx
│   │   ├── ExportActionMenu.tsx
│   │   ├── StatusToast.tsx
│   │   ├── SourceTokenTrend.tsx
│   │   ├── FullSourceTimeline.tsx
│   │   ├── MetricCard.tsx
│   │   ├── Sparkline.tsx
│   │   ├── ProgressBar.tsx
│   │   └── SourceBadge.tsx
│   └── hooks/          # Reusable React hooks
│       ├── useNavigation.ts  # 4-level drill-down state machine
│       └── useExport.ts      # Export modal state
├── db/
│   ├── index.ts        # LanceDB connection & table setup
│   ├── repository.ts   # Data access layer
│   └── analytics.ts    # Stats/analytics queries (supports TokenView)
├── mcp/
│   └── server.ts       # MCP server with stats/list/search/get tools
├── schema/
│   └── index.ts        # Zod schemas for all entities
├── utils/
│   ├── config.ts       # Configuration paths
│   ├── format.ts       # Shared formatting utilities
│   ├── export.ts       # Export utilities (markdown generation)
│   └── platform.ts     # OS detection
├── embeddings/         # Vector embedding generation
│   ├── index.ts        # Embedding orchestration
│   └── llama-server.ts # llama-server integration
└── index.ts            # CLI entry point (Commander.js)
```

## All Commands

```bash
# Core commands
dex                             # Home screen with tabs (Search, Recent, Stats)
dex sync                        # Index conversations from all sources
dex sync --force                # Force full re-sync
dex search "query"              # Search conversations by content
dex search --file auth.ts       # Search by file path
dex search "bug" --file auth.ts # Combined content + file search
dex list                        # List all conversations
dex show <id>                   # Show a specific conversation
dex status                      # Check embedding progress
dex stats                       # Interactive analytics dashboard
dex stats --summary             # Quick non-interactive summary
dex config                      # Provider settings TUI

# Export/backup
dex export                      # Export conversations as markdown
dex backup                      # Full database backup (JSON)
dex import <file>               # Import from backup

# Advanced features
dex chat                        # AI chat with dex integration
dex chat -p                     # Print mode (stdout)
dex review                      # Correlate commits with conversations
dex review --export ./out       # Export review as HTML viewer
dex billing sync                # Fetch Cursor billing from API
dex billing import <csv>        # Import Cursor billing CSV
dex billing stats               # View billing analytics

# Hidden/internal
dex serve                       # Start MCP server (usually auto-launched)
dex embed                       # Background embedding worker
dex embed --benchmark           # Benchmark batch sizes
dex count --messages            # Count messages (internal)

# Development
bun run typecheck               # Run TypeScript type checking
bun run lint                    # Run ESLint
bun run lint:fix                # Auto-fix lint issues
bun run reset                   # Reset database and embedding config
```

## Architecture Patterns

### Adapter Pattern
Each source (Cursor, Claude Code, etc.) implements `SourceAdapter`:
- `detect()` - Check if source is available on this machine
- `discover()` - Find all workspaces/instances
- `extract()` - Pull raw conversation data
- `normalize()` - Convert to unified schema

### Database Schema
- **conversations** - Top-level metadata (title, source, timestamps, project, tokens, git info)
- **messages** - Individual messages with FTS index and vector embeddings
- **tool_calls** - Tool invocations (file edits, commands)
- **conversation_files** - Files associated with conversations (role: context/edited/mentioned)
- **message_files** - Files associated with specific messages
- **file_edits** - Individual file edit records with lines added/removed
- **billing_events** - Cursor billing data (tokens, cost, model)
- **sync_state** - Incremental sync tracking

### Token Counting Modes
Two views for token data (toggle with `v` in stats):
- **SUM (Billing)**: Total across all API calls - matches billing methodology
- **PEAK (Sum-of-peaks)**: Peak context from each segment between compactions

### UI Navigation (Search)
Four-level navigation pattern:
1. **List view** - Search results with j/k navigation, Enter to expand
2. **Matches view** - All matches in a conversation, Enter to view full conversation
3. **Conversation view** - Full conversation with highlighted message, Enter for full message
4. **Message view** - Single message with full content, j/k to scroll, n/p for next/prev

## TUI Architecture

### Command Entry Points

| Command | File | Description |
|---------|------|-------------|
| `dex` (default) | `unified.tsx` | Home screen with tabs: Search, Recent, Stats |
| `dex search <query>` | `search.tsx` | Direct search with 4-level drill-down |
| `dex list` | `list.tsx` | Simple conversation list (non-TTY fallback) |
| `dex show <id>` | `show.tsx` | Single conversation viewer |
| `dex stats` | `stats.tsx` | Analytics dashboard with 6 tabs |
| `dex config` | `config.tsx` | Provider settings and credentials |
| `dex status` | `status.tsx` | Embedding progress display |

### Stats Dashboard Tabs

1. **Overview** - Total counts, date range, top sources/projects
2. **Tokens** - Daily trends, source breakdown, cache efficiency, billing
3. **Activity** - Hourly/daily/weekly heatmaps, streaks
4. **Projects** - Project breakdown with token bars
5. **Files** - File types, edit counts
6. **Timeline** - Full source timeline visualization

### Keyboard Shortcuts

**Global navigation:**
| Key | Action |
|-----|--------|
| `j/k` | Navigate up/down |
| `Enter` | Drill down / expand |
| `Esc` | Go back |
| `q` | Quit |
| `e` | Export menu |

**Multi-select mode:**
| Key | Action |
|-----|--------|
| `v` | Enter multi-select mode |
| `Space` | Toggle selection |
| `e` | Export selected |

**Message detail view:**
| Key | Action |
|-----|--------|
| `n/p` | Next/prev message |
| `Tab` | Enter tool output navigation |
| `Space/Enter` | Expand tool output (in tool mode) |

**Stats dashboard:**
| Key | Action |
|-----|--------|
| `1-6` | Jump to tab |
| `h/l` | Previous/next tab |
| `v` | Toggle peak/sum token view |

**Show command:**
| Key | Action |
|-----|--------|
| `g` | Jump to top |
| `G` | Jump to bottom |

### Shared Components

| Component | Purpose |
|-----------|---------|
| `ConversationView` | Display full conversation with messages |
| `MessageDetailView` | Single message with tool output navigation |
| `MatchesView` | Search matches within a conversation |
| `ResultRow` | Conversation list item with metadata |
| `HighlightedText` | Query term highlighting |
| `ActivityHeatmap` | Git-style contribution heatmap |
| `SourceTokenTrend` | Token usage trends by source |
| `FullSourceTimeline` | Detailed timeline visualization |
| `ExportActionMenu` | Export options overlay |
| `StatusToast` | Temporary success/error messages |
| `MetricCard` | Analytics metric display |
| `ProgressBar` | Linear progress visualization |
| `Sparkline` | Small trend line |

## MCP Server

The MCP server (`src/mcp/server.ts`) exposes tools for AI agent integration:

| Tool | Description |
|------|-------------|
| `stats` | Get overview statistics (counts, date range, sources) |
| `list` | Browse conversations with filters (project, source, branch, date) |
| `search` | Hybrid search (FTS + semantic) with file filtering |
| `get` | Retrieve conversation content in various formats |

All tools support `branch` filtering for git-aware queries.

## Search Capabilities

### Search Modes
1. **Hybrid Search** (default) - FTS + semantic vector search with RRF reranking
2. **Full-Text Search** (fallback) - LanceDB FTS when semantic unavailable
3. **Substring Matching** (last resort) - Client-side when FTS corrupted

### Search Filters
- `--file <pattern>` - File path involvement (substring match)
- `--source cursor|claude-code|codex|opencode` - Source filter
- `--model <model>` - AI model filter
- `--project <path>` - Project/workspace filter
- `--from/--to <date>` - Date range
- `--offset/--limit` - Pagination

### File Search Scoring
Results ranked by file role:
- Edited: 1.0
- Context: 0.5
- Mentioned: 0.3

## Git Integration

### Tracked Per Conversation
- `gitBranch` - Branch name at time of conversation
- `gitCommitHash` - Commit hash
- `gitRepositoryUrl` - Repository URL

### Review Command (`dex review`)
Correlates git commits with AI conversations:
- Extracts commit diff content
- Matches against conversation file edits
- Computes line-by-line attribution
- Confidence scoring (high/medium/low)
- Coverage percentages per commit

## Coding Conventions

### TypeScript
- Use strict null checks - always handle `undefined`/`null` cases
- Prefer `const` assertions and explicit types for better inference
- Use Zod schemas as source of truth, derive types with `z.infer<>`

### Database
- Use deterministic IDs (SHA256 hash) to prevent duplicates on re-sync
- Always delete existing data before re-inserting (clean sync approach)
- Rebuild FTS index after bulk data insertion with `replace: true`

### React/Ink Components
- Use `fullscreen-ink` for proper terminal UI (prevents scroll issues)
- Handle both TTY (interactive) and non-TTY (piped) modes
- Keep state minimal - derive computed values with `useMemo`
- Wrap all `repeat()` calls with `Math.max(0, ...)` to prevent negative values

### Error Handling
- Parse JSON safely with try/catch and null checks
- Skip invalid data rather than throwing during sync
- Show user-friendly errors in UI, log details for debugging

## LanceDB Specifics

- FTS index must be created/rebuilt AFTER data is inserted
- Use `replace: true` when recreating indexes
- Column names use snake_case for SQL compatibility
- No `dropIndex` method - use `createIndex` with `replace: true`

### Schema Changes (Adding New Columns)

LanceDB schema is defined by the first row inserted. To add new columns:

1. **Update `src/schema/index.ts`** - Add fields to the Zod schema
2. **Update adapter parsers** - Extract new data from source
3. **Update adapter normalizers** - Map extracted data to schema
4. **Update `src/db/index.ts`** - Add columns to placeholder rows in `ensureTables()`
5. **Update `src/db/repository.ts`** - Add columns to insert/upsert and return mappings
6. **Delete database and re-sync** - `rm -rf ~/.dex/lancedb && bun run dev sync --force`

## Embeddings

Background embedding generation for semantic search:
- **Model**: `Qwen3-Embedding-0.6B` (1024 dimensions) via llama-server
- **GPU acceleration**: Metal on macOS (`--n-gpu-layers 99`), flash attention enabled
- **Auto-benchmark**: On first run, tests batch sizes to find optimal config
- **Process lock**: Prevents duplicate embedding processes
- **Progress tracking**: `~/.dex/embedding-progress.json`
- **Config**: `~/.dex/embed-config.json`

### FTS Index Recovery
Automatic detection and repair of "fragment not found" errors:
1. Detect corruption
2. Rebuild FTS index
3. Retry query
4. Fall back to substring matching if all else fails

## Data Extraction

### Cursor
- Location: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- Format: SQLite database
- Key format: `composerData:{composerId}`
- Also syncs billing events from `billing_events` table

### Claude Code
- Location: `~/.claude/projects/{sanitized-path}/*.jsonl`
- Format: JSONL files
- Entry types: `user`, `assistant`, `summary`, `file-history-snapshot`
- Deduplication by `messageId:requestId` to avoid streaming chunk duplicates

### Codex CLI
- Location: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- Format: JSONL files
- Entry types: `session_meta`, `response_item`, `event_msg`, `turn_context`

### OpenCode
- Location: `~/.local/share/opencode/storage/`
- Format: Hierarchical JSON structure
- Structure: `project/` → `session/` → `message/` → `part/`

## Testing

**366+ tests** covering adapters, database, utilities, schema, and CLI commands.

```bash
bun run test:all            # Run all tests (Bun + Node.js Cursor tests)
bun test                    # Run Bun tests only
bun run test:cursor         # Run Cursor adapter tests (Node.js)
bun test --watch            # Watch mode
bun test --coverage         # With coverage report
```

### Test Structure

```
tests/
├── fixtures/               # Test data factories
├── helpers/                # Shared test utilities
│   ├── db.ts               # TestDatabase for isolated DB tests
│   ├── temp.ts             # Temporary directory management
│   ├── cli.ts              # Console/process mocking
│   ├── mocks.ts            # Adapter and embedding mocks
│   └── assertions.ts       # Custom file assertions
├── unit/                   # Pure function tests
└── integration/            # Tests with I/O
```

## Platform Notes

### macOS
- The `timeout` command is not available by default
- Use the Bash tool's `timeout` parameter instead
- Example: Use `Bash(command: "bun ...", timeout: 10000)` instead of `timeout 10 bun ...`

## Git Commits

- Do NOT include AI attribution in commit messages
- Write clear, conventional commit messages focused on the actual changes
- Example: `feat: add project context to search results`
