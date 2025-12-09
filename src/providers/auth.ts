/**
 * Unified auth status module
 *
 * Checks all credential sources and provides helpers for import/status.
 * Credential sources (in priority order):
 * 1. Dex isolated: ~/.dex/opencode/data/opencode/auth.json
 * 2. OpenCode shared: ~/.local/share/opencode/auth.json
 * 3. Claude Code CLI: Keychain (macOS) or ~/.config/claude-code/credentials.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getClaudeCodeCredentials } from './claude-code/credentials.js';
import { getCodexCredentials } from './codex/credentials.js';
import { getDexAuthFilePath } from './claude-code/auth.js';

export type ProviderId = 'anthropic' | 'openai';
export type CredentialSource = 'dex-isolated' | 'opencode-shared' | 'claude-cli';

export interface ProviderAuthStatus {
  provider: ProviderId;
  displayName: string;
  isAuthenticated: boolean;
  source?: CredentialSource;
  subscriptionType?: string;
  expiresAt?: number;
  canImport: boolean;
  importSource?: string;
}

export interface ExternalCredentialSource {
  name: string;
  providers: Array<{
    provider: ProviderId;
    displayName: string;
    subscriptionType?: string;
    expiresAt?: number;
  }>;
}

interface ProviderAuthEntry {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;  // For API key auth
}

interface RawAuthData {
  anthropic?: ProviderAuthEntry;
  openai?: ProviderAuthEntry;
  [key: string]: ProviderAuthEntry | undefined;  // For other providers like openrouter, google, etc.
}

/**
 * Get OpenCode shared auth.json file path
 */
function getSharedAuthFilePath(): string {
  const platform = process.platform;

  if (platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'opencode', 'auth.json');
  }

  const dataHome = process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'auth.json');
}

/**
 * Read auth data from a file
 */
function readAuthFile(path: string): RawAuthData | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as RawAuthData;
  } catch {
    return null;
  }
}

/**
 * Check if provider credentials in auth data are valid
 */
function isProviderValid(data: RawAuthData | null, provider: ProviderId): boolean {
  const providerData = data?.[provider];
  if (!providerData) return false;
  if (!providerData.access || !providerData.refresh) return false;
  // Check expiry - allow some grace period
  if (providerData.expires && providerData.expires < Date.now() - 60000) return false;
  return true;
}

/**
 * Get auth status for dex's isolated credentials
 */
function getDexAuthStatus(): Map<ProviderId, { expiresAt?: number }> {
  const result = new Map<ProviderId, { expiresAt?: number }>();
  const data = readAuthFile(getDexAuthFilePath());

  if (isProviderValid(data, 'anthropic')) {
    result.set('anthropic', { expiresAt: data?.anthropic?.expires });
  }
  if (isProviderValid(data, 'openai')) {
    result.set('openai', { expiresAt: data?.openai?.expires });
  }

  return result;
}

/**
 * Get auth status for OpenCode shared credentials
 */
function getSharedAuthStatus(): Map<ProviderId, { expiresAt?: number }> {
  const result = new Map<ProviderId, { expiresAt?: number }>();
  const data = readAuthFile(getSharedAuthFilePath());

  if (isProviderValid(data, 'anthropic')) {
    result.set('anthropic', { expiresAt: data?.anthropic?.expires });
  }
  if (isProviderValid(data, 'openai')) {
    result.set('openai', { expiresAt: data?.openai?.expires });
  }

  return result;
}

/**
 * Get combined auth status from all sources
 */
