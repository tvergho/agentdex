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

const OPENCODE_CONFIG_DIR = path.join(DEX_XDG_CONFIG, 'opencode');
const OPENCODE_AUTH_FILE = path.join(DEX_XDG_DATA, 'opencode', 'auth.json');

function ensureIsolatedConfig(): void {
  fs.mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(OPENCODE_AUTH_FILE), { recursive: true });

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

  if (openaiCreds) {
    config.plugin = [`opencode-openai-codex-auth@${PLUGIN_VERSION}`];
    config.provider = {
      ...OPENCODE_CODEX_CONFIG.provider,
      anthropic: {},
    };
  } else if (anthropicCreds) {
    config.provider = {
      anthropic: {},
    };
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

export interface ChatOptions {
  query?: string;
  print?: boolean;
}

export async function chatCommand(options: ChatOptions = {}): Promise<void> {
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

  const opencodePath = await getOpencodeBinPath();
  
  // Build args based on mode
  let args: string[];
  if (options.print && options.query) {
    // Print mode: use 'run' command for non-interactive streaming output
    console.log('Running query...\n');
    args = ['run', options.query, '--attach', serverState.url];
  } else {
    // TUI mode: use 'attach' command
    console.log('Attaching TUI...\n');
    args = ['attach', serverState.url];
    if (options.query) {
      // Pass initial prompt to auto-submit
      args.push('--prompt', options.query);
    }
  }

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
