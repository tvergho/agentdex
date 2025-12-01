/**
 * Interactive Codex (ChatGPT) authentication via OpenCode CLI
 *
 * Launches the bundled OpenCode CLI to handle OAuth flow.
 * Opens browser for ChatGPT login, saves credentials to shared auth.json.
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get the absolute path to the opencode binary in node_modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OPENCODE_BIN = join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'opencode');

/**
 * Launch interactive OpenCode auth login for OpenAI/ChatGPT
 *
 * This opens a browser for the OAuth flow and saves credentials
 * to ~/.local/share/opencode/auth.json (shared with OpenCode).
 *
 * @returns true if auth succeeded, false otherwise
 */
export async function runCodexAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    // Use opencode auth login --provider openai to authenticate
    // The --provider flag tells it to use OpenAI instead of Anthropic
    const proc = spawn(OPENCODE_BIN, ['auth', 'login', '--provider', 'openai'], {
      stdio: 'inherit', // Interactive - shows browser prompt in terminal
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', (err) => {
      console.error('Failed to run OpenCode auth:', err.message);
      resolve(false);
    });
  });
}

/**
 * Log out from Codex (removes OpenAI credentials from shared auth)
 *
 * @returns true if logout succeeded
 */
export async function runCodexLogout(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(OPENCODE_BIN, ['auth', 'logout', '--provider', 'openai'], {
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

