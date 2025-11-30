/**
 * useExport hook - Encapsulates export modal state and logic
 *
 * Usage:
 * const {
 *   exportMode, exportActionIndex, statusMessage, statusType, statusVisible,
 *   setExportMode, handleExportInput, renderExportOverlay
 * } = useExport({ getConversations, width, height });
 */

import { useState, useCallback } from 'react';
import type { Conversation } from '../../schema/index';
import {
  exportConversationsToFile,
  exportConversationsToClipboard,
} from '../../utils/export-actions';

export type ExportMode = 'none' | 'action-menu';

export interface UseExportOptions {
  /** Function that returns the conversation(s) to export */
  getConversations: () => Conversation[] | Promise<Conversation[]>;
}

export interface UseExportResult {
  // State
  exportMode: ExportMode;
  exportActionIndex: number;
  statusMessage: string;
  statusType: 'success' | 'error';
  statusVisible: boolean;

  // Actions
  setExportMode: (mode: ExportMode) => void;
  openExportMenu: () => void;

  /**
   * Handle input when export menu is open
   * Returns true if the input was handled, false otherwise
   */
  handleExportInput: (input: string, key: { downArrow?: boolean; upArrow?: boolean; return?: boolean; escape?: boolean }) => boolean;
}

export function useExport({ getConversations }: UseExportOptions): UseExportResult {
  const [exportMode, setExportMode] = useState<ExportMode>('none');
  const [exportActionIndex, setExportActionIndex] = useState(0);

  // Status toast state
  const [statusMessage, setStatusMessage] = useState('');
  const [statusType, setStatusType] = useState<'success' | 'error'>('success');
  const [statusVisible, setStatusVisible] = useState(false);

  // Show status toast with auto-dismiss
  const showStatus = useCallback((message: string, type: 'success' | 'error') => {
    setStatusMessage(message);
    setStatusType(type);
    setStatusVisible(true);
    setTimeout(() => setStatusVisible(false), 3000);
  }, []);

  // Execute the selected export action
  const executeExportAction = useCallback(async () => {
    try {
      const convos = await getConversations();
      if (convos.length === 0) return;

      if (exportActionIndex === 0) {
        // Export to file
        const outputDir = await exportConversationsToFile(convos);
        showStatus(`Exported ${convos.length} to ${outputDir}`, 'success');
      } else if (exportActionIndex === 1) {
        // Copy to clipboard
        await exportConversationsToClipboard(convos);
        showStatus(`Copied ${convos.length} conversation(s)`, 'success');
      }
      setExportMode('none');
      setExportActionIndex(0);
    } catch (err) {
      showStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      setExportMode('none');
    }
  }, [getConversations, exportActionIndex, showStatus]);

  // Open export menu
  const openExportMenu = useCallback(() => {
    setExportMode('action-menu');
    setExportActionIndex(0);
  }, []);

  // Handle input when export menu is open
  const handleExportInput = useCallback((
    input: string,
    key: { downArrow?: boolean; upArrow?: boolean; return?: boolean; escape?: boolean }
  ): boolean => {
    if (exportMode !== 'action-menu') return false;

    if (input === 'j' || key.downArrow) {
      setExportActionIndex((i) => Math.min(i + 1, 1)); // Only 2 options (0-1)
      return true;
    }
    if (input === 'k' || key.upArrow) {
      setExportActionIndex((i) => Math.max(i - 1, 0));
      return true;
    }
    if (key.return) {
      executeExportAction();
      return true;
    }
    if (key.escape) {
      setExportMode('none');
      setExportActionIndex(0);
      return true;
    }

    return true; // Consume all input when modal is open
  }, [exportMode, executeExportAction]);

  return {
    exportMode,
    exportActionIndex,
    statusMessage,
    statusType,
    statusVisible,
    setExportMode,
    openExportMenu,
    handleExportInput,
  };
}
