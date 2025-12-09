/**
 * Chat setup command - Interactive provider onboarding TUI
 *
 * Shows when `dex chat` is run without configured credentials.
 * Allows importing existing credentials or authenticating fresh.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import {
  getAuthStatus,
  getExternalCredentialSources,
  importAllCredentials,
  hasExternalCredentials,
  type ProviderId,
  type ExternalCredentialSource,
} from '../../providers/auth.js';
import { runAnthropicAuth } from '../../providers/claude-code/auth.js';
import { runCodexAuth } from '../../providers/codex/auth.js';
import { getOpencodeBinPath } from '../../utils/paths.js';
import { ProviderCard, type ProviderMenuItem } from '../components/ProviderCard.js';
import { ImportPrompt } from '../components/ImportPrompt.js';
import { AuthenticatingView } from '../components/AuthenticatingView.js';

// ============ Types ============

type SetupPhase =
  | 'import-prompt'
  | 'provider-select'
  | 'authenticating'
  | 'opencode-auth'
  | 'success'
  | 'error';

interface MenuItem {
  id: string;
  section: 'anthropic' | 'openai' | 'more';
  label: string;
  type: 'action';
  color?: string;
}

// ============ Main Component ============

interface ChatSetupAppProps {
  onComplete: (provider: ProviderId | null) => void;
  initialSources: ExternalCredentialSource[];
  showImportPrompt: boolean;
}

function ChatSetupApp({ onComplete, initialSources, showImportPrompt }: ChatSetupAppProps) {
  const { exit } = useApp();
  const { width, height } = useScreenSize();

  // State
  const [phase, setPhase] = useState<SetupPhase>(
    showImportPrompt ? 'import-prompt' : 'provider-select'
  );
  const [sources] = useState(initialSources);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [authProvider, setAuthProvider] = useState<ProviderId | null>(null);
  const [frame, setFrame] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  // Build menu items based on current auth status
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);

  const refreshMenuItems = useCallback(() => {
    const status = getAuthStatus();
    const items: MenuItem[] = [];

    for (const s of status) {
      const section = s.provider as 'anthropic' | 'openai';
      if (s.isAuthenticated) {
        items.push({
          id: `${s.provider}-use`,
          section,
          label: 'Use this provider',
          type: 'action',
          color: 'green',
        });
        items.push({
          id: `${s.provider}-reauth`,
          section,
          label: 'Sign in with different account',
          type: 'action',
        });
      } else {
        items.push({
          id: `${s.provider}-signin`,
          section,
          label: `Sign in with ${s.displayName} (opens browser)`,
          type: 'action',
        });
        if (s.canImport) {
          items.push({
            id: `${s.provider}-import`,
            section,
            label: `Import from ${s.importSource}`,
            type: 'action',
            color: 'blue',
          });
        }
      }
    }

    // More providers
    items.push({
      id: 'more-browse',
      section: 'more',
      label: 'Browse all providers...',
      type: 'action',
    });

    setMenuItems(items);
  }, []);

  useEffect(() => {
    if (phase === 'provider-select') {
      refreshMenuItems();
    }
  }, [phase, refreshMenuItems]);

  // Spinner animation
  useEffect(() => {
    if (phase !== 'authenticating') return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % spinner.length), 120);
    return () => clearInterval(timer);
  }, [phase, spinner.length]);

  // Handle import
  const handleImport = useCallback(async () => {
    const result = await importAllCredentials();
    if (result.imported.length > 0) {
      // Success - complete with default provider
      const status = getAuthStatus();
      const anthropic = status.find((s) => s.provider === 'anthropic');
      if (anthropic?.isAuthenticated) {
        onComplete('anthropic');
      } else {
        const openai = status.find((s) => s.provider === 'openai');
        if (openai?.isAuthenticated) {
          onComplete('openai');
        } else {
          setPhase('provider-select');
        }
      }
    } else {
      setPhase('provider-select');
    }
  }, [onComplete]);

  // Handle OAuth
  const handleAuth = useCallback(
    async (provider: ProviderId) => {
      setAuthProvider(provider);
      setPhase('authenticating');

      let success = false;
      if (provider === 'anthropic') {
        success = await runAnthropicAuth();
      } else if (provider === 'openai') {
        success = await runCodexAuth();
      }

      if (success) {
        setPhase('success');
        setTimeout(() => onComplete(provider), 500);
      } else {
        setErrorMessage('Authentication failed or was cancelled');
        setPhase('error');
        setTimeout(() => {
          setPhase('provider-select');
          refreshMenuItems();
        }, 2000);
      }
    },
    [onComplete, refreshMenuItems]
  );

  // Handle OpenCode auth
  const handleOpencodeAuth = useCallback(() => {
    setPhase('opencode-auth');

    const opencodePath = getOpencodeBinPath();
    const child = spawn(opencodePath, ['auth', 'login'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        XDG_DATA_HOME: join(homedir(), '.dex', 'opencode', 'data'),
        XDG_CONFIG_HOME: join(homedir(), '.dex', 'opencode', 'config'),
      },
    });

    child.on('close', () => {
      // Check what was configured
      const status = getAuthStatus();
      const authenticated = status.find((s) => s.isAuthenticated);
      if (authenticated) {
        onComplete(authenticated.provider);
      } else {
        setPhase('provider-select');
        refreshMenuItems();
      }
    });

    child.on('error', () => {
      setErrorMessage('Failed to launch OpenCode auth');
      setPhase('error');
      setTimeout(() => {
        setPhase('provider-select');
        refreshMenuItems();
      }, 2000);
    });
  }, [onComplete, refreshMenuItems]);

  // Handle menu action
  const handleAction = useCallback(
    async (item: MenuItem) => {
      if (item.id.endsWith('-use')) {
        // Use connected provider
        onComplete(item.section as ProviderId);
      } else if (item.id.endsWith('-signin') || item.id.endsWith('-reauth')) {
        // Start OAuth
        await handleAuth(item.section as ProviderId);
      } else if (item.id.endsWith('-import')) {
        // Import specific provider
        await importAllCredentials();
        refreshMenuItems();
        // Check if now authenticated
        const status = getAuthStatus();
        const provider = status.find((s) => s.provider === item.section);
        if (provider?.isAuthenticated) {
          onComplete(item.section as ProviderId);
        }
      } else if (item.id === 'more-browse') {
        handleOpencodeAuth();
      }
    },
    [handleAuth, handleOpencodeAuth, onComplete, refreshMenuItems]
  );

  // Keyboard input
  useInput((input, key) => {
    if (phase === 'import-prompt') {
      if (input === 'j' || key.downArrow) {
        setSelectedIndex((i) => Math.min(i + 1, 1));
      } else if (input === 'k' || key.upArrow) {
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (key.return) {
        if (selectedIndex === 0) {
          handleImport();
        } else {
          setPhase('provider-select');
          setSelectedIndex(0);
        }
      } else if (input === 'q' || key.escape) {
        onComplete(null);
        exit();
      }
    } else if (phase === 'provider-select') {
      if (input === 'j' || key.downArrow) {
        setSelectedIndex((i) => Math.min(i + 1, menuItems.length - 1));
      } else if (input === 'k' || key.upArrow) {
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (key.return) {
        const item = menuItems[selectedIndex];
        if (item) {
          handleAction(item);
        }
      } else if (input === 'q' || key.escape) {
        onComplete(null);
        exit();
      }
    } else if (phase === 'authenticating') {
      if (key.escape) {
        // Can't really cancel OAuth, but go back
        setPhase('provider-select');
        refreshMenuItems();
      }
    }
  });

  const cardWidth = Math.max(50, width - 6);

  // Footer helpers
  const Key = ({ k }: { k: string }) => <Text color="white">{k}</Text>;
  const Sep = () => <Text dimColor> · </Text>;

  // Render based on phase
  if (phase === 'opencode-auth') {
    // OpenCode takes over the terminal
    return null;
  }

  return (
    <Box width={width} height={height} flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>dex chat</Text>
      </Box>

      {phase === 'import-prompt' && (
        <ImportPrompt sources={sources} selectedIndex={selectedIndex} width={cardWidth} />
      )}

      {phase === 'provider-select' && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text>Connect a provider to start chatting</Text>
          </Box>

          {/* Anthropic card */}
          <Box marginBottom={1}>
            <ProviderCard
              provider="anthropic"
              displayName="Claude"
              status={
                getAuthStatus().find((s) => s.provider === 'anthropic')?.isAuthenticated
                  ? 'connected'
                  : 'available'
              }
              subscriptionType={
                getAuthStatus().find((s) => s.provider === 'anthropic')?.subscriptionType
              }
              menuItems={menuItems
                .filter((m) => m.section === 'anthropic')
                .map((m) => ({ id: m.id, label: m.label, type: m.type, color: m.color }))}
              selectedItemId={menuItems[selectedIndex]?.section === 'anthropic' ? menuItems[selectedIndex]?.id : undefined}
              isFocused={menuItems[selectedIndex]?.section === 'anthropic'}
              width={cardWidth}
            />
          </Box>

          {/* OpenAI card */}
          <Box marginBottom={1}>
            <ProviderCard
              provider="openai"
              displayName="Codex (ChatGPT)"
              status={
                getAuthStatus().find((s) => s.provider === 'openai')?.isAuthenticated
                  ? 'connected'
                  : 'available'
              }
              subscriptionType={
                getAuthStatus().find((s) => s.provider === 'openai')?.subscriptionType
              }
              menuItems={menuItems
                .filter((m) => m.section === 'openai')
                .map((m) => ({ id: m.id, label: m.label, type: m.type, color: m.color }))}
              selectedItemId={menuItems[selectedIndex]?.section === 'openai' ? menuItems[selectedIndex]?.id : undefined}
              isFocused={menuItems[selectedIndex]?.section === 'openai'}
              width={cardWidth}
            />
          </Box>

          {/* More providers card */}
          <Box marginBottom={1}>
            <ProviderCard
              provider="more"
              displayName="More Providers"
              status="available"
              menuItems={menuItems
                .filter((m) => m.section === 'more')
                .map((m) => ({ id: m.id, label: m.label, type: m.type, color: m.color }))}
              selectedItemId={menuItems[selectedIndex]?.section === 'more' ? menuItems[selectedIndex]?.id : undefined}
              isFocused={menuItems[selectedIndex]?.section === 'more'}
              width={cardWidth}
            />
          </Box>
        </Box>
      )}

      {phase === 'authenticating' && authProvider && (
        <AuthenticatingView
          provider={authProvider}
          providerName={authProvider === 'anthropic' ? 'Claude' : 'ChatGPT'}
          spinner={spinner[frame] || '⠋'}
          width={cardWidth}
        />
      )}

      {phase === 'success' && (
        <Box>
          <Text color="green">✓ </Text>
          <Text>Connected to {authProvider === 'anthropic' ? 'Claude' : 'ChatGPT'}</Text>
        </Box>
      )}

      {phase === 'error' && (
        <Box>
          <Text color="red">✗ </Text>
          <Text>{errorMessage}</Text>
        </Box>
      )}

      {/* Spacer */}
      <Box flexGrow={1} />

      {/* Footer */}
      {(phase === 'import-prompt' || phase === 'provider-select') && (
        <Box flexDirection="column">
          <Box>
            <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
          </Box>
          <Box>
            <Key k="j/k" />
            <Text dimColor>: navigate</Text>
            <Sep />
            <Key k="Enter" />
            <Text dimColor>: select</Text>
            <Sep />
            <Key k="q" />
            <Text dimColor>: quit</Text>
          </Box>
        </Box>
      )}

      {phase === 'authenticating' && (
        <Box flexDirection="column">
          <Box>
            <Text color="gray">{'─'.repeat(Math.max(0, width - 2))}</Text>
          </Box>
          <Box>
            <Key k="Esc" />
            <Text dimColor>: cancel</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

// ============ Exports ============

export interface ChatSetupResult {
  provider: ProviderId | null;
  cancelled: boolean;
}

/**
 * Run the chat setup TUI
 */
export async function runChatSetup(): Promise<ChatSetupResult> {
  return new Promise((resolve) => {
    const sources = getExternalCredentialSources();
    const showImportPrompt = hasExternalCredentials();

    const handleComplete = (provider: ProviderId | null) => {
      resolve({
        provider,
        cancelled: provider === null,
      });
    };

    const app = withFullScreen(
      <ChatSetupApp
        onComplete={handleComplete}
        initialSources={sources}
        showImportPrompt={showImportPrompt}
      />
    );

    app.start();
    app.waitUntilExit().then(() => {
      resolve({ provider: null, cancelled: true });
    });
  });
}

/**
 * Run just the import prompt (for quick import flow)
 */
export async function runImportPrompt(): Promise<boolean> {
  const result = await importAllCredentials();
  return result.imported.length > 0;
}
