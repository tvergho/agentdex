import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';

export interface CursorCredentials {
  accessToken: string;
  refreshToken: string;
}

export interface CursorCredentialStatus {
  isAuthenticated: boolean;
  error?: string;
}

function getStateDbPath(): string {
  const platform = process.platform;

  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }

  if (platform === 'win32') {
    const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }

  const configHome = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  return join(configHome, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function getCredentialsFilePath(): string {
  const platform = process.platform;

  if (platform === 'win32') {
    const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Cursor', 'User', 'globalStorage', 'cursor-auth.json');
  }

  const configHome = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  return join(configHome, 'Cursor', 'User', 'globalStorage', 'cursor-auth.json');
}

function readFromStateDb(): CursorCredentials | null {
  const dbPath = getStateDbPath();

  if (!existsSync(dbPath)) {
    return null;
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    
    const accessRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get() as { value: string } | undefined;
    const refreshRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/refreshToken'").get() as { value: string } | undefined;
    
    db.close();

    if (accessRow?.value && refreshRow?.value) {
      return {
        accessToken: accessRow.value,
        refreshToken: refreshRow.value,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function readFromKeychain(service: string): string | null {
  try {
    const output = execSync(
      `security find-generic-password -s "${service}" -a "cursor-user" -w`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return output.trim();
  } catch {
    return null;
  }
}

function readFromFile(): CursorCredentials | null {
  const filePath = getCredentialsFilePath();

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as { accessToken?: string; refreshToken?: string };
    if (parsed.accessToken && parsed.refreshToken) {
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function getCursorCredentials(): CursorCredentials | null {
  // First try: Read from SQLite state database (newer Cursor versions)
  const fromDb = readFromStateDb();
  if (fromDb) {
    return fromDb;
  }

  // Second try: Read from Keychain on macOS (older Cursor versions)
  if (process.platform === 'darwin') {
    const accessToken = readFromKeychain('cursor-access-token');
    const refreshToken = readFromKeychain('cursor-refresh-token');

    if (accessToken && refreshToken) {
      return { accessToken, refreshToken };
    }
  }

  // Third try: Read from JSON file (Linux/Windows fallback)
  return readFromFile();
}

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function isTokenExpired(token: string): boolean {
  try {
    const jwtParts = token.split('.');
    const hasThreeParts = jwtParts.length === 3;
    if (!hasThreeParts) return true;
    
    const payload = JSON.parse(Buffer.from(jwtParts[1]!, 'base64').toString('utf-8'));
    const hasNoExpiry = !payload.exp;
    if (hasNoExpiry) return false;
    
    const jwtExpInSeconds = payload.exp as number;
    const expiresAtMs = jwtExpInSeconds * 1000;
    const now = Date.now();
    
    return now >= expiresAtMs - TOKEN_EXPIRY_BUFFER_MS;
  } catch {
    return true;
  }
}

export interface RefreshResult {
  success: boolean;
  credentials?: CursorCredentials;
  error?: string;
}

const OAUTH_TOKEN_ENDPOINTS = [
  'https://authenticator.cursor.sh/oauth/token',
  'https://authentication.cursor.sh/oauth/token',
];

export async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  for (const endpoint of OAUTH_TOKEN_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });

      if (response.ok) {
        const data = await response.json() as { access_token?: string; refresh_token?: string };
        if (data.access_token) {
          return {
            success: true,
            credentials: {
              accessToken: data.access_token,
              refreshToken: data.refresh_token || refreshToken,
            },
          };
        }
      }
    } catch {
      continue;
    }
  }

  return {
    success: false,
    error: 'Token refresh failed. Please log out and log back in to Cursor to refresh your session.',
  };
}

export function getCursorCredentialStatus(): CursorCredentialStatus {
  try {
    const credentials = getCursorCredentials();

    if (!credentials) {
      return {
        isAuthenticated: false,
        error: 'No Cursor credentials found. Please log in to Cursor first.',
      };
    }

    if (!credentials.accessToken) {
      return {
        isAuthenticated: false,
        error: 'Incomplete Cursor credentials. Please re-authenticate in Cursor.',
      };
    }

    if (isTokenExpired(credentials.accessToken)) {
      return {
        isAuthenticated: false,
        error: 'Cursor access token has expired. Please log out and log back in to Cursor to refresh your session.',
      };
    }

    return {
      isAuthenticated: true,
    };
  } catch (error) {
    return {
      isAuthenticated: false,
      error: error instanceof Error ? error.message : 'Failed to read credentials',
    };
  }
}
