import { homedir } from 'os';
import { join } from 'path';

export type Platform = 'darwin' | 'win32' | 'linux';

export function getPlatform(): Platform {
  const platform = process.platform;
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    return platform;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Get the user's home directory.
 * Prefers environment variables (HOME on Unix, USERPROFILE on Windows) over os.homedir()
 * for better testability.
 */
function getHomeDir(): string {
  // Check environment variables first for testability
  if (process.platform === 'win32') {
    return process.env['USERPROFILE'] || process.env['HOME'] || homedir();
  }
  return process.env['HOME'] || homedir();
}

export function expandPath(path: string): string {
  if (path.startsWith('~/')) {
    return join(getHomeDir(), path.slice(2));
  }
  if (path.startsWith('%APPDATA%')) {
    const appData = process.env['APPDATA'];
    if (!appData) {
      throw new Error('APPDATA environment variable not set');
    }
    return path.replace('%APPDATA%', appData);
  }
  return path;
}
