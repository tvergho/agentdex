/**
 * ProviderCard component - displays a provider with status and action menu
 *
 * Used by both chat-setup.tsx and config.tsx for consistent provider UI.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface ProviderMenuItem {
  id: string;
  label: string;
  type: 'action' | 'info';
  color?: string;
}

export interface ProviderCardProps {
  /** Provider identifier */
  provider: 'anthropic' | 'openai' | 'more';
  /** Display name shown in card header */
  displayName: string;
  /** Connection status */
  status: 'connected' | 'available' | 'authenticating';
  /** Subscription type if connected (e.g., 'max', 'pro') */
  subscriptionType?: string;
  /** Menu items to display */
  menuItems: ProviderMenuItem[];
  /** Currently selected menu item ID */
  selectedItemId?: string;
  /** Whether this card is focused (has keyboard focus) */
  isFocused?: boolean;
  /** Auth progress info when authenticating */
  authProgress?: {
    spinner: string;
    message: string;
  };
  /** Card width */
  width: number;
}

/**
 * Renders a provider card with status, actions, and optional progress
 */
export function ProviderCard({
  displayName,
  status,
  subscriptionType,
  menuItems,
  selectedItemId,
  isFocused = true,
  authProgress,
  width,
}: ProviderCardProps) {
  const innerWidth = Math.max(0, width - 4);
  const headerPadding = Math.max(0, innerWidth - displayName.length - 3);

  return (
    <Box flexDirection="column">
      {/* Card header */}
      <Box>
        <Text color="gray">┌─ </Text>
        <Text bold>{displayName}</Text>
        <Text color="gray"> {'─'.repeat(headerPadding)}┐</Text>
      </Box>

      {/* Status row */}
      <Box>
        <Text color="gray">│  </Text>
        {status === 'connected' ? (
          <>
            <Text color="green">● Connected</Text>
            {subscriptionType && <Text dimColor> ({subscriptionType})</Text>}
          </>
        ) : status === 'authenticating' ? (
          <>
            <Text color="cyan">{authProgress?.spinner || '⠋'} </Text>
            <Text>{authProgress?.message || 'Authenticating...'}</Text>
          </>
        ) : (
          <Text color="yellow">○ Not connected</Text>
        )}
        <Text color="gray">{' '.repeat(Math.max(0, innerWidth - 20))}</Text>
        <Text color="gray">│</Text>
      </Box>

      {/* Spacer */}
      <Box>
        <Text color="gray">│</Text>
        <Text>{' '.repeat(innerWidth + 1)}</Text>
        <Text color="gray">│</Text>
      </Box>

      {/* Menu items */}
      {menuItems.map((item) => {
        const isSelected = isFocused && item.id === selectedItemId;
        const labelColor = item.color || (isSelected ? 'cyan' : 'white');

        return (
          <Box key={item.id}>
            <Text color="gray">│  </Text>
            <Text color={isSelected ? 'cyan' : 'white'}>
              {isSelected ? '▸ ' : '  '}
            </Text>
            <Text color={labelColor}>{item.label}</Text>
            <Text color="gray">
              {' '.repeat(Math.max(0, innerWidth - item.label.length - 4))}
            </Text>
            <Text color="gray">│</Text>
          </Box>
        );
      })}

      {/* Card bottom */}
      <Box>
        <Text color="gray">└{'─'.repeat(innerWidth + 1)}┘</Text>
      </Box>
    </Box>
  );
}

/**
 * A simpler version for displaying provider status without menu items
 */
export interface ProviderStatusCardProps {
  displayName: string;
  providers: Array<{
    name: string;
    subscriptionType?: string;
  }>;
  width: number;
}

export function ProviderStatusCard({
  displayName,
  providers,
  width,
}: ProviderStatusCardProps) {
  const innerWidth = Math.max(0, width - 4);
  const headerPadding = Math.max(0, innerWidth - displayName.length - 3);

  return (
    <Box flexDirection="column">
      {/* Card header */}
      <Box>
        <Text color="gray">┌─ </Text>
        <Text bold>{displayName}</Text>
        <Text color="gray"> {'─'.repeat(headerPadding)}┐</Text>
      </Box>

      {/* Provider badges */}
      <Box>
        <Text color="gray">│  </Text>
        {providers.map((p, i) => (
          <React.Fragment key={p.name}>
            {i > 0 && <Text>  </Text>}
            <Text color="green">● </Text>
            <Text>{p.name}</Text>
            {p.subscriptionType && <Text dimColor> ({p.subscriptionType})</Text>}
          </React.Fragment>
        ))}
        <Text color="gray">
          {' '.repeat(
            Math.max(
              0,
              innerWidth - providers.reduce((acc, p) => acc + p.name.length + (p.subscriptionType?.length || 0) + 6, 0)
            )
          )}
        </Text>
        <Text color="gray">│</Text>
      </Box>

      {/* Subtitle */}
      <Box>
        <Text color="gray">│  </Text>
        <Text dimColor>Available for import</Text>
        <Text color="gray">
          {' '.repeat(Math.max(0, innerWidth - 22))}
        </Text>
        <Text color="gray">│</Text>
      </Box>

      {/* Card bottom */}
      <Box>
        <Text color="gray">└{'─'.repeat(innerWidth + 1)}┘</Text>
      </Box>
    </Box>
  );
}
