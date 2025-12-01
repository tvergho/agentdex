import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  getBinDir,
  getLlamaServerPath,
  isLlamaServerInstalled,
} from '../../../src/embeddings/llama-server';

// Mock the config module to use a temp directory
const originalEnv = process.env.DEX_DATA_DIR;
let tempDir: string;

beforeEach(() => {
  tempDir = join('/tmp', `dex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  process.env.DEX_DATA_DIR = tempDir;
});

afterEach(() => {
  process.env.DEX_DATA_DIR = originalEnv;
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('getBinDir', () => {
  it('returns path under data directory', () => {
    const binDir = getBinDir();
    expect(binDir).toBe(join(tempDir, 'bin'));
  });

  it('creates the bin directory if it does not exist', () => {
    expect(existsSync(join(tempDir, 'bin'))).toBe(false);
    getBinDir();
    expect(existsSync(join(tempDir, 'bin'))).toBe(true);
  });
});

describe('getLlamaServerPath', () => {
  it('returns path to llama-server executable', () => {
    const serverPath = getLlamaServerPath();
    expect(serverPath).toContain('bin');
    
    // Check platform-specific executable name
    if (process.platform === 'win32') {
      expect(serverPath).toEndWith('llama-server.exe');
    } else {
      expect(serverPath).toEndWith('llama-server');
    }
  });
});

describe('isLlamaServerInstalled', () => {
  it('returns false when llama-server does not exist', () => {
    expect(isLlamaServerInstalled()).toBe(false);
  });

  it('returns true when llama-server exists', () => {
    const binDir = getBinDir();
    const executable = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const serverPath = join(binDir, executable);
    
    // Create a fake executable file
    writeFileSync(serverPath, '#!/bin/bash\necho "fake"');
    
    expect(isLlamaServerInstalled()).toBe(true);
  });
});

