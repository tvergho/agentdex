import { describe, expect, test } from 'bun:test';
import { parseReflectionOutput } from '../../../../src/features/reflection/output';

describe('parseReflectionOutput', () => {
  test('parses single file with markers', () => {
    const text = `=== FILE: CLAUDE.md ===
# My Project

Use TypeScript strict mode.
=== END FILE ===

Generated 1 file.`;

    const result = parseReflectionOutput(text);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe('CLAUDE.md');
    expect(result.files[0]!.content).toContain('# My Project');
    expect(result.files[0]!.content).toContain('Use TypeScript strict mode.');
    expect(result.summary).toContain('Generated 1 file');
  });

  test('parses multiple CLAUDE.md files at different directory levels', () => {
    const text = `=== FILE: CLAUDE.md ===
# Root instructions
=== END FILE ===

=== FILE: frontend/CLAUDE.md ===
# Frontend instructions
=== END FILE ===

=== FILE: functions/CLAUDE.md ===
# Backend instructions
=== END FILE ===

Generated 3 files for different scopes.`;

    const result = parseReflectionOutput(text);

    expect(result.files).toHaveLength(3);
    expect(result.files[0]!.path).toBe('CLAUDE.md');
    expect(result.files[1]!.path).toBe('frontend/CLAUDE.md');
    expect(result.files[2]!.path).toBe('functions/CLAUDE.md');
    expect(result.files[0]!.content).toContain('Root instructions');
    expect(result.files[1]!.content).toContain('Frontend instructions');
    expect(result.files[2]!.content).toContain('Backend instructions');
    expect(result.summary).toContain('Generated 3 files');
  });

  test('parses skill files in .claude/skills/', () => {
    const text = `=== FILE: .claude/skills/add-migration/SKILL.md ===
---
name: add-migration
description: Create a new database migration
user-invocable: true
---

# Add Migration

1. Create migration file
2. Run migration
=== END FILE ===

=== FILE: .claude/skills/deploy-staging/SKILL.md ===
---
name: deploy-staging
description: Deploy to staging environment
user-invocable: true
---

# Deploy Staging

1. Build
2. Push
=== END FILE ===`;

    const result = parseReflectionOutput(text);

    expect(result.files).toHaveLength(2);
    expect(result.files[0]!.path).toBe('.claude/skills/add-migration/SKILL.md');
    expect(result.files[1]!.path).toBe('.claude/skills/deploy-staging/SKILL.md');
    expect(result.files[0]!.content).toContain('description: Create a new database migration');
    expect(result.files[0]!.content).toContain('# Add Migration');
  });

  test('parses mix of CLAUDE.md and skill files', () => {
    const text = `=== FILE: CLAUDE.md ===
# Root
=== END FILE ===

=== FILE: frontend/CLAUDE.md ===
# Frontend
=== END FILE ===

=== FILE: .claude/skills/dev-setup/SKILL.md ===
---
name: dev-setup
description: Set up dev environment
user-invocable: true
---
# Dev Setup
=== END FILE ===

Generated 2 CLAUDE.md files and 1 skill.`;

    const result = parseReflectionOutput(text);

    expect(result.files).toHaveLength(3);
    expect(result.files[0]!.path).toBe('CLAUDE.md');
    expect(result.files[1]!.path).toBe('frontend/CLAUDE.md');
    expect(result.files[2]!.path).toBe('.claude/skills/dev-setup/SKILL.md');
  });

  test('treats entire text as CLAUDE.md when no markers found', () => {
    const text = `# My Project

This is a CLAUDE.md file without markers.

## Commands
- Run tests with \`bun test\``;

    const result = parseReflectionOutput(text);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe('CLAUDE.md');
    expect(result.files[0]!.content).toContain('# My Project');
    expect(result.files[0]!.content).toContain('Run tests with `bun test`');
  });

  test('handles empty text', () => {
    const result = parseReflectionOutput('');
    expect(result.files).toHaveLength(0);
  });

  test('handles whitespace-only text', () => {
    const result = parseReflectionOutput('   \n  \n  ');
    expect(result.files).toHaveLength(0);
  });

  test('extracts summary from text outside markers', () => {
    const text = `Here is what I found:

=== FILE: CLAUDE.md ===
# Instructions
=== END FILE ===

Key findings:
- The project uses TypeScript
- Tests run with bun`;

    const result = parseReflectionOutput(text);

    expect(result.files).toHaveLength(1);
    expect(result.summary).toContain('Here is what I found');
    expect(result.summary).toContain('Key findings');
  });

  test('handles file with trailing whitespace in marker', () => {
    const text = `=== FILE: CLAUDE.md   ===
Content here
=== END FILE ===`;

    const result = parseReflectionOutput(text);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe('CLAUDE.md');
  });

  test('file content is trimmed and ends with newline', () => {
    const text = `=== FILE: CLAUDE.md ===

  # Title

  Content with leading/trailing whitespace

=== END FILE ===`;

    const result = parseReflectionOutput(text);

    expect(result.files[0]!.content).toMatch(/^# Title/);
    expect(result.files[0]!.content).toEndWith('\n');
  });

  test('handles malformed markers (unclosed file)', () => {
    const text = `=== FILE: CLAUDE.md ===
# Content without end marker

Some more content`;

    const result = parseReflectionOutput(text);

    // Unclosed file is not added; entire text becomes fallback
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe('CLAUDE.md');
  });

  test('provides default summary with counts when no text outside markers', () => {
    const text = `=== FILE: CLAUDE.md ===
# Instructions
=== END FILE ===

=== FILE: .claude/skills/run-tests/SKILL.md ===
---
name: run-tests
description: Run tests
user-invocable: true
---
# Test
=== END FILE ===`;

    const result = parseReflectionOutput(text);

    expect(result.summary).toContain('1 CLAUDE.md');
    expect(result.summary).toContain('1 skill');
  });
});
