/**
 * AuthenticatingView component - shows OAuth progress with spinner
 *
 * Displays authentication status, URL fallback, and cancel option.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface AuthenticatingViewProps {
  /** Provider being authenticated */
  provider: 'anthropic' | 'openai' | 'other';
  /** Display name for the provider */
  providerName: string;
  /** Current spinner frame character */
  spinner: string;
  /** Authorization URL for manual fallback */
  authUrl?: string;
  /** Width for layout */
  width: number;
}

/**
 * Renders the authenticating view with spinner and URL fallback
 */
export function AuthenticatingView({
  providerName,
  spinner,
  authUrl,
  width,
}: AuthenticatingViewProps) {
  // Truncate URL if too long
  const maxUrlLength = Math.max(40, width - 10);
  const displayUrl = authUrl
    ? authUrl.length > maxUrlLength
      ? authUrl.slice(0, maxUrlLength - 3) + '...'
      : authUrl
    : undefined;

  return (
    <Box flexDirection="column">
      {/* Spinner and status */}
      <Box marginBottom={1}>
        <Text color="cyan">{spinner} </Text>
        <Text>Signing in to {providerName}...</Text>
      </Box>

      {/* Instructions */}
      <Box flexDirection="column" marginBottom={1}>
        <Text>A browser window should open automatically.</Text>
        <Text>Complete the sign-in process there.</Text>
      </Box>

      {/* URL fallback */}
      {displayUrl && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>If the browser didn't open:</Text>
          <Text color="blue">{displayUrl}</Text>
        </Box>
      )}

      {/* Waiting indicator */}
      <Box>
        <Text dimColor>Waiting for authentication...</Text>
      </Box>
    </Box>
  );
}

/**
 * Compact version for inline display
 */
export interface InlineAuthenticatingProps {
  providerName: string;
  spinner: string;
}

export function InlineAuthenticating({
  providerName,
  spinner,
}: InlineAuthenticatingProps) {
  return (
    <Box>
      <Text color="cyan">{spinner} </Text>
      <Text>Signing in to {providerName}...</Text>
    </Box>
  );
}

/**
 * Success message after authentication
 */
export interface AuthSuccessProps {
  providerName: string;
}

export function AuthSuccess({ providerName }: AuthSuccessProps) {
  return (
    <Box>
      <Text color="green">✓ </Text>
      <Text>Connected to {providerName}</Text>
    </Box>
  );
}

/**
 * Error message after failed authentication
 */
export interface AuthErrorProps {
  message: string;
}

export function AuthError({ message }: AuthErrorProps) {
  return (
    <Box>
      <Text color="red">✗ </Text>
      <Text>{message}</Text>
    </Box>
  );
}