export function getAuthStatus(): ProviderAuthStatus[] {
  const dexAuth = getDexAuthStatus();
  const sharedAuth = getSharedAuthStatus();
  const claudeCliCreds = getClaudeCodeCredentials();

  const statuses: ProviderAuthStatus[] = [];

  // Anthropic status
  const hasDexAnthropic = dexAuth.has('anthropic');
  const hasSharedAnthropic = sharedAuth.has('anthropic');
  const hasClaudeCliAnthropic = !!claudeCliCreds;

  statuses.push({
    provider: 'anthropic',
    displayName: 'Claude',
    isAuthenticated: hasDexAnthropic,
    source: hasDexAnthropic ? 'dex-isolated' : undefined,
    expiresAt: hasDexAnthropic ? dexAuth.get('anthropic')?.expiresAt : undefined,
    canImport: !hasDexAnthropic && (hasSharedAnthropic || hasClaudeCliAnthropic),
    importSource: hasClaudeCliAnthropic
      ? 'Claude Code CLI'
      : hasSharedAnthropic
        ? 'OpenCode'
        : undefined,
  });

  // OpenAI status
  const hasDexOpenai = dexAuth.has('openai');
  const hasSharedOpenai = sharedAuth.has('openai');

  statuses.push({
    provider: 'openai',
    displayName: 'ChatGPT',
    isAuthenticated: hasDexOpenai,
    source: hasDexOpenai ? 'dex-isolated' : undefined,
    expiresAt: hasDexOpenai ? dexAuth.get('openai')?.expiresAt : undefined,
    canImport: !hasDexOpenai && hasSharedOpenai,
    importSource: hasSharedOpenai ? 'OpenCode' : undefined,
  });

  return statuses;
}

/**
 * Get external credential sources (for import prompt)
 */
export function getExternalCredentialSources(): ExternalCredentialSource[] {
  const sources: ExternalCredentialSource[] = [];

  // Check Claude Code CLI
  const claudeCliCreds = getClaudeCodeCredentials();
  if (claudeCliCreds) {
    sources.push({
      name: 'Claude Code CLI',
      providers: [
        {
          provider: 'anthropic',
          displayName: 'Claude',
          expiresAt: claudeCliCreds.expiresAt,
        },
      ],
    });
  }

  // Check OpenCode shared
  const sharedData = readAuthFile(getSharedAuthFilePath());
  if (sharedData) {
    const providers: ExternalCredentialSource['providers'] = [];

    if (isProviderValid(sharedData, 'anthropic')) {
      providers.push({
        provider: 'anthropic',
        displayName: 'Claude',
        expiresAt: sharedData.anthropic?.expires,
      });
    }
    if (isProviderValid(sharedData, 'openai')) {
      providers.push({
        provider: 'openai',
        displayName: 'ChatGPT',
        expiresAt: sharedData.openai?.expires,
      });
    }

    if (providers.length > 0) {
      sources.push({
        name: 'OpenCode',
        providers,
      });
    }
  }

  return sources;
}

/**
 * Check if any provider is authenticated in dex
 */
export function hasAnyProvider(): boolean {
  const dexAuth = getDexAuthStatus();
  return dexAuth.size > 0;
}

/**
 * Check if dex has valid credentials (authoritative check)
 */
export function hasDexCredentials(): boolean {
  const authPath = getDexAuthFilePath();
  if (!existsSync(authPath)) return false;

  const data = readAuthFile(authPath);
  return isProviderValid(data, 'anthropic') || isProviderValid(data, 'openai');
}

/**
 * Get the default provider to use (Anthropic preferred)
 */
export function getDefaultProvider(): ProviderId | null {
  const dexAuth = getDexAuthStatus();

  if (dexAuth.has('anthropic')) return 'anthropic';
  if (dexAuth.has('openai')) return 'openai';

  return null;
}

/**
 * Import credentials from external sources to dex isolated storage
 */
