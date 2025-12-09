/**
 * Chat command - launches OpenCode TUI attached to a dex-managed server
 *
 * Checks for credentials in dex's isolated storage first, then offers
 * to import from external sources or authenticate fresh.
 * Everything is isolated from global OpenCode state.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import {
  startServer,
  type OpenCodeServerState,
} from '../../providers/claude-code/client.js';
import { getOpencodeBinPath } from '../../utils/paths.js';
import {
  hasDexCredentials,
  getDefaultProvider,
  getDexCredentials,
  hasExternalCredentials,
  type ProviderId,
} from '../../providers/auth.js';
import { runChatSetup, runImportPrompt } from './chat-setup.js';
import { ensureOpenCodeConfig, PLUGIN_VERSION, OPENCODE_CODEX_CONFIG } from '../../providers/codex/setup.js';

// Isolated OpenCode directories under ~/.dex
const DEX_OPENCODE_HOME = path.join(homedir(), '.dex', 'opencode');
const DEX_XDG_CONFIG = path.join(DEX_OPENCODE_HOME, 'config');
const DEX_XDG_DATA = path.join(DEX_OPENCODE_HOME, 'data');

// OpenCode paths within isolated XDG directories
const OPENCODE_CONFIG_DIR = path.join(DEX_XDG_CONFIG, 'opencode');
const OPENCODE_MODE_DIR = path.join(OPENCODE_CONFIG_DIR, 'mode');
const OPENCODE_AUTH_FILE = path.join(DEX_XDG_DATA, 'opencode', 'auth.json');
const OPENCODE_AGENTS_MD = path.join(OPENCODE_CONFIG_DIR, 'AGENTS.md');

const DEX_AGENT_PROMPT = `You are a coding assistant with access to the user's historical coding conversations via dex tools. This gives you a powerful memory of past work, decisions, and implementations.

## Available Tools

### dex_stats
Get overview statistics: total conversations, sources, projects, date range.
Use this to understand the scope of available history before searching.

### dex_list
Browse conversations by filters (project, source, date range).
Returns conversation metadata without content. Good for:
- Finding recent conversations in a specific project
- Listing all conversations from a date range
- Getting conversation IDs for subsequent dex_get calls

### dex_search
Search conversation content with hybrid semantic + full-text search.
**Key features:**
- **adjacent_context**: Short user messages automatically include the assistant's response (and vice versa), so you see the Q&A together
- **Date filtering**: Use \`from\`/\`to\` params (YYYY-MM-DD format)
- **Project filtering**: Substring match on project path
- Returns matches with snippets and \`message_index\` for each result

### dex_get
Retrieve full conversation content. **Key options:**

**format** (choose based on need):
- \`stripped\` (default): Full content, tool outputs removed. Best for most cases.
- \`outline\`: Summary view for very long conversations. Start here to orient yourself.
- \`full\`: Includes all tool outputs. Only use when you need actual command output, file contents, etc.
- \`user_only\`: Just user messages. Useful for understanding what the user asked/wanted.

**expand** (zoom in on a specific message):
\`\`\`json
{ "expand": { "message_index": 12, "before": 2, "after": 3 } }
\`\`\`
Use this after search to see surrounding context around the \`message_index\` from search results. Much more efficient than retrieving the entire conversation.

## Recommended Workflow

### Simple queries (1-3 conversations)
1. **Search** → \`dex_search\` to find relevant conversations with snippets
2. **Expand** → \`dex_get\` with \`expand\` param to see context around the \`message_index\` from search results
3. **Full view** → If needed, \`dex_get\` with \`format: "outline"\` first, then \`format: "stripped"\` for full content

### Complex analysis (many conversations)
When the user asks questions requiring analysis across many conversations (patterns, trends, "how do I usually...", "find all cases of..."):

1. **Scope first** → Use \`dex_stats\` or \`dex_list\` to understand how much data exists
2. **Plan the approach** → If >5-10 conversations are relevant, consider:
   - Breaking the analysis into focused sub-queries
   - Searching for specific aspects sequentially
   - Summarizing findings as you go
3. **Iterate** → Search, retrieve key portions, refine your understanding, search again with new terms
4. **Synthesize** → Compile findings into a coherent answer

For very large-scale analysis, delegate to subagents with specific focused tasks rather than trying to process everything in one pass.

## When to Use dex Tools

Use these tools proactively when:
- The user asks about previous work ("how did I implement X before?", "what was that bug fix?")
- You need context about the codebase from past conversations
- The user references something they discussed with another AI assistant
- You want to find relevant examples or patterns from past sessions
- The user asks "have I done this before?" or "what's my usual approach to..."
- You're working on code and want to check if similar problems were solved before

## Example Mappings

| User asks... | Approach |
|--------------|----------|
| "What did I work on yesterday?" | \`dex_search\` with \`from\`/\`to\` dates, or \`dex_list\` with date filter |
| "How did I fix that auth bug?" | \`dex_search\` for "auth bug fix", then \`dex_get\` with \`expand\` around the match |
| "Summarize that long conversation" | \`dex_get\` with \`format: "outline"\` |
| "What commands did I run to set up the DB?" | \`dex_search\`, then \`dex_get\` with \`format: "full"\` to see actual tool outputs |
| "How do I usually structure React components?" | \`dex_search\` for "react component", analyze multiple results, synthesize patterns |
| "Find all the times I dealt with async errors" | \`dex_search\`, iterate through results, compile summary |

## Tips

- Search results include \`message_index\` - use this with \`expand\` to efficiently retrieve just the relevant portion
- When a conversation is very long, start with \`outline\` format to orient yourself
- Filter by \`project\` when working in a specific codebase to reduce noise
- Combine multiple searches with different terms to triangulate on relevant content
- If initial search doesn't find what you need, try synonyms or related terms
`;

/**
 * Ensure isolated config is set up with ALL available provider credentials
 * This makes all connected providers available in OpenCode, not just the default
 */
