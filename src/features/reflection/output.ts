/**
 * Parse LLM response into files and write them to disk
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { GeneratedFile, ReflectionOptions, ReflectionResult } from './types.js';

const FILE_START = /^=== FILE:\s*(.+?)\s*===$/;
const FILE_END = /^=== END FILE ===$/;

/**
 * Parse file markers from the LLM's text output.
 * Returns extracted files and any text outside markers as summary.
 */
export function parseReflectionOutput(text: string): {
  files: GeneratedFile[];
  summary: string;
} {
  const lines = text.split('\n');
  const files: GeneratedFile[] = [];
  const summaryLines: string[] = [];

  let currentFile: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const startMatch = line.match(FILE_START);
    const endMatch = FILE_END.test(line);

    if (startMatch && !currentFile) {
      currentFile = startMatch[1]!;
      currentContent = [];
    } else if (endMatch && currentFile) {
      files.push({
        path: currentFile,
        content: currentContent.join('\n').trim() + '\n',
      });
      currentFile = null;
      currentContent = [];
    } else if (currentFile) {
      currentContent.push(line);
    } else {
      summaryLines.push(line);
    }
  }

  // If no file markers found, treat entire text as a single CLAUDE.md
  if (files.length === 0 && text.trim()) {
    files.push({
      path: 'CLAUDE.md',
      content: text.trim() + '\n',
    });
    return { files, summary: 'Generated CLAUDE.md from analysis' };
  }

  const summary = summaryLines
    .join('\n')
    .trim()
    .replace(/^\n+|\n+$/g, '');

  return { files, summary: summary || buildDefaultSummary(files) };
}

function buildDefaultSummary(files: GeneratedFile[]): string {
  const claudeMds = files.filter((f) => f.path.endsWith('CLAUDE.md'));
  const skills = files.filter((f) => f.path.includes('.claude/skills/'));
  const parts: string[] = [];

  if (claudeMds.length > 0) {
    parts.push(`${claudeMds.length} CLAUDE.md file(s)`);
  }
  if (skills.length > 0) {
    parts.push(`${skills.length} skill(s)`);
  }

  return `Generated ${parts.join(' and ')}`;
}

/**
 * Write reflection files to disk, or output to stdout/JSON.
 */
export function writeReflectionFiles(
  result: ReflectionResult,
  options: ReflectionOptions,
): void {
  if (result.files.length === 0) {
    console.log('No files generated.');
    return;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          files: result.files,
          summary: result.summary,
          projectRoot: result.projectRoot,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (options.dryRun) {
    for (const file of result.files) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`File: ${file.path}`);
      console.log('─'.repeat(60));
      console.log(file.content);
    }
    console.log(`\n${result.summary}`);
    return;
  }

  const baseDir = options.output || result.projectRoot;

  const claudeMds: string[] = [];
  const skills: string[] = [];

  for (const file of result.files) {
    const absPath = join(baseDir, file.path);
    const dir = dirname(absPath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(absPath, file.content, 'utf-8');

    if (file.path.includes('.claude/skills/')) {
      skills.push(file.path);
    } else {
      claudeMds.push(file.path);
    }
  }

  // Print summary grouped by type
  if (claudeMds.length > 0) {
    console.log(`\n  CLAUDE.md files:`);
    for (const p of claudeMds) {
      console.log(`    ${p}`);
    }
  }
  if (skills.length > 0) {
    console.log(`\n  Skills:`);
    for (const p of skills) {
      console.log(`    ${p}`);
    }
  }

  console.log(`\n${result.summary}`);
}
