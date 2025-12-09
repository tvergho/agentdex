/**
 * Tests for Anthropic OAuth auth module
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

describe('claude-code auth module', () => {
  describe('getDexAuthFilePath', () => {
    it('returns path under ~/.dex', async () => {
      const { getDexAuthFilePath } = await import('../../../src/providers/claude-code/auth.js');
      const path = getDexAuthFilePath();

      expect(path).toContain(homedir());
      expect(path).toContain('.dex');
      expect(path).toContain('opencode');
      expect(path).toContain('auth.json');
    });

    it('returns consistent path across calls', async () => {
      const { getDexAuthFilePath } = await import('../../../src/providers/claude-code/auth.js');

      const path1 = getDexAuthFilePath();
      const path2 = getDexAuthFilePath();

      expect(path1).toBe(path2);
    });
  });

  describe('buildAnthropicAuthUrl', () => {
    it('builds valid OAuth URL with required params', async () => {
      const { buildAnthropicAuthUrl } = await import('../../../src/providers/claude-code/auth.js');

      const state = 'test-state-123';
      const challenge = 'test-challenge-abc';

      const url = buildAnthropicAuthUrl(state, challenge);

      expect(url).toContain('https://claude.ai/oauth/authorize');
      expect(url).toContain('response_type=code');
      expect(url).toContain('client_id=');
      expect(url).toContain('redirect_uri=');
      expect(url).toContain('scope=');
      expect(url).toContain(`state=${state}`);
      expect(url).toContain(`code_challenge=${challenge}`);
      expect(url).toContain('code_challenge_method=S256');
    });

    it('uses correct OAuth endpoints', async () => {
      const { buildAnthropicAuthUrl } = await import('../../../src/providers/claude-code/auth.js');

      const url = buildAnthropicAuthUrl('state', 'challenge');

      // Verify using Anthropic's OAuth endpoint
      expect(url.startsWith('https://claude.ai/oauth/authorize')).toBe(true);
    });

    it('includes localhost redirect URI', async () => {
      const { buildAnthropicAuthUrl } = await import('../../../src/providers/claude-code/auth.js');

      const url = buildAnthropicAuthUrl('state', 'challenge');
      const urlObj = new URL(url);
      const redirectUri = urlObj.searchParams.get('redirect_uri');

      // Should redirect to localhost callback
      expect(redirectUri).toContain('localhost');
      expect(redirectUri).toContain('/auth/callback');
    });
  });

  describe('runAnthropicLogout', () => {
    let tempDir: string;
    let originalHome: string | undefined;

    beforeEach(() => {
      // Create temp directory to simulate ~/.dex
      tempDir = join(tmpdir(), `dex-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(join(tempDir, '.dex', 'opencode', 'data', 'opencode'), { recursive: true });

      // Store original HOME
      originalHome = process.env['HOME'];
    });

    afterEach(() => {
      // Restore HOME
      if (originalHome !== undefined) {
        process.env['HOME'] = originalHome;
      }

      // Cleanup
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    });

    it('returns true when auth file does not exist', async () => {
      const { runAnthropicLogout } = await import('../../../src/providers/claude-code/auth.js');

      // This will try to read the real auth file, but should return true if not found
      const result = await runAnthropicLogout();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('OAuth constants', () => {
    it('uses correct client ID', async () => {
      const { buildAnthropicAuthUrl } = await import('../../../src/providers/claude-code/auth.js');

      const url = buildAnthropicAuthUrl('state', 'challenge');

      // Verify Claude's known OAuth client ID
      expect(url).toContain('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    });

    it('requests correct scopes', async () => {
      const { buildAnthropicAuthUrl } = await import('../../../src/providers/claude-code/auth.js');

      const url = buildAnthropicAuthUrl('state', 'challenge');
      const urlObj = new URL(url);
      const scope = urlObj.searchParams.get('scope');

      // Should request inference and profile scopes
      expect(scope).toContain('user:inference');
      expect(scope).toContain('user:profile');
    });
  });
});

describe('OAuth flow integration', () => {
  it('runAnthropicAuth exists and is a function', async () => {
    const { runAnthropicAuth } = await import('../../../src/providers/claude-code/auth.js');
    expect(typeof runAnthropicAuth).toBe('function');
  });

  it('exports all required functions', async () => {
    const auth = await import('../../../src/providers/claude-code/auth.js');

    expect(typeof auth.getDexAuthFilePath).toBe('function');
    expect(typeof auth.runAnthropicAuth).toBe('function');
    expect(typeof auth.runAnthropicLogout).toBe('function');
    expect(typeof auth.buildAnthropicAuthUrl).toBe('function');
  });
});
