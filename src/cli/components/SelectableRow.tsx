import React from 'react';
import { Text } from 'ink';

export function SelectionIndicator({ isSelected }: { isSelected: boolean }) {
  return (
    <Text
      backgroundColor={isSelected ? 'cyan' : undefined}
      color={isSelected ? 'black' : undefined}
    >
      {isSelected ? ' \u25B8 ' : '   '}
    </Text>
  );
}
