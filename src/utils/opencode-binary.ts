import { existsSync, mkdirSync, chmodSync, unlinkSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir, platform, arch } from 'os';
import { execSync } from 'child_process';

const DEX_BIN_DIR = join(homedir(), '.dex', 'bin');
const OPENCODE_BIN_PATH = join(DEX_BIN_DIR, 'opencode');

const FORK_OWNER = 'tvergho';
const FORK_REPO = 'opencode';
const RELEASE_VERSION = 'v1.0.0-fork.5';

function getAssetName(): string {
  const p = platform();
  const a = arch();

  if (p === 'darwin' && a === 'arm64') return 'opencode-darwin-arm64.zip';
  if (p === 'darwin' && a === 'x64') return 'opencode-darwin-x64.zip';
  if (p === 'linux' && a === 'x64') return 'opencode-linux-x64.zip';
  if (p === 'linux' && a === 'arm64') return 'opencode-linux-arm64.zip';
  if (p === 'win32' && a === 'x64') return 'opencode-win32-x64.zip';

  throw new Error(`Unsupported platform: ${p}-${a}`);
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

  chmodSync(OPENCODE_BIN_PATH, 0o755);
  unlinkSync(zipPath);

  console.log('OpenCode binary installed.');
}

export async function ensureOpencodeBinary(): Promise<string> {
  if (existsSync(OPENCODE_BIN_PATH)) {
    return OPENCODE_BIN_PATH;
  }

  await downloadBinary();
  return OPENCODE_BIN_PATH;
}

export function getOpencodeBinLocation(): string {
  return OPENCODE_BIN_PATH;
}
