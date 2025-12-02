/**
 * Spawn utilities for running dex subcommands
 * Handles both dev mode (TypeScript via bun/tsx) and production (compiled JS)
 */

import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';

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
 * Runtime command for inline scripts (bun -e or node -e)
 */
export const runtimeCmd = isBun ? 'bun' : 'node';
