import React, { useState, useEffect, useMemo } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { withFullScreen, useScreenSize } from 'fullscreen-ink';
import { connect } from '../../db/index.js';
import { search } from '../../db/repository.js';
import type { SearchResponse, ConversationResult, MessageMatch } from '../../schema/index.js';

interface SearchOptions {
  limit?: string;
}

function formatRelativeTime(isoDate: string | undefined): string {
  if (!isoDate) return '';

  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

function ResultRow({
  result,
  isSelected,
  width,
}: {
  result: ConversationResult;
  isSelected: boolean;
  width: number;
}) {
  const { conversation, bestMatch, totalMatches } = result;

  const metaWidth = 25;
  const prefixWidth = 2;
  const maxTitleWidth = Math.max(20, width - metaWidth - prefixWidth - 4);

  const title = conversation.title.length > maxTitleWidth
    ? conversation.title.slice(0, maxTitleWidth - 1) + '…'
    : conversation.title;

  const timeStr = formatRelativeTime(conversation.updatedAt);
  const matchStr = `${totalMatches} match${totalMatches !== 1 ? 'es' : ''}`;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
          {isSelected ? '▸ ' : '  '}
          {title}
        </Text>
        <Text dimColor> · {matchStr} · {timeStr}</Text>
      </Box>
      <Box marginLeft={4}>
        <Text dimColor wrap="truncate-end">
          {bestMatch.snippet.replace(/\n/g, ' ').slice(0, width - 6)}
        </Text>
      </Box>
    </Box>
  );
}

