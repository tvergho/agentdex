/**
 * OpenCode configuration setup for Codex integration
 *
 * Ensures OpenCode is configured with the opencode-openai-codex-auth plugin
 * and GPT-5.1 model definitions before attempting OAuth authentication.
 *
 * Config location: ~/.config/opencode/opencode.json (Linux/macOS)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Current plugin version - update when upgrading */
export const PLUGIN_VERSION = '4.4.0';

/**
 * Full OpenCode configuration with the Codex auth plugin
 * Source: https://github.com/numman-ali/opencode-openai-codex-auth/blob/main/config/full-opencode.json
 */
export const OPENCODE_CODEX_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  plugin: [`opencode-openai-codex-auth@${PLUGIN_VERSION}`],
  provider: {
    openai: {
      options: {
        reasoningEffort: 'medium',
        reasoningSummary: 'auto',
        textVerbosity: 'medium',
        include: ['reasoning.encrypted_content'],
        store: false,
      },
      models: {
        'gpt-5.1-codex-low': {
          name: 'GPT 5.1 Codex Low (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'low',
            reasoningSummary: 'auto',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.1-codex-medium': {
          name: 'GPT 5.1 Codex Medium (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'medium',
            reasoningSummary: 'auto',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.1-codex-high': {
          name: 'GPT 5.1 Codex High (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'high',
            reasoningSummary: 'detailed',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.1-codex-max': {
          name: 'GPT 5.1 Codex Max (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'high',
            reasoningSummary: 'detailed',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.1-codex-max-low': {
          name: 'GPT 5.1 Codex Max Low (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'low',
            reasoningSummary: 'detailed',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.1-codex-max-medium': {
          name: 'GPT 5.1 Codex Max Medium (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'medium',
            reasoningSummary: 'detailed',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.1-codex-max-high': {
          name: 'GPT 5.1 Codex Max High (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'high',
            reasoningSummary: 'detailed',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.1-codex-max-xhigh': {
          name: 'GPT 5.1 Codex Max Extra High (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'xhigh',
            reasoningSummary: 'detailed',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.1-codex-mini-medium': {
          name: 'GPT 5.1 Codex Mini Medium (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'medium',
            reasoningSummary: 'auto',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.1-codex-mini-high': {
          name: 'GPT 5.1 Codex Mini High (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'high',
            reasoningSummary: 'detailed',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        // GPT-5.2 Codex models
        'gpt-5.2-codex': {
          name: 'GPT 5.2 Codex (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'medium',
            reasoningSummary: 'auto',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.2-codex-high': {
          name: 'GPT 5.2 Codex High (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'high',
            reasoningSummary: 'detailed',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.2': {
          name: 'GPT 5.2 (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'medium',
            reasoningSummary: 'auto',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.1-low': {
          name: 'GPT 5.1 Low (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'low',
            reasoningSummary: 'auto',
            textVerbosity: 'low',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.1-medium': {
          name: 'GPT 5.1 Medium (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'medium',
            reasoningSummary: 'auto',
            textVerbosity: 'medium',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
        'gpt-5.1-high': {
          name: 'GPT 5.1 High (OAuth)',
          limit: { context: 272000, output: 128000 },
          options: {
            reasoningEffort: 'high',
            reasoningSummary: 'detailed',
            textVerbosity: 'high',
            include: ['reasoning.encrypted_content'],
            store: false,
          },
        },
      },
    },
  },
};

/**
 * Get OpenCode config directory path (cross-platform)
 */
function getConfigDir(): string {
  const platform = process.platform;

  if (platform === 'win32') {
    // Windows: %APPDATA%/opencode or ~/.config/opencode
    const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'opencode');
  }

  // Linux/macOS: ~/.config/opencode
  const configHome = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  return join(configHome, 'opencode');
}

/**
 * Get OpenCode config file path
 */
function getConfigPath(): string {
  return join(getConfigDir(), 'opencode.json');
}

interface OpenCodeConfig {
  plugin?: string[];
  provider?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Check if existing config has the Codex plugin configured
 */
function hasCodexPlugin(config: OpenCodeConfig): boolean {
  if (!config.plugin || !Array.isArray(config.plugin)) {
    return false;
  }
  return config.plugin.some((p) => p.startsWith('opencode-openai-codex-auth'));
}

/**
 * Ensure OpenCode is configured with the Codex auth plugin
 *
 * - Creates config directory if missing
 * - Creates config file with plugin + models if missing
 * - Updates existing config to add plugin if not present
 * - Preserves existing user settings when possible
 *
 * @returns true if config was created/updated, false if already configured
 */
export function ensureOpenCodeConfig(): boolean {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  // Create config directory if needed
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  // If no config exists, create the full config
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(OPENCODE_CODEX_CONFIG, null, 2));
    return true;
  }

  // Read existing config
  let existingConfig: OpenCodeConfig;
  try {
    existingConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as OpenCodeConfig;
  } catch {
    // Config is corrupted, replace it
    writeFileSync(configPath, JSON.stringify(OPENCODE_CODEX_CONFIG, null, 2));
    return true;
  }

  // Check if plugin is already configured
  if (hasCodexPlugin(existingConfig)) {
    return false; // Already configured
  }

  // Merge: add plugin and OpenAI provider config while preserving other settings
  const updatedConfig: OpenCodeConfig = {
    ...existingConfig,
    $schema: 'https://opencode.ai/config.json',
    plugin: [
      ...(existingConfig.plugin || []),
      `opencode-openai-codex-auth@${PLUGIN_VERSION}`,
    ],
    provider: {
      ...(existingConfig.provider || {}),
      openai: OPENCODE_CODEX_CONFIG.provider.openai,
    },
  };

  writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
  return true;
}

/**
 * Get the current plugin version bundled with dex
 */
export function getCodexPluginVersion(): string {
  return PLUGIN_VERSION;
}
