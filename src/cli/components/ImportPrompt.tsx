/**
 * ImportPrompt component - shows "Found existing credentials" screen
 *
 * Displays available credential sources with option to import or skip.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ProviderStatusCard } from './ProviderCard.js';
import type { ExternalCredentialSource } from '../../providers/auth.js';

export interface ImportPromptProps {
  /** Available credential sources to display */
  sources: ExternalCredentialSource[];
  /** Currently selected option (0 = import, 1 = skip) */
  selectedIndex: number;
  /** Card width */
  width: number;
}

/**
 * Renders the import prompt screen with credential sources and action options
 */
export function ImportPrompt({ sources, selectedIndex, width }: ImportPromptProps) {
  const cardWidth = Math.max(50, width - 6);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>Found existing credentials</Text>
      </Box>

      {/* Credential source cards */}
      {sources.map((source) => (
        <Box key={source.name} marginBottom={1}>
          <ProviderStatusCard
            displayName={source.name}
            providers={source.providers.map((p) => ({
              name: p.displayName,
              subscriptionType: p.subscriptionType,
            }))}
            width={cardWidth}
          />
        </Box>
      ))}

      {/* Action options */}
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={selectedIndex === 0 ? 'cyan' : 'white'}>
            {selectedIndex === 0 ? '▸ ' : '  '}
          </Text>
          <Text color={selectedIndex === 0 ? 'cyan' : 'green'}>
            Import all and continue
          </Text>
        </Box>
        <Box>
          <Text color={selectedIndex === 1 ? 'cyan' : 'white'}>
            {selectedIndex === 1 ? '▸ ' : '  '}
          </Text>
          <Text color={selectedIndex === 1 ? 'cyan' : 'white'}>
            Set up fresh instead
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Minimal import prompt shown inline in chat flow
 */
export interface InlineImportPromptProps {
  /** Source name (e.g., "Claude Code CLI", "OpenCode") */
  sourceName: string;
  /** Providers available */
  providerNames: string[];
  /** Currently selected option */
  selectedIndex: number;
}

export function InlineImportPrompt({
  sourceName,
  providerNames,
  selectedIndex,
}: InlineImportPromptProps) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>Found credentials from </Text>
        <Text bold>{sourceName}</Text>
        <Text> ({providerNames.join(', ')})</Text>
      </Box>

      <Box flexDirection="column">
        <Box>
          <Text color={selectedIndex === 0 ? 'cyan' : 'white'}>
            {selectedIndex === 0 ? '▸ ' : '  '}
          </Text>
          <Text color={selectedIndex === 0 ? 'cyan' : 'green'}>
            Import and continue
          </Text>
        </Box>
        <Box>
          <Text color={selectedIndex === 1 ? 'cyan' : 'white'}>
            {selectedIndex === 1 ? '▸ ' : '  '}
          </Text>
          <Text color={selectedIndex === 1 ? 'cyan' : 'white'}>
            Set up fresh instead
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
