/**
 * Spawn utilities for running dex subcommands
 * Handles both dev mode (TypeScript via bun/tsx) and production (compiled JS)
 */

import { spawn, execSync as execSyncFn, type SpawnOptions, type ChildProcess } from 'child_process';

const isBun = process.versions.bun !== undefined;

/**
 * Spawn a dex subcommand (e.g., 'sync', 'embed')
 * Automatically handles TypeScript in dev mode
 */
export function spawnDexCommand(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {}
): ChildProcess {
  const scriptPath = process.argv[1]!;
  const isTypeScript = scriptPath.endsWith('.ts') || scriptPath.endsWith('.tsx');

  if (isTypeScript) {
    // Dev mode: use bun or npx tsx to run TypeScript
    if (isBun) {
      return spawn('bun', [scriptPath, command, ...args], { ...options, shell: true });
    } else {
      return spawn('npx', ['tsx', scriptPath, command, ...args], { ...options, shell: true });
    }
  } else {
    // Production: use the current runtime (node) with compiled JS
    return spawn(process.execPath, [scriptPath, command, ...args], options);
  }
}

/**
 * Build command string for spawning in a shell (used for detached background processes)
 * Returns { command, args } for use with spawn()
 */
export function buildDexCommandForShell(command: string): { cmd: string; shellCommand: string } {
  const scriptPath = process.argv[1]!;
  const isTypeScript = scriptPath.endsWith('.ts') || scriptPath.endsWith('.tsx');
  const isWindows = process.platform === 'win32';

  let shellCommand: string;

  if (isWindows) {
    if (isTypeScript) {
      shellCommand = `npx tsx "${scriptPath}" ${command}`;
    } else {
      shellCommand = `"${process.execPath}" "${scriptPath}" ${command}`;
    }
  } else {
    if (isTypeScript) {
      if (isBun) {
        shellCommand = `nice -n 19 bun "${scriptPath}" ${command}`;
      } else {
        shellCommand = `nice -n 19 npx tsx "${scriptPath}" ${command}`;
      }
    } else {
      shellCommand = `nice -n 19 "${process.execPath}" "${scriptPath}" ${command}`;
    }
  }

  return { cmd: isWindows ? 'cmd' : 'sh', shellCommand };
}

/**
 * Spawn a detached background process for a dex command
 * Process runs independently and won't block the parent
 */
export function spawnBackgroundCommand(command: string): void {
  const { shellCommand } = buildDexCommandForShell(command);

  const child = spawn(shellCommand, [], {
    detached: true,
    stdio: 'ignore',
    shell: true,
    cwd: process.cwd(),
    env: process.env,
  });

  child.unref();
}

/**
 * Check if a process matching the given pattern is running
 * Uses pgrep on Unix, tasklist on Windows
 */
export function isProcessRunning(pattern: string): boolean {
  try {
    if (process.platform === 'win32') {
      execSyncFn(`tasklist /FI "IMAGENAME eq node.exe" 2>nul | findstr /I "${pattern}"`, { stdio: 'pipe' });
    } else {
      execSyncFn(`pgrep -f "${pattern}" 2>/dev/null`, { stdio: 'pipe' });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a background command with verification and retry.
 * Waits briefly to verify the process started, retries up to maxRetries times.
 * Returns true if spawn succeeded, false otherwise.
 */
export async function spawnBackgroundCommandWithRetry(
  command: string,
  processPattern: string,
  options: { maxRetries?: number; verifyDelayMs?: number } = {}
): Promise<boolean> {
  const { maxRetries = 3, verifyDelayMs = 1000 } = options;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Check if already running
    if (isProcessRunning(processPattern)) {
      return true;
    }
    
    // Spawn the command
    spawnBackgroundCommand(command);
    
    // Wait for it to start
    await new Promise(resolve => setTimeout(resolve, verifyDelayMs));
    
    // Verify it's running
    if (isProcessRunning(processPattern)) {
      return true;
    }
    
    // If not running and we have retries left, try again
    if (attempt < maxRetries) {
      // Wait a bit longer before retry
      await new Promise(resolve => setTimeout(resolve, verifyDelayMs));
    }
  }
  
  return false;
}

/**
 * Runtime command for inline scripts (bun -e or node -e)
 */
export const runtimeCmd = isBun ? 'bun' : 'node';
