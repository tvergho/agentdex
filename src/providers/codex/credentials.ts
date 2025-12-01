/**
 * Cross-platform Codex (ChatGPT) credential reader
 *
 * Reads OpenAI OAuth credentials from OpenCode's shared auth storage.
 *
 * Storage location:
 * - Linux: $XDG_DATA_HOME/opencode/auth.json or ~/.local/share/opencode/auth.json
 * - macOS: ~/.local/share/opencode/auth.json
 * - Windows: %LOCALAPPDATA%/opencode/auth.json
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface CodexCredentialStatus {
  isAuthenticated: boolean;
  subscriptionType?: string; // 'plus', 'pro', etc.
  error?: string;
}

interface RawOpenCodeAuth {
  openai?: {
    type?: string;
    access?: string;
    refresh?: string;
    expires?: number;
  };
}

/**
 * Get OpenCode auth.json file path (cross-platform)
 */
function getAuthFilePath(): string {
  const platform = process.platform;

  if (platform === 'win32') {
    // Windows: %LOCALAPPDATA%/opencode/auth.json
    const localAppData = process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'opencode', 'auth.json');
  }

  // Linux/macOS: $XDG_DATA_HOME/opencode/auth.json or ~/.local/share/opencode/auth.json
  const dataHome = process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'auth.json');
}

/**
 * Read raw auth data from OpenCode's auth.json
 */
function readAuthFile(): RawOpenCodeAuth | null {
  const filePath = getAuthFilePath();

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as RawOpenCodeAuth;
  } catch {
    return null;
  }
}

/**
 * Get Codex (OpenAI) credentials from OpenCode's shared storage
 */
export function getCodexCredentials(): CodexCredentials | null {
  const raw = readAuthFile();

  if (!raw?.openai) {
    return null;
  }

  const oauth = raw.openai;

  // Validate required fields
  if (!oauth.access || !oauth.refresh || !oauth.expires) {
    return null;
  }

  return {
    accessToken: oauth.access,
    refreshToken: oauth.refresh,
    expiresAt: oauth.expires,
  };
}

/**
 * Get credential status (for UI display)
 */
export function getCodexCredentialStatus(): CodexCredentialStatus {
  try {
    const raw = readAuthFile();

    if (!raw?.openai) {
      return {
        isAuthenticated: false,
        error: 'No Codex credentials found. Click Connect to authenticate via ChatGPT.',
      };
    }

    const oauth = raw.openai;

    // Check if token is expired
    if (oauth.expires && oauth.expires < Date.now()) {
      return {
        isAuthenticated: false,
        error: 'Codex credentials have expired. Please re-authenticate.',
      };
    }

    // Validate required fields
    if (!oauth.access || !oauth.refresh) {
      return {
        isAuthenticated: false,
        error: 'Incomplete Codex credentials. Please re-authenticate.',
      };
    }

    return {
      isAuthenticated: true,
      // OpenAI doesn't expose subscription type in the OAuth response
      // Could be derived from API calls later if needed
    };
  } catch (error) {
    return {
      isAuthenticated: false,
      error: error instanceof Error ? error.message : 'Failed to read credentials',
    };
  }
}