function ensureIsolatedConfig(): void {
  // Create all directories
  fs.mkdirSync(OPENCODE_MODE_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(OPENCODE_AUTH_FILE), { recursive: true });

  // Write AGENTS.md (global instructions that apply to ALL agents/modes)
  fs.writeFileSync(OPENCODE_AGENTS_MD, DEX_AGENT_PROMPT);

  // Write custom dex mode (shows up in mode selector via Tab)
  const dexModeMd = `---
description: Coding assistant with conversation history search
---

${DEX_AGENT_PROMPT}
`;
  fs.writeFileSync(path.join(OPENCODE_MODE_DIR, 'dex.md'), dexModeMd);

  // Get all available credentials
  const anthropicCreds = getDexCredentials('anthropic');
  const openaiCreds = getDexCredentials('openai');

  // Build OpenCode config
  const configPath = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: Record<string, any> = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      dex: {
        type: 'local',
        command: ['dex', 'serve'],
        enabled: true,
        timeout: 10000,
      },
    },
  };

  // Add Codex plugin config if OpenAI credentials exist
  // This makes GPT models available regardless of default provider
  if (openaiCreds) {
    config.plugin = [`opencode-openai-codex-auth@${PLUGIN_VERSION}`];
    config.provider = OPENCODE_CODEX_CONFIG.provider;
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Build auth data with ALL available credentials
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authData: Record<string, any> = {};

  if (anthropicCreds) {
    authData.anthropic = {
      type: 'oauth',
      access: anthropicCreds.access,
      refresh: anthropicCreds.refresh,
      expires: anthropicCreds.expires,
    };
  }

  if (openaiCreds) {
    authData.openai = {
      type: 'oauth',
      access: openaiCreds.access,
      refresh: openaiCreds.refresh,
      expires: openaiCreds.expires,
    };
  }

  fs.writeFileSync(OPENCODE_AUTH_FILE, JSON.stringify(authData, null, 2));
}

export async function chatCommand(): Promise<void> {
  // Check dex's isolated credentials first (authoritative source)
  if (!hasDexCredentials()) {
    // No dex credentials - check if we can import from external sources
    if (hasExternalCredentials()) {
      // Show import prompt
      console.log('Found existing credentials...');
      const imported = await runImportPrompt();
      if (!imported) {
        // User chose to set up fresh or import failed
        const result = await runChatSetup();
        if (result.cancelled) {
          console.log('Setup cancelled. Run `dex chat` again or use `dex config` to set up.');
          process.exit(0);
        }
      }
    } else {
      // No credentials anywhere - show full provider selection
      const result = await runChatSetup();
      if (result.cancelled) {
        console.log('Setup cancelled. Run `dex chat` again or use `dex config` to set up.');
        process.exit(0);
      }
    }
  }

  // Verify we have at least one provider configured
  const provider = getDefaultProvider();
  if (!provider) {
    console.error('No provider configured. Run `dex config` to set up.');
    process.exit(1);
  }

  // Set up isolated config with ALL available credentials
  // This makes all connected providers available in OpenCode
  ensureIsolatedConfig();

  console.log('Starting dex chat server...');

  // Start OpenCode server with isolated XDG directories
  let serverState: OpenCodeServerState;
  try {
    serverState = await startServer({
      xdgConfigHome: DEX_XDG_CONFIG,
      xdgDataHome: DEX_XDG_DATA,
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }

  console.log(`Server ready at ${serverState.url}`);
  console.log('Attaching TUI...\n');

  // Attach TUI with same isolated XDG directories
  const opencodePath = getOpencodeBinPath();
  const args = ['attach', serverState.url];

  const child = spawn(opencodePath, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: DEX_XDG_CONFIG,
      XDG_DATA_HOME: DEX_XDG_DATA,
    },
  });

  // Handle exit - clean up server
  child.on('close', (code) => {
    serverState.process.kill();
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    serverState.process.kill();
    console.error('Failed to attach TUI:', err);
    process.exit(1);
  });

  // Handle signals to clean up server
  const cleanup = () => {
    serverState.process.kill();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
