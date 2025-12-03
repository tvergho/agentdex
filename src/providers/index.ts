/**
 * Provider registry
 *
 * Exports provider infrastructure for credentials, clients, and shared server.
 */

// Shared OpenCode server (singleton)
export * from './server.js';

// Claude Code provider
export * from './claude-code/credentials.js';
export * from './claude-code/client.js';

// Codex (ChatGPT) provider
export * from './codex/credentials.js';
export * from './codex/client.js';
export * from './codex/auth.js';
export * from './codex/setup.js';

