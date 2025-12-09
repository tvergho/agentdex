/**
 * Direct Anthropic (Claude) OAuth authentication
 *
 * Implements the same OAuth 2.0 PKCE flow as Claude Code CLI.
 * Saves credentials to dex's isolated auth.json.
 */

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { generatePKCE } from '@openauthjs/openauth/pkce';

// OAuth constants (same as Claude Code CLI)
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/api/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'user:inference user:profile';

// Success HTML shown after OAuth callback
const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Authentication Successful</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fff; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #d97706; margin-bottom: 1rem; }
    p { color: #9ca3af; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authentication Successful</h1>
    <p>You can close this window and return to the terminal.</p>
  </div>
</body>
</html>`;

interface PKCEPair {
  challenge: string;
  verifier: string;
}

interface TokenResult {
  type: 'success' | 'failed';
  access?: string;
  refresh?: string;
  expires?: number;
}

interface OAuthServerInfo {
  port: number;
  close: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
}

/**
 * Generate a random state value for OAuth flow
 */
function createState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Get the platform-specific command to open a URL in browser
 */
function getBrowserOpener(): string {
  const platform = process.platform;
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'start';
  return 'xdg-open';
}

/**
 * Open a URL in the default browser
 */
function openBrowser(url: string): void {
  try {
    const opener = getBrowserOpener();
    spawn(opener, [url], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
  } catch {
    // Silently fail - user can copy URL manually
  }
}

/**
 * Start local OAuth callback server on port 1455
 */
function startOAuthServer(expectedState: string): Promise<OAuthServerInfo> {
  let receivedCode: string | null = null;

  const server: Server = createServer((req, res) => {
    try {
      const url = new URL(req.url || '', 'http://localhost');

      if (url.pathname !== '/auth/callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      if (url.searchParams.get('state') !== expectedState) {
        res.statusCode = 400;
        res.end('State mismatch - possible CSRF attack');
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.statusCode = 400;
        res.end('Missing authorization code');
        return;
      }

      receivedCode = code;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(SUCCESS_HTML);
    } catch {
      res.statusCode = 500;
      res.end('Internal error');
    }
  });

  return new Promise((resolve) => {
    server
      .listen(1455, '127.0.0.1', () => {
        resolve({
          port: 1455,
          close: () => {
            try {
              server.close();
            } catch {}
          },
          waitForCode: async () => {
            // Poll for code for up to 120 seconds (Anthropic auth can be slow)
            for (let i = 0; i < 1200; i++) {
              if (receivedCode) {
                return { code: receivedCode };
              }
              await new Promise((r) => setTimeout(r, 100));
            }
            return null;
          },
        });
      })
      .on('error', (err: NodeJS.ErrnoException) => {
        console.error(`Failed to start OAuth server on port 1455: ${err.code}`);
        resolve({
          port: 1455,
          close: () => {
            try {
              server.close();
            } catch {}
          },
          waitForCode: async () => null,
        });
      });
  });
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCode(code: string, verifier: string): Promise<TokenResult> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('Token exchange failed:', response.status, text);
      return { type: 'failed' };
    }

    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== 'number') {
      console.error('Token response missing fields');
      return { type: 'failed' };
    }

    return {
      type: 'success',
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
    };
  } catch (error) {
    console.error('Token exchange error:', error);
    return { type: 'failed' };
  }
}

/**
 * Get dex's isolated auth.json file path
 */
export function getDexAuthFilePath(): string {
  return join(homedir(), '.dex', 'opencode', 'data', 'opencode', 'auth.json');
}

/**
 * Save credentials to dex's isolated auth.json
 */
function saveCredentials(tokens: { access: string; refresh: string; expires: number }): void {
  const authPath = getDexAuthFilePath();
  const authDir = join(authPath, '..');

  // Create directory if needed
  if (!existsSync(authDir)) {
    mkdirSync(authDir, { recursive: true });
  }

  // Read existing auth file or start fresh
  let authData: Record<string, unknown> = {};
  if (existsSync(authPath)) {
    try {
      authData = JSON.parse(readFileSync(authPath, 'utf-8'));
    } catch {
      // Start fresh if corrupted
    }
  }

  // Update Anthropic credentials
  authData['anthropic'] = {
    type: 'oauth',
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
  };

  writeFileSync(authPath, JSON.stringify(authData, null, 2));
}

export interface AnthropicAuthResult {
  success: boolean;
  authUrl?: string;
}

/**
 * Run the full Anthropic OAuth flow
 *
 * 1. Generate PKCE challenge
 * 2. Build authorization URL
 * 3. Start local callback server
 * 4. Open browser for login
 * 5. Wait for callback with code
 * 6. Exchange code for tokens
 * 7. Save to dex's isolated auth.json
 *
 * @returns true if auth succeeded, false otherwise
 */
export async function runAnthropicAuth(): Promise<boolean> {
  try {
    // Generate PKCE challenge
    const pkce = (await generatePKCE()) as PKCEPair;
    const state = createState();

    // Build authorization URL
    const authUrl = new URL(AUTHORIZE_URL);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('scope', SCOPE);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);

    // Start local server for callback
    const server = await startOAuthServer(state);

    // Open browser
    console.log('\nOpening browser for Claude login...');
    console.log(`If browser doesn't open, visit: ${authUrl.toString()}\n`);
    openBrowser(authUrl.toString());

    // Wait for callback
    const result = await server.waitForCode();
    server.close();

    if (!result) {
      console.error('Authentication timed out or was cancelled');
      return false;
    }

    // Exchange code for tokens
    const tokens = await exchangeCode(result.code, pkce.verifier);

    if (tokens.type !== 'success' || !tokens.access || !tokens.refresh || !tokens.expires) {
      console.error('Failed to get tokens');
      return false;
    }

    // Save credentials
    saveCredentials({
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
    });

    console.log('Authentication successful!');
    return true;
  } catch (error) {
    console.error('Authentication error:', error);
    return false;
  }
}

/**
 * Build the Anthropic OAuth URL without starting the flow
 * Useful for displaying in UI
 */
export function buildAnthropicAuthUrl(state: string, challenge: string): string {
  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  return authUrl.toString();
}

/**
 * Log out from Anthropic (removes Anthropic credentials)
 */
export async function runAnthropicLogout(): Promise<boolean> {
  try {
    const authPath = getDexAuthFilePath();

    if (!existsSync(authPath)) {
      return true; // Already logged out
    }

    const authData = JSON.parse(readFileSync(authPath, 'utf-8'));
    delete authData['anthropic'];
    writeFileSync(authPath, JSON.stringify(authData, null, 2));

    return true;
  } catch {
    return false;
  }
}
