import { existsSync, mkdirSync, chmodSync, unlinkSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir, platform, arch } from 'os';
import { execSync } from 'child_process';

const DEX_BIN_DIR = join(homedir(), '.dex', 'bin');
const OPENCODE_BIN_PATH = join(DEX_BIN_DIR, 'opencode');

// Dev override: set DEX_OPENCODE_BIN to use a local binary
const DEV_OPENCODE_BIN = process.env.DEX_OPENCODE_BIN;

// Fork binary config - only darwin-arm64 is built from fork
const FORK_OWNER = 'tvergho';
const FORK_REPO = 'opencode';
const RELEASE_VERSION = 'v1.0.0-fork.8';

// Check if we should use the fork binary (only darwin-arm64)
function shouldUseForkBinary(): boolean {
  return platform() === 'darwin' && arch() === 'arm64';
}

// Try to find opencode in PATH
function findSystemOpencode(): string | null {
  try {
    const result = execSync('which opencode', { stdio: 'pipe', encoding: 'utf-8' });
    const path = result.trim();
    if (path && existsSync(path)) {
      return path;
    }
  } catch {
    // Not found in PATH
  }
  return null;
}

function getAssetName(): string {
  // Only darwin-arm64 is available from the fork
  if (platform() === 'darwin' && arch() === 'arm64') {
    return 'opencode-darwin-arm64.zip';
  }
  throw new Error(`Fork binary not available for ${platform()}-${arch()}`);
}

async function downloadBinary(): Promise<void> {
  const assetName = getAssetName();
  const url = `https://github.com/${FORK_OWNER}/${FORK_REPO}/releases/download/${RELEASE_VERSION}/${assetName}`;

  console.log(`Downloading OpenCode from ${url}...`);

  mkdirSync(DEX_BIN_DIR, { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  const zipPath = join(DEX_BIN_DIR, assetName);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(zipPath, buffer);

  console.log('Extracting...');
  execSync(`unzip -o "${zipPath}" -d "${DEX_BIN_DIR}"`, { stdio: 'pipe' });

  // Handle nested directory structure: opencode-darwin-arm64/bin/opencode
  const extractedDir = join(DEX_BIN_DIR, assetName.replace('.zip', ''));
  const extractedBin = join(extractedDir, 'bin', 'opencode');
  if (existsSync(extractedBin)) {
    execSync(`mv "${extractedBin}" "${OPENCODE_BIN_PATH}"`, { stdio: 'pipe' });
    execSync(`rm -rf "${extractedDir}"`, { stdio: 'pipe' });
  }

  chmodSync(OPENCODE_BIN_PATH, 0o755);
  unlinkSync(zipPath);

  console.log('OpenCode binary installed.');
}

export async function ensureOpencodeBinary(): Promise<string> {
  if (DEV_OPENCODE_BIN) {
    if (!existsSync(DEV_OPENCODE_BIN)) {
      throw new Error(`DEX_OPENCODE_BIN set but binary not found at: ${DEV_OPENCODE_BIN}`);
    }
    return DEV_OPENCODE_BIN;
  }

  // For darwin-arm64, use the fork binary
  if (shouldUseForkBinary()) {
    if (existsSync(OPENCODE_BIN_PATH)) {
      return OPENCODE_BIN_PATH;
    }
    await downloadBinary();
    return OPENCODE_BIN_PATH;
  }

  // For other platforms, try to find opencode in PATH
  const systemOpencode = findSystemOpencode();
  if (systemOpencode) {
    return systemOpencode;
  }

  // Fallback: use npx to run opencode-ai
  // Return a special marker that the caller should handle
  return 'npx:opencode-ai';
}

export function getOpencodeBinLocation(): string {
  if (DEV_OPENCODE_BIN) {
    return DEV_OPENCODE_BIN;
  }

  if (shouldUseForkBinary()) {
    return OPENCODE_BIN_PATH;
  }

  // For other platforms, check system first
  const systemOpencode = findSystemOpencode();
  if (systemOpencode) {
    return systemOpencode;
  }

  return 'npx:opencode-ai';
}

// Check if the binary path indicates npx should be used
export function isNpxFallback(binPath: string): boolean {
  return binPath === 'npx:opencode-ai';
}
