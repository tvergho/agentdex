/**
 * Path utilities for finding package resources
 *
 * These utilities work correctly in both:
 * - Development mode (running via bun/tsx from source)
 * - Production mode (running compiled dist/index.js)
 * - Globally linked mode (running via npm/bun link)
 */

import { dirname, join } from 'path';
import { existsSync, realpathSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';

/**
 * Find the package root by walking up from the entry script
 * Works for both source and compiled code
 */
function findPackageRoot(): string {
  // Start from the entry script (process.argv[1])
  let scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error('Cannot determine script path');
  }

  // Resolve symlinks (important for bun link / npm link)
  try {
    scriptPath = realpathSync(scriptPath);
  } catch {
    // If realpath fails, continue with original path
  }

  let dir = dirname(scriptPath);

  // Walk up until we find package.json
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // Reached root
    dir = parent;
  }

  // Fallback: use script directory's parent (works for dist/index.js)
  return dirname(dirname(scriptPath));
}

// Cache the package root
let cachedPackageRoot: string | null = null;

/**
 * Get the package root directory
 */
export function getPackageRoot(): string {
  if (!cachedPackageRoot) {
    cachedPackageRoot = findPackageRoot();
  }
  return cachedPackageRoot;
}

/**
 * Find the opencode binary from system PATH or common install locations
 */
export function getOpencodeBinPath(): string {
  // Check if opencode is in PATH
  try {
    const which = execSync('which opencode', { encoding: 'utf-8' }).trim();
    if (which) {
      return which;
    }
  } catch {
    // Not in PATH
  }

  // Check common installation locations
  const candidates = [
    join(homedir(), '.opencode', 'bin', 'opencode'),
    join(homedir(), '.local', 'share', 'opencode', 'bin', 'opencode'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback to 'opencode' and let spawn fail with a clear error
  return 'opencode';
}
