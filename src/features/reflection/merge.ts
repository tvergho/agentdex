/**
 * Merge results from parallel task executions.
 * Concatenates content for duplicate file paths (e.g., rules + pr-reviews both produce CLAUDE.md).
 */

import type { GeneratedFile, ReflectionResult, SurveyResult, TaskResult } from './types.js';

export function mergeResults(taskResults: TaskResult[], survey: SurveyResult): ReflectionResult {
  const fileMap = new Map<string, string[]>();
  const summaryParts: string[] = [];
  const errors: string[] = [];

  for (const result of taskResults) {
    if (result.status === 'success') {
      summaryParts.push(`${result.taskId}: ${result.summary}`);
      for (const file of result.files) {
        const existing = fileMap.get(file.path);
        if (existing) {
          existing.push(file.content);
        } else {
          fileMap.set(file.path, [file.content]);
        }
      }
    } else {
      errors.push(`${result.taskId}: ${result.error || 'unknown error'}`);
    }
  }

  // Build merged files — concatenate content for duplicate paths
  const files: GeneratedFile[] = [];
  for (const [path, contents] of fileMap) {
    files.push({
      path,
      content: contents.join('\n\n').trim() + '\n',
    });
  }

  // Build summary
  const parts: string[] = [];
  const claudeMds = files.filter((f) => f.path.endsWith('CLAUDE.md'));
  const skills = files.filter((f) => f.path.includes('.claude/skills/'));

  if (claudeMds.length > 0) parts.push(`${claudeMds.length} CLAUDE.md file(s)`);
  if (skills.length > 0) parts.push(`${skills.length} skill(s)`);

  let summary = `Generated ${parts.join(' and ')}`;

  if (errors.length > 0) {
    summary += `\n\nFailed tasks:\n${errors.map((e) => `  - ${e}`).join('\n')}`;
  }

  return {
    files,
    summary,
    projectRoot: survey.projectRoot,
  };
}