export async function importAllCredentials(): Promise<{
  imported: ProviderId[];
  failed: ProviderId[];
}> {
  const authPath = getDexAuthFilePath();
  const authDir = join(authPath, '..');

  // Ensure directory exists
  if (!existsSync(authDir)) {
    mkdirSync(authDir, { recursive: true });
  }

  // Read existing or start fresh
  let authData: RawAuthData = {};
  if (existsSync(authPath)) {
    try {
      authData = JSON.parse(readFileSync(authPath, 'utf-8')) as RawAuthData;
    } catch {
      // Start fresh
    }
  }

  const imported: ProviderId[] = [];
  const failed: ProviderId[] = [];

  // Try to import Anthropic from Claude CLI first, then OpenCode shared
  const claudeCliCreds = getClaudeCodeCredentials();
  if (claudeCliCreds && !isProviderValid(authData, 'anthropic')) {
    authData.anthropic = {
      type: 'oauth',
      access: claudeCliCreds.accessToken,
      refresh: claudeCliCreds.refreshToken,
      expires: claudeCliCreds.expiresAt,
    };
    imported.push('anthropic');
  } else {
    const sharedData = readAuthFile(getSharedAuthFilePath());
    if (isProviderValid(sharedData, 'anthropic') && !isProviderValid(authData, 'anthropic')) {
      authData.anthropic = sharedData!.anthropic;
      imported.push('anthropic');
    }
  }

  // Try to import OpenAI from OpenCode shared
  const sharedData = readAuthFile(getSharedAuthFilePath());
  if (isProviderValid(sharedData, 'openai') && !isProviderValid(authData, 'openai')) {
    authData.openai = sharedData!.openai;
    imported.push('openai');
  }

  // Also check via getCodexCredentials (which reads from shared)
  if (!isProviderValid(authData, 'openai')) {
    const codexCreds = getCodexCredentials();
    if (codexCreds) {
      authData.openai = {
        type: 'oauth',
        access: codexCreds.accessToken,
        refresh: codexCreds.refreshToken,
        expires: codexCreds.expiresAt,
      };
      imported.push('openai');
    }
  }

  // Write updated auth data
  if (imported.length > 0) {
    writeFileSync(authPath, JSON.stringify(authData, null, 2));
  }

  return { imported, failed };
}

/**
 * Import a specific provider's credentials
 */
export async function importCredentials(provider: ProviderId): Promise<boolean> {
  const authPath = getDexAuthFilePath();
  const authDir = join(authPath, '..');

  // Ensure directory exists
  if (!existsSync(authDir)) {
    mkdirSync(authDir, { recursive: true });
  }

  // Read existing or start fresh
  let authData: RawAuthData = {};
  if (existsSync(authPath)) {
    try {
      authData = JSON.parse(readFileSync(authPath, 'utf-8')) as RawAuthData;
    } catch {
      // Start fresh
    }
  }

  if (provider === 'anthropic') {
    // Try Claude CLI first
    const claudeCliCreds = getClaudeCodeCredentials();
    if (claudeCliCreds) {
      authData.anthropic = {
        type: 'oauth',
        access: claudeCliCreds.accessToken,
        refresh: claudeCliCreds.refreshToken,
        expires: claudeCliCreds.expiresAt,
      };
      writeFileSync(authPath, JSON.stringify(authData, null, 2));
      return true;
    }

    // Try OpenCode shared
    const sharedData = readAuthFile(getSharedAuthFilePath());
    if (isProviderValid(sharedData, 'anthropic')) {
      authData.anthropic = sharedData!.anthropic;
      writeFileSync(authPath, JSON.stringify(authData, null, 2));
      return true;
    }

    return false;
  }

  if (provider === 'openai') {
    // Try OpenCode shared
    const sharedData = readAuthFile(getSharedAuthFilePath());
    if (isProviderValid(sharedData, 'openai')) {
      authData.openai = sharedData!.openai;
      writeFileSync(authPath, JSON.stringify(authData, null, 2));
      return true;
    }

    // Try via getCodexCredentials
    const codexCreds = getCodexCredentials();
    if (codexCreds) {
      authData.openai = {
        type: 'oauth',
        access: codexCreds.accessToken,
        refresh: codexCreds.refreshToken,
        expires: codexCreds.expiresAt,
      };
      writeFileSync(authPath, JSON.stringify(authData, null, 2));
      return true;
    }

    return false;
  }

  return false;
}

/**
 * Get credentials for a specific provider from dex isolated storage
 */
export function getDexCredentials(
  provider: ProviderId
): { access: string; refresh: string; expires: number } | null {
  const data = readAuthFile(getDexAuthFilePath());
  const providerData = data?.[provider];

  if (!providerData?.access || !providerData?.refresh || !providerData?.expires) {
    return null;
  }

  return {
    access: providerData.access,
    refresh: providerData.refresh,
    expires: providerData.expires,
  };
}

