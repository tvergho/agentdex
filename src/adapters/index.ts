import { cursorAdapter } from './cursor/index.js';
import { claudeCodeAdapter } from './claude-code/index.js';
import { codexAdapter } from './codex/index.js';
import { openCodeAdapter } from './opencode/index.js';
import type { SourceAdapter } from './types.js';

// Registry of all available adapters
export const adapters: SourceAdapter[] = [cursorAdapter, claudeCodeAdapter, codexAdapter, openCodeAdapter];

export function getAdapter(name: string): SourceAdapter | undefined {
  return adapters.find((a) => a.name === name);
}

export * from './types';
