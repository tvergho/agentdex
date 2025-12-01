/**
 * Config command - Settings TUI for managing provider connections and features
 *
 * Usage: dex config
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index.js';
import {
  loadConfig,
  updateProviderConfig,
  type DexConfig,
} from '../../config/index.js';
import {
  getClaudeCodeCredentialStatus,
  type CredentialStatus,
} from '../../providers/index.js';
import {
  countUntitledConversations,
  enrichUntitledConversations,
  type EnrichmentProgress,
} from '../../features/enrichment/index.js';
import { conversationRepo } from '../../db/repository.js';

// ============ Progress Bar Component ============

function ProgressBar({
  current,
  total,
  width,
}: {
  current: number;
  total: number;
  width: number;
}) {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  const barWidth = Math.max(20, width - 16);
  const filled = Math.round((current / total) * barWidth);
  const empty = barWidth - filled;

  return (
    <Box>
      <Text color="green">{'█'.repeat(filled)}</Text>
      <Text color="gray">{'░'.repeat(empty)}</Text>
      <Text dimColor> {current}/{total} </Text>
      <Text color="cyan">{percentage}%</Text>
    </Box>
  );
}

// ============ Main Config App ============

type MenuItem = {
  id: string;
  label: string;
  type: 'toggle' | 'action' | 'button';
  value?: boolean;
  disabled?: boolean;
  section?: string;
};

function ConfigApp() {
  const { exit } = useApp();
  const { width, height } = useScreenSize();

  // State
  const [config, setConfig] = useState<DexConfig | null>(null);
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [untitledCount, setUntitledCount] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [generationProgress, setGenerationProgress] = useState<EnrichmentProgress | null>(null);
  const [frame, setFrame] = useState(0);
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  // Load initial state
  useEffect(() => {
    async function load() {
      try {
        await connect();
        const cfg = loadConfig();
        setConfig(cfg);

        const status = getClaudeCodeCredentialStatus();
        setCredentialStatus(status);

        const count = await countUntitledConversations();
        setUntitledCount(count);
      } catch (err) {
        setToast({
          message: `Failed to load: ${err instanceof Error ? err.message : String(err)}`,
          type: 'error',
        });
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Build menu items
  const menuItems: MenuItem[] = [];
  const claudeCodeConnected = config?.providers.claudeCode.enabled ?? false;

  if (config && claudeCodeConnected) {
    // Order matches visual layout: auto-enrich, disconnect, then generate
    menuItems.push({
      id: 'auto-enrich',
      label: 'Auto-enrich titles on sync',
      type: 'toggle',
      value: config.providers.claudeCode.autoEnrichSummaries,
      section: 'claude-code',
    });

    menuItems.push({
      id: 'disconnect',
      label: 'Disconnect',
      type: 'button',
      section: 'claude-code',
    });

    if (untitledCount > 0) {
      menuItems.push({
        id: 'generate',
        label: `Generate titles for ${untitledCount} untitled`,
        type: 'action',
        section: 'titles',
      });
    }
  } else if (config && credentialStatus?.isAuthenticated) {
    menuItems.push({
      id: 'connect',
      label: 'Connect',
      type: 'button',
      section: 'claude-code',
    });
  }

  const selectableItems = menuItems.filter((item) => !item.disabled);

  // Handle navigation
  const moveSelection = useCallback((delta: number) => {
    if (selectableItems.length === 0) return;
    setSelectedIndex((idx) => {
      const newIdx = idx + delta;
      if (newIdx < 0) return 0;
      if (newIdx >= selectableItems.length) return selectableItems.length - 1;
      return newIdx;
    });
  }, [selectableItems.length]);

  // Handle actions
  const handleAction = useCallback(async () => {
    if (!config) return;

    const item = selectableItems[selectedIndex];
    if (!item || item.disabled) return;

    try {
      if (item.id === 'connect') {
        const newConfig = updateProviderConfig('claudeCode', { enabled: true });
        setConfig(newConfig);
        setToast({ message: 'Connected to Claude Code', type: 'success' });
      } else if (item.id === 'disconnect') {
        const newConfig = updateProviderConfig('claudeCode', {
          enabled: false,
          autoEnrichSummaries: false,
        });
        setConfig(newConfig);
        setToast({ message: 'Disconnected', type: 'info' });
      } else if (item.id === 'auto-enrich') {
        const newConfig = updateProviderConfig('claudeCode', {
          autoEnrichSummaries: !config.providers.claudeCode.autoEnrichSummaries,
        });
        setConfig(newConfig);
      } else if (item.id === 'generate') {
        setGenerationProgress({
          completed: 0,
          total: untitledCount,
          inFlight: 0,
          recentTitles: [],
        });

        const result = await enrichUntitledConversations({
          onProgress: (progress) => setGenerationProgress(progress),
        });

        setGenerationProgress(null);

        const newCount = await conversationRepo.countUntitled();
        setUntitledCount(newCount);

        setToast({
          message: `Generated ${result.enriched} title${result.enriched === 1 ? '' : 's'}${result.failed > 0 ? `, ${result.failed} failed` : ''}`,
          type: result.failed > 0 ? 'error' : 'success',
        });
      }
    } catch (err) {
      setGenerationProgress(null);
      setToast({
        message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
        type: 'error',
      });
    }
  }, [config, selectableItems, selectedIndex, untitledCount]);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
      // Force exit to avoid hang
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (input === 'j' || key.downArrow) {
      moveSelection(1);
    } else if (input === 'k' || key.upArrow) {
      moveSelection(-1);
    }

    if (key.return || input === ' ') {
      handleAction();
    }
  });

  // Toast auto-dismiss
  useEffect(() => {
    if (toast && toast.type !== 'info') {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Spinner animation for generation
  useEffect(() => {
    if (!generationProgress) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % spinner.length), 80);
    return () => clearInterval(timer);
  }, [generationProgress, spinner.length]);

  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="cyan">Loading settings...</Text>
      </Box>
    );
  }

  const innerWidth = Math.max(60, width - 6);
  const cardWidth = innerWidth - 4;
  const subsectionWidth = cardWidth - 6;

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Outer top border */}
      <Box>
        <Text color="gray">┌{'─'.repeat(width - 2)}┐</Text>
      </Box>

      {/* Header */}
      <Box>
        <Text color="gray">│</Text>
        <Text>  </Text>
        <Text bold>⚙  Settings</Text>
        <Text>{' '.repeat(Math.max(0, width - 16))}</Text>
        <Text color="gray">│</Text>
      </Box>

      {/* Header divider */}
      <Box>
        <Text color="gray">├{'─'.repeat(width - 2)}┤</Text>
      </Box>

      {/* Empty line */}
      <Box>
        <Text color="gray">│</Text>
        <Text>{' '.repeat(width - 2)}</Text>
        <Text color="gray">│</Text>
      </Box>

      {/* Claude Code Card */}
      <Box>
        <Text color="gray">│</Text>
        <Text>  </Text>
        <Text color="gray">┌─ </Text>
        <Text bold>Claude Code</Text>
        <Text color="gray"> {'─'.repeat(Math.max(0, cardWidth - 16))}</Text>
        <Text>  </Text>
        <Text color="gray">│</Text>
      </Box>

      {/* Status row */}
      <Box>
        <Text color="gray">│  │  </Text>
        {claudeCodeConnected ? (
          <>
            <Text color="green">● Connected</Text>
            <Text>{' '.repeat(Math.max(0, cardWidth - 30))}</Text>
            <Text dimColor>{credentialStatus?.subscriptionType || ''}</Text>
          </>
        ) : (
          <>
            <Text color="yellow">○ Not connected</Text>
            <Text>{' '.repeat(Math.max(0, cardWidth - 16))}</Text>
          </>
        )}
        <Text color="gray">  │  │</Text>
      </Box>

      {/* Empty line in card */}
      <Box>
        <Text color="gray">│  │</Text>
        <Text>{' '.repeat(cardWidth)}</Text>
        <Text color="gray">│  │</Text>
      </Box>

      {/* Menu items in Claude Code card */}
      {selectableItems.filter(i => i.section === 'claude-code' || i.section === undefined).map((item) => {
        const actualIdx = selectableItems.indexOf(item);
        const isSelected = actualIdx === selectedIndex;
        const isDisconnect = item.id === 'disconnect';
        const labelLen = item.label.length + (item.type === 'toggle' ? 5 : 0);
        const padding = Math.max(0, cardWidth - labelLen - 4);

        return (
          <Box key={item.id}>
            <Text color="gray">│  │  </Text>
            <Text color={isSelected ? 'cyan' : 'white'}>{isSelected ? '▸ ' : '  '}</Text>
            {item.type === 'toggle' && (
              <Text color={item.value ? 'green' : 'gray'}>[{item.value ? '✓' : ' '}] </Text>
            )}
            <Text color={isSelected ? 'cyan' : isDisconnect ? 'red' : 'white'}>{item.label}</Text>
            <Text>{' '.repeat(padding)}</Text>
            <Text color="gray">│  │</Text>
          </Box>
        );
      })}

      {/* Titles subsection */}
      {claudeCodeConnected && (
        <>
          {/* Empty line */}
          <Box>
            <Text color="gray">│  │</Text>
            <Text>{' '.repeat(cardWidth)}</Text>
            <Text color="gray">│  │</Text>
          </Box>

          {/* Subsection header */}
          <Box>
            <Text color="gray">│  │  ╭─ </Text>
            <Text dimColor>Titles from past conversations</Text>
            <Text color="gray"> {'─'.repeat(Math.max(0, subsectionWidth - 32))}╮</Text>
            <Text color="gray">  │  │</Text>
          </Box>

          {generationProgress ? (
            <>
              {/* Progress bar */}
              <Box>
                <Text color="gray">│  │  │  </Text>
                <ProgressBar
                  current={generationProgress.completed}
                  total={generationProgress.total}
                  width={Math.min(40, subsectionWidth - 4)}
                />
                <Text>{' '.repeat(Math.max(0, subsectionWidth - 56))}</Text>
                <Text color="gray">│  │  │</Text>
              </Box>

              {/* Recent completions */}
              {generationProgress.recentTitles.slice(-3).map((item) => (
                <Box key={item.id}>
                  <Text color="gray">│  │  │  </Text>
                  <Text color="green">✓ </Text>
                  <Text>
                    {item.title.length > subsectionWidth - 8
                      ? item.title.slice(0, subsectionWidth - 11) + '...'
                      : item.title}
                  </Text>
                  <Text>{' '.repeat(Math.max(0, subsectionWidth - item.title.length - 4))}</Text>
                  <Text color="gray">│  │  │</Text>
                </Box>
              ))}

              {/* In-flight indicator */}
              {generationProgress.inFlight > 0 && (
                <Box>
                  <Text color="gray">│  │  │  </Text>
                  <Text color="cyan">{spinner[frame]} </Text>
                  <Text dimColor>{generationProgress.inFlight} generating...</Text>
                  <Text>{' '.repeat(Math.max(0, subsectionWidth - 20))}</Text>
                  <Text color="gray">│  │  │</Text>
                </Box>
              )}
            </>
          ) : untitledCount === 0 ? (
            <Box>
              <Text color="gray">│  │  │  </Text>
              <Text color="green">✓ </Text>
              <Text dimColor>All conversations have titles</Text>
              <Text>{' '.repeat(Math.max(0, subsectionWidth - 32))}</Text>
              <Text color="gray">│  │  │</Text>
            </Box>
          ) : (
            <>
              <Box>
                <Text color="gray">│  │  │  </Text>
                <Text dimColor>{untitledCount} untitled conversation{untitledCount === 1 ? '' : 's'} found</Text>
                <Text>{' '.repeat(Math.max(0, subsectionWidth - 30))}</Text>
                <Text color="gray">│  │  │</Text>
              </Box>
              {selectableItems.filter(i => i.section === 'titles').map((item) => {
                const actualIdx = selectableItems.indexOf(item);
                const isSelected = actualIdx === selectedIndex;

                return (
                  <Box key={item.id}>
                    <Text color="gray">│  │  │  </Text>
                    <Text color={isSelected ? 'cyan' : 'white'}>{isSelected ? '▸ ' : '  '}</Text>
                    <Text color={isSelected ? 'cyan' : 'blue'}>[Generate Now]</Text>
                    <Text>{' '.repeat(Math.max(0, subsectionWidth - 18))}</Text>
                    <Text color="gray">│  │  │</Text>
                  </Box>
                );
              })}
            </>
          )}

          {/* Subsection bottom */}
          <Box>
            <Text color="gray">│  │  ╰{'─'.repeat(subsectionWidth)}╯  │  │</Text>
          </Box>
        </>
      )}

      {/* Card bottom */}
      <Box>
        <Text color="gray">│  └{'─'.repeat(cardWidth)}┘  │</Text>
      </Box>

      {/* Empty line */}
      <Box>
        <Text color="gray">│</Text>
        <Text>{' '.repeat(width - 2)}</Text>
        <Text color="gray">│</Text>
      </Box>

      {/* Codex Card */}
      <Box>
        <Text color="gray">│</Text>
        <Text>  </Text>
        <Text color="gray">┌─ </Text>
        <Text bold>Codex</Text>
        <Text color="gray"> {'─'.repeat(Math.max(0, cardWidth - 9))}</Text>
        <Text>  </Text>
        <Text color="gray">│</Text>
      </Box>

      <Box>
        <Text color="gray">│  │  </Text>
        <Text color="yellow">○ Not connected</Text>
        <Text>{' '.repeat(Math.max(0, cardWidth - 28))}</Text>
        <Text dimColor>Coming soon</Text>
        <Text color="gray">  │  │</Text>
      </Box>

      <Box>
        <Text color="gray">│  └{'─'.repeat(cardWidth)}┘  │</Text>
      </Box>

      {/* Spacer rows */}
      <Box flexGrow={1} flexDirection="column">
        {Array.from({ length: Math.max(0, height - 25) }).map((_, i) => (
          <Box key={i}>
            <Text color="gray">│</Text>
            <Text>{' '.repeat(width - 2)}</Text>
            <Text color="gray">│</Text>
          </Box>
        ))}
      </Box>

      {/* Toast */}
      {toast && (
        <Box>
          <Text color="gray">│  </Text>
          <Text color={toast.type === 'success' ? 'green' : toast.type === 'error' ? 'red' : 'cyan'}>
            {toast.message}
          </Text>
          <Text>{' '.repeat(Math.max(0, width - toast.message.length - 5))}</Text>
          <Text color="gray">│</Text>
        </Box>
      )}

      {/* Footer divider */}
      <Box>
        <Text color="gray">├{'─'.repeat(width - 2)}┤</Text>
      </Box>

      {/* Footer */}
      <Box>
        <Text color="gray">│</Text>
        <Text>  </Text>
        <Text dimColor>↑↓</Text><Text> navigate  </Text>
        <Text dimColor>␣</Text><Text> toggle  </Text>
        <Text dimColor>⏎</Text><Text> select  </Text>
        <Text dimColor>q</Text><Text> quit</Text>
        <Text>{' '.repeat(Math.max(0, width - 46))}</Text>
        <Text color="gray">│</Text>
      </Box>

      {/* Outer bottom border */}
      <Box>
        <Text color="gray">└{'─'.repeat(width - 2)}┘</Text>
      </Box>
    </Box>
  );
}

export async function configCommand(): Promise<void> {
  if (!process.stdin.isTTY) {
    const config = loadConfig();
    console.log('\nDex Configuration:\n');
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  const app = withFullScreen(<ConfigApp />);
  await app.start();
  await app.waitUntilExit();
}
