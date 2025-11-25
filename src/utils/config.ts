import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const DEFAULT_DATA_DIR = join(homedir(), '.dex');

export function getDataDir(): string {
  const dataDir = process.env['DEX_DATA_DIR'] ?? DEFAULT_DATA_DIR;

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  return dataDir;
}

export function getLanceDBPath(): string {
  return join(getDataDir(), 'lancedb');
}
