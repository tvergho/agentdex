# dex review - Branch Review Command

The `dex review` command correlates git commits with AI coding conversations, showing which conversations produced the code on a branch. It generates a GitHub-style diff view with AI-attributed lines highlighted.

## Usage

```bash
# Basic usage - review current branch
dex review

# Review a specific branch
dex review <branch-name>

# Specify base branch (default: main)
dex review <branch> --base dev

# Review in a different repo
dex review <branch> --repo /path/to/repo --base dev

# Export to HTML
dex review <branch> --base dev --export ./output

# JSON output
dex review <branch> --json
```

## Output

### Terminal Output

```
📂 Branch: tyler/add-action-tracking
   Base: dev
   37 commits

────────────────────────────────────────────────────────────

Conversations that produced this work:

🟢 "Implementing agent action tracking" (OpenCode)
   2025-12-31 · 188 messages · 249 file edits
   Commits: 85187f8, 811ad45, 401e75e +14 more
   code match · 31 files
   ID: 9f478365d4d2bf65b3ea8c32002e8f94

...

────────────────────────────────────────────────────────────

Branch diff coverage (PR diff):

   ████░░░░░░ 45% (531/1176 lines)

   45% of PR diff attributable to AI conversations
```

### HTML Export

The `--export` flag generates a full HTML viewer:

```
output/
├── index.html          # Interactive web viewer
├── README.md           # Markdown summary
├── data.json           # Structured data
├── commits/            # Per-commit markdown files
└── conversations/      # Conversation transcripts
```

The HTML viewer includes:
- **Dashboard** - Summary stats, recent commits, conversations
- **Files Changed** - GitHub-style side-by-side diff with AI line highlighting
- **Commits** - Per-commit coverage breakdown
- **Conversations** - Full conversation transcripts

## How It Works

### 1. Branch Diff Calculation

The command uses the **cumulative branch diff** (what would show in a GitHub PR), not the sum of individual commit diffs:

```bash
# What we calculate
git diff $(git merge-base origin/dev branch) branch
```

This is important because:
- Individual commits may include merged PRs from other developers
- The cumulative diff represents the actual net change
- Coverage percentage reflects "what % of your PR came from AI"

### 2. Conversation Matching

For each conversation in the database:

1. **File Matching**: Find conversations that edited files changed in commits
2. **Time Filtering**: Only consider conversations within a time window (12 hours before to 7 days after commit)
3. **Code Matching**: Compare added lines in commits against:
   - File edit content stored in the database (`newContent` field)
   - Code blocks in assistant messages

### 3. Line Attribution

For each added line in the branch diff:
1. Trim and normalize the line
2. Check if it exists in any conversation's code output
3. Use substring matching (either direction) to handle minor variations

### 4. Coverage Calculation

```
coverage = matched_lines / total_added_lines_in_branch_diff × 100
```

Where:
- `matched_lines` = Lines that appear in AI conversation outputs
- `total_added_lines` = All non-trivial added lines in the branch diff

## Algorithm Details

### Matching Score

Each conversation-commit match gets a score based on:

| Factor | Weight | Description |
|--------|--------|-------------|
| File Score | 0.5-1.5 | Specific files: 0.5 each (max 1.5), Generic files: 0.1 each (max 0.3) |
| Time Score | 0.3-1.0 | Based on hours between conversation and commit |
| Code Score | 1.0 | Binary: does code match exist? |
| Title Score | 0-0.4 | Keyword similarity between conversation title and commit messages |

Confidence levels:
- **High** (🟢): Score ≥ 2.5
- **Medium** (🟡): Score ≥ 1.5
- **Low** (⚪): Score < 1.5

### Time Window

```
Commit Time                    Conversation Time
    |                              |
    |<---- 12h before ------------>|<---- 7 days after ---->
    |     (allowed)                |      (allowed)
```

### Generic Files (Lower Weight)

These files get reduced matching weight because they're commonly touched:
- `types.ts`, `index.ts`, `config.ts`
- `constants.ts`, `utils.ts`, `helpers.ts`
- `package.json`, `tsconfig.json`

## Worktree Support

The command handles git worktrees correctly:

```bash
# Works with conductor-style worktrees
dex review branch --repo ~/project/.conductor/feature

# Works with standard worktrees
dex review branch --repo ~/project/.worktrees/feature
```

The repo name is extracted from the parent directory, not the worktree name.

## Unattributed Lines

Lines that don't match AI conversations may be:

1. **Not indexed** - Conversations from sessions not yet synced to dex
2. **Manual code** - Written directly by the developer
3. **Different AI tool** - Written with a tool not tracked by dex
4. **Formatting changes** - Auto-formatter rewrites (Prettier, ESLint)
5. **Trivial lines** - Imports, brackets, boilerplate

## Key Files

| File | Description |
|------|-------------|
| `src/cli/commands/review.ts` | Main command implementation |
| `src/cli/commands/review-export.ts` | Markdown and JSON export |
| `src/cli/commands/review-web/template.ts` | HTML viewer template |
| `src/git/index.ts` | Git utilities (branch diff, commits, etc.) |

## Dependencies

- `simple-git` - Git operations
- `diff2html` - GitHub-style diff rendering in HTML export