/**
 * Check if any external credentials are available for import
 */
export function hasExternalCredentials(): boolean {
  const sources = getExternalCredentialSources();
  return sources.length > 0;
}

/**
 * Provider display name mapping for third-party providers
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  openrouter: 'OpenRouter',
  google: 'Google Gemini',
  opencode: 'OpenCode',
  deepseek: 'DeepSeek',
  xai: 'xAI Grok',
  groq: 'Groq',
  together: 'Together AI',
  fireworks: 'Fireworks AI',
  mistral: 'Mistral',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  replicate: 'Replicate',
  ollama: 'Ollama',
  azure: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
};

export interface ThirdPartyProvider {
  id: string;
  displayName: string;
  authType: 'oauth' | 'api';
  maskedKey?: string;  // For API key providers, shows masked version like "sk-...abc123"
}

/**
 * Mask an API key for display (show first 4 and last 4 chars)
 */
function maskApiKey(key: string): string {
  if (key.length <= 12) {
    return key.slice(0, 4) + '...' + key.slice(-4);
  }
  return key.slice(0, 8) + '...' + key.slice(-4);
}

/**
 * Get all third-party providers configured in dex (excluding anthropic/openai)
 */
export function getThirdPartyProviders(): ThirdPartyProvider[] {
  const data = readAuthFile(getDexAuthFilePath());
  if (!data) return [];

  const providers: ThirdPartyProvider[] = [];
  const primaryProviders = ['anthropic', 'openai'];

  for (const [key, value] of Object.entries(data)) {
    if (primaryProviders.includes(key)) continue;
    if (!value) continue;

    // Check if it has valid credentials
    const hasOAuth = value.type === 'oauth' && value.access && value.refresh;
    const hasApiKey = value.type === 'api' && value.key;

    if (hasOAuth || hasApiKey) {
      providers.push({
        id: key,
        displayName: PROVIDER_DISPLAY_NAMES[key] || key.charAt(0).toUpperCase() + key.slice(1),
        authType: hasOAuth ? 'oauth' : 'api',
        maskedKey: hasApiKey && value.key ? maskApiKey(value.key) : undefined,
      });
    }
  }

  return providers;
}

/**
 * Get the full API key for a provider (for editing)
 */
export function getProviderApiKey(providerId: string): string | null {
  const data = readAuthFile(getDexAuthFilePath());
  if (!data) return null;

  const providerData = data[providerId];
  if (!providerData || providerData.type !== 'api' || !providerData.key) {
    return null;
  }

  return providerData.key;
}

/**
 * Update or set an API key for a provider
 */
export function setProviderApiKey(providerId: string, apiKey: string): boolean {
  const authPath = getDexAuthFilePath();
  const authDir = join(authPath, '..');

  // Ensure directory exists
  if (!existsSync(authDir)) {
    mkdirSync(authDir, { recursive: true });
  }

  // Read existing or start fresh
  let data: RawAuthData = {};
  if (existsSync(authPath)) {
    try {
      data = JSON.parse(readFileSync(authPath, 'utf-8')) as RawAuthData;
    } catch {
      // Start fresh
    }
  }

  // Update the provider
  data[providerId] = {
    type: 'api',
    key: apiKey,
  };

  writeFileSync(authPath, JSON.stringify(data, null, 2));
  return true;
}

/**
 * Disconnect a third-party provider by removing it from the auth file
 */
export function disconnectThirdPartyProvider(providerId: string): boolean {
  const authPath = getDexAuthFilePath();
  const data = readAuthFile(authPath);
  if (!data) return false;

  // Don't allow disconnecting primary providers through this function
  if (providerId === 'anthropic' || providerId === 'openai') {
    return false;
  }

  if (!(providerId in data)) {
    return false;
  }

  // Remove the provider
  delete data[providerId];

  // Write back
  writeFileSync(authPath, JSON.stringify(data, null, 2));
  return true;
}
