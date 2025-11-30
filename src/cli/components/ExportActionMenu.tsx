import React from 'react';
import { Box, Text } from 'ink';

export interface ExportActionMenuProps {
  selectedIndex: number;
  conversationCount: number;
  width: number;
  height: number;
}

const ACTIONS = [
  { label: 'Export to file', description: 'Save as markdown' },
  { label: 'Copy to clipboard', description: 'Copy markdown' },
];

/**
 * Centered modal overlay for export action selection
 * Uses gray background for better visibility against terminal backgrounds
 */
export function ExportActionMenu({
  selectedIndex,
  conversationCount,
  width,
  height,
}: ExportActionMenuProps) {
  const menuWidth = Math.min(40, width - 4);
  const menuHeight = 10;

  // Center the menu
  const leftPadding = Math.floor((width - menuWidth) / 2);
  const topPadding = Math.floor((height - menuHeight) / 2);

  const title =
    conversationCount === 1
      ? 'Export conversation'
      : `Export ${conversationCount} conversations`;

  const innerWidth = menuWidth - 2;

  // Build each row as a complete string with consistent width
  const buildRow = (content: string, bgColor: string = 'gray', fgColor: string = 'white') => {
    const padded = content.padEnd(innerWidth);
    return (
      <Text>
        <Text backgroundColor="gray" color="white">│</Text>
        <Text backgroundColor={bgColor as any} color={fgColor as any}>{padded}</Text>
        <Text backgroundColor="gray" color="white">│</Text>
      </Text>
    );
  };

  return (
    <Box
      position="absolute"
      marginLeft={leftPadding}
      marginTop={topPadding}
      width={menuWidth}
      flexDirection="column"
    >
      {/* Top border */}
      <Text backgroundColor="gray" color="white">
        {'┌' + '─'.repeat(innerWidth) + '┐'}
      </Text>

      {/* Title */}
      {buildRow(' ' + title)}

      {/* Divider */}
      <Text backgroundColor="gray" color="white">
        {'├' + '─'.repeat(innerWidth) + '┤'}
      </Text>

      {/* Actions */}
      {ACTIONS.map((action, idx) => {
        const isSelected = idx === selectedIndex;
        const prefix = isSelected ? ' ▸ ' : '   ';
        const label = prefix + action.label;
        const desc = '     ' + action.description;

        return (
          <React.Fragment key={action.label}>
            {isSelected ? (
              <>
                {buildRow(label, 'cyan', 'black')}
                {buildRow(desc, 'cyan', 'black')}
              </>
            ) : (
              <>
                {buildRow(label, 'gray', 'white')}
                {buildRow(desc, 'gray', 'white')}
              </>
            )}
          </React.Fragment>
        );
      })}

      {/* Divider */}
      <Text backgroundColor="gray" color="white">
        {'├' + '─'.repeat(innerWidth) + '┤'}
      </Text>

      {/* Footer - simpler approach */}
      {buildRow(' Enter select · Esc cancel')}

      {/* Bottom border */}
      <Text backgroundColor="gray" color="white">
        {'└' + '─'.repeat(innerWidth) + '┘'}
      </Text>
    </Box>
  );
}