function ExpandedView({
  result,
  width,
  height,
  scrollOffset,
  selectedMatchIndex,
}: {
  result: ConversationResult;
  width: number;
  height: number;
  scrollOffset: number;
  selectedMatchIndex: number;
}) {
  const { conversation, matches } = result;

  const headerHeight = 3;
  const availableHeight = height - headerHeight;
  const matchesPerPage = Math.max(1, Math.floor(availableHeight / 4));

  const visibleMatches = matches.slice(scrollOffset, scrollOffset + matchesPerPage);

  return (
    <Box flexDirection="column" height={height}>
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">{conversation.title}</Text>
        <Text dimColor>
          {matches.length} match{matches.length !== 1 ? 'es' : ''} · ID: {conversation.id.slice(0, 16)}…
        </Text>
      </Box>

      {/* Matches */}
      <Box flexDirection="column" flexGrow={1}>
        {visibleMatches.map((match, idx) => {
          const actualIdx = scrollOffset + idx;
          const isSelected = actualIdx === selectedMatchIndex;

          return (
            <Box
              key={match.messageId}
              flexDirection="column"
              marginBottom={1}
              paddingLeft={1}
              borderStyle={isSelected ? 'single' : undefined}
              borderColor="cyan"
            >
              <Text>
                <Text color={match.role === 'user' ? 'green' : 'blue'} bold>
                  {match.role === 'user' ? 'You' : 'Assistant'}
                </Text>
                <Text dimColor> (message {match.messageIndex + 1})</Text>
              </Text>
              <Text wrap="truncate-end">
                {match.snippet.replace(/\n/g, ' ').slice(0, width - 6)}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Scroll indicator */}
      {matches.length > matchesPerPage && (
        <Text dimColor>
          {scrollOffset + 1}-{Math.min(scrollOffset + matchesPerPage, matches.length)} of {matches.length}
        </Text>
      )}
    </Box>
  );
}

function SearchApp({
  query,
  limit,
}: {
  query: string;
  limit: number;
}) {
  const { exit } = useApp();
  const { width, height } = useScreenSize();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [expandedScrollOffset, setExpandedScrollOffset] = useState(0);
  const [expandedSelectedMatch, setExpandedSelectedMatch] = useState(0);

  useEffect(() => {
    async function runSearch() {
      try {
        await connect();
        const result = await search(query, limit);
        setResponse(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    runSearch();
  }, [query, limit]);

  const headerHeight = 3;
  const footerHeight = 2;
  const rowHeight = 3;
  const availableHeight = height - headerHeight - footerHeight;
  const visibleCount = Math.max(1, Math.floor(availableHeight / rowHeight));

  const scrollOffset = useMemo(() => {
    if (!response) return 0;
    const maxOffset = Math.max(0, response.results.length - visibleCount);
    if (selectedIndex < visibleCount) return 0;
    return Math.min(selectedIndex - visibleCount + 1, maxOffset);
  }, [selectedIndex, visibleCount, response?.results.length]);

  const visibleResults = useMemo(() => {
    if (!response) return [];
    return response.results.slice(scrollOffset, scrollOffset + visibleCount);
  }, [response, scrollOffset, visibleCount]);

  const isExpanded = expandedIndex !== null;
  const expandedResult = isExpanded ? response?.results[expandedIndex] : null;

  useInput((input, key) => {
    if (input === 'q') {
      exit();
      return;
    }

    if (!response || response.results.length === 0) return;

    if (isExpanded && expandedResult) {
      // Expanded view navigation
      if (key.escape || key.backspace || key.delete) {
        // Close expanded view
        setExpandedIndex(null);
        setExpandedScrollOffset(0);
        setExpandedSelectedMatch(0);
      } else if (input === 'j' || key.downArrow) {
        // Navigate within matches
        const maxIdx = expandedResult.matches.length - 1;
        setExpandedSelectedMatch((i) => Math.min(i + 1, maxIdx));
        // Adjust scroll if needed
        const matchesPerPage = Math.max(1, Math.floor((height - 8) / 4));
        if (expandedSelectedMatch >= expandedScrollOffset + matchesPerPage - 1) {
          setExpandedScrollOffset((o) => Math.min(o + 1, Math.max(0, expandedResult.matches.length - matchesPerPage)));
        }
      } else if (input === 'k' || key.upArrow) {
        setExpandedSelectedMatch((i) => Math.max(i - 1, 0));
        if (expandedSelectedMatch <= expandedScrollOffset) {
          setExpandedScrollOffset((o) => Math.max(o - 1, 0));
        }
      } else if (key.return) {
        // Could open full conversation here in future
        // For now, just close
        setExpandedIndex(null);
        setExpandedScrollOffset(0);
        setExpandedSelectedMatch(0);
      }
    } else {
      // List view navigation
      if (input === 'j' || key.downArrow) {
        setSelectedIndex((i) => Math.min(i + 1, response.results.length - 1));
      } else if (input === 'k' || key.upArrow) {
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (key.return || input === 'o') {
        setExpandedIndex(selectedIndex);
        setExpandedScrollOffset(0);
        setExpandedSelectedMatch(0);
      }
    }
  });

  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="cyan">Searching for "{query}"...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box width={width} height={height} flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press q to exit</Text>
      </Box>
    );
  }

  if (!response) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text color="red">No response</Text>
      </Box>
    );
  }

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* Header */}
      <Box paddingX={1} marginBottom={1}>
        <Text bold>Search: </Text>
        <Text color="cyan">"{response.query}"</Text>
        <Text dimColor>
          {' '}— {response.totalConversations} conversation{response.totalConversations !== 1 ? 's' : ''}
          , {response.totalMessages} message{response.totalMessages !== 1 ? 's' : ''} ({response.searchTimeMs}ms)
        </Text>
      </Box>

      {/* Content */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {response.results.length === 0 ? (
          <Text dimColor>No results found.</Text>
        ) : isExpanded && expandedResult ? (
          <ExpandedView
            result={expandedResult}
            width={width - 2}
            height={availableHeight}
            scrollOffset={expandedScrollOffset}
            selectedMatchIndex={expandedSelectedMatch}
          />
        ) : (
          visibleResults.map((result, idx) => {
            const actualIndex = scrollOffset + idx;
            return (
              <Box key={result.conversation.id} marginBottom={1}>
                <ResultRow
                  result={result}
                  isSelected={actualIndex === selectedIndex}
                  width={width - 2}
                />
              </Box>
            );
          })
        )}
      </Box>

      {/* Scroll indicator for list view */}
      {!isExpanded && response.results.length > visibleCount && (
        <Box paddingX={1}>
          <Text dimColor>
            {scrollOffset + 1}-{Math.min(scrollOffset + visibleCount, response.results.length)} of {response.results.length}
          </Text>
        </Box>
      )}

      {/* Footer */}
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>
          {isExpanded
            ? 'j/k: navigate matches · Esc: back · q: quit'
            : 'j/k: navigate · Enter: expand · q: quit'
          }
        </Text>
      </Box>
    </Box>
  );
}

async function plainSearch(query: string, limit: number): Promise<void> {
  await connect();
  const result = await search(query, limit);

  console.log(`\nSearch: "${result.query}"`);
  console.log(
    `${result.totalConversations} conversation(s), ${result.totalMessages} message(s) (${result.searchTimeMs}ms)\n`
  );

  if (result.results.length === 0) {
    console.log('No results found.');
    return;
  }

  for (const r of result.results) {
    console.log(`${r.conversation.title} [${r.conversation.source}]`);
    console.log(`   ${r.totalMatches} match(es) · ${formatRelativeTime(r.conversation.updatedAt)}`);
    console.log(`   "${r.bestMatch.snippet.replace(/\n/g, ' ').slice(0, 100)}${r.bestMatch.snippet.length > 100 ? '...' : ''}"`);
    console.log(`   ID: ${r.conversation.id}`);
    console.log('');
  }
}

export async function searchCommand(query: string, options: SearchOptions): Promise<void> {
  const limit = parseInt(options.limit ?? '20', 10);

  if (!process.stdin.isTTY) {
    await plainSearch(query, limit);
    return;
  }

  const app = withFullScreen(<SearchApp query={query} limit={limit} />);
  await app.start();
  await app.waitUntilExit();
}
