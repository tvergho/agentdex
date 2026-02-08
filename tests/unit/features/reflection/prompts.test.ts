import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt, buildUserMessage } from '../../../../src/features/reflection/prompts';

describe('buildSystemPrompt', () => {
  test('includes default 90-day window', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('last 90 days');
  });

  test('uses custom days option', () => {
    const prompt = buildSystemPrompt({ days: 30 });
    expect(prompt).toContain('last 30 days');
  });

  test('includes source filter when specified', () => {
    const prompt = buildSystemPrompt({ source: 'claude-code' });
    expect(prompt).toContain('claude-code');
  });

  test('mentions all four MCP tools', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('dex_stats');
    expect(prompt).toContain('dex_list');
    expect(prompt).toContain('dex_search');
    expect(prompt).toContain('dex_get');
  });

  test('includes output format markers', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('=== FILE:');
    expect(prompt).toContain('=== END FILE ===');
  });

  test('includes quality guidelines distinguishing conversation-derived vs code-derived', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('EXPERIENTIAL KNOWLEDGE');
    expect(prompt).toContain('DO NOT INCLUDE');
    expect(prompt).toContain('DO INCLUDE');
    expect(prompt).toContain('conversation-derived');
    expect(prompt).toContain('code-derivable');
    expect(prompt).toContain('Litmus Test');
  });

  test('instructs hierarchical CLAUDE.md generation', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('frontend/CLAUDE.md');
    expect(prompt).toContain('functions/CLAUDE.md');
    expect(prompt).toContain('every meaningful directory level');
  });

  test('instructs skill file generation', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('.claude/skills/');
    expect(prompt).toContain('description:');
    expect(prompt).toContain('kebab-case');
  });

  test('instructs context-aware reading with tail support', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('outline');
    expect(prompt).toContain('200K token context window');
    expect(prompt).toContain('max_tokens: 30000');
    expect(prompt).toContain('tail: true');
  });

  test('describes three-phase approach', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('Phase 1');
    expect(prompt).toContain('Phase 2');
    expect(prompt).toContain('Phase 3');
  });
});

describe('buildUserMessage', () => {
  test('includes project path', () => {
    const msg = buildUserMessage({ project: '/Users/me/myproject' });
    expect(msg).toContain('/Users/me/myproject');
  });

  test('uses "current project" when no project specified', () => {
    const msg = buildUserMessage({});
    expect(msg).toContain('current project');
  });

  test('includes days window', () => {
    const msg = buildUserMessage({ days: 30 });
    expect(msg).toContain('30 days');
  });

  test('defaults to 90 days', () => {
    const msg = buildUserMessage({});
    expect(msg).toContain('90 days');
  });

  test('includes source filter', () => {
    const msg = buildUserMessage({ source: 'cursor' });
    expect(msg).toContain('source: cursor');
  });

  test('includes existing CLAUDE.md for progressive update', () => {
    const existing = '# My Project\n\nExisting instructions here.';
    const msg = buildUserMessage({}, existing);
    expect(msg).toContain('progressive update');
    expect(msg).toContain('Existing instructions here.');
    expect(msg).toContain('EXISTING CLAUDE.md');
  });

  test('skips existing CLAUDE.md when force is true', () => {
    const existing = '# My Project\n\nExisting instructions here.';
    const msg = buildUserMessage({ force: true }, existing);
    expect(msg).not.toContain('progressive update');
    expect(msg).not.toContain('Existing instructions here.');
    expect(msg).toContain('fresh from scratch');
  });

  test('does not include existing content when null', () => {
    const msg = buildUserMessage({}, null);
    expect(msg).not.toContain('EXISTING CLAUDE.md');
  });

  test('instructs exhaustive survey with selective deep read', () => {
    const msg = buildUserMessage({});
    expect(msg).toContain('ALL conversations');
    expect(msg).toContain('every single one');
    expect(msg).toContain('outline');
    expect(msg).toContain('deep-read');
  });

  test('instructs experiential knowledge extraction', () => {
    const msg = buildUserMessage({});
    expect(msg).toContain('EXPERIENTIAL knowledge');
    expect(msg).toContain('=== FILE:');
  });
});
