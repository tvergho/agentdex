/**
 * CLI command handler for `dex reflect`
 *
 * Analyzes conversations to generate CLAUDE.md files using parallel agentic LLM sessions.
 * Calls pipeline stages directly for richer progress output.
 */

import {
  hasDexCredentials,
  hasExternalCredentials,
  importAllCredentials,
} from '../../providers/auth.js';
import { getDefaultProvider } from '../../providers/auth.js';
import { surveyProject } from '../../features/reflection/survey.js';
import { planTasks } from '../../features/reflection/plan.js';
import { executeTasks } from '../../features/reflection/execute.js';
import { mergeResults } from '../../features/reflection/merge.js';
import { writeReflectionFiles } from '../../features/reflection/output.js';
import type { ProgressCallback } from '../../features/reflection/types.js';

interface ReflectCliOptions {
  days?: string;
  source?: string;
  output?: string;
  dryRun?: boolean;
  json?: boolean;
  force?: boolean;
  model?: string;
  prs?: boolean;
}

export async function reflectCommand(
  project: string | undefined,
  options: ReflectCliOptions,
): Promise<void> {
  // 1. Credential check
  if (!hasDexCredentials()) {
    if (hasExternalCredentials()) {
      console.log('Importing credentials...');
      const { imported } = await importAllCredentials();
      if (imported.length === 0) {
        console.error('Failed to import credentials. Run `dex config` to set up.');
        process.exit(1);
      }
      console.log(`Imported credentials for: ${imported.join(', ')}`);
    } else {
      console.error('No credentials found. Run `dex config` to set up a provider.');
      process.exit(1);
    }
  }

  const days = options.days ? parseInt(options.days, 10) : undefined;
  const isJson = !!options.json;

  try {
    // 2. Survey
    const reflectOpts = {
      project,
      days,
      source: options.source,
      output: options.output,
      dryRun: options.dryRun,
      json: options.json,
      force: options.force,
      model: options.model,
      noPrs: options.prs === false,
    };

    const survey = await surveyProject(reflectOpts);

    if (!isJson) {
      const daysLabel = days ?? 90;
      const dirCount = survey.majorDirectories.length;
      const ghLabel = survey.githubRepo ? `, GitHub: ${survey.githubRepo}` : '';
      console.log(`Analyzing ${survey.projectRoot} (last ${daysLabel} days)...`);
      console.log(`Survey: ${survey.conversationCount} conversations, ${dirCount} directories${ghLabel}`);
    }

    if (survey.conversationCount === 0) {
      if (isJson) {
        console.log(JSON.stringify({ files: [], summary: 'No conversations found.', projectRoot: survey.projectRoot }, null, 2));
      } else {
        console.log('No conversations found for this project.');
      }
      return;
    }

    // 3. Check provider
    const provider = getDefaultProvider();
    if (!provider) {
      console.error('No provider configured. Run `dex config` to set up.');
      process.exit(1);
    }

    // 4. Plan
    const tasks = planTasks(survey, reflectOpts);

    if (!isJson) {
      console.log(`Tasks: ${tasks.length}\n`);
    }

    if (tasks.length === 0) {
      if (isJson) {
        console.log(JSON.stringify({ files: [], summary: 'No tasks generated.', projectRoot: survey.projectRoot }, null, 2));
      } else {
        console.log('No tasks generated.');
      }
      return;
    }

    // 5. Execute with progress
    const onProgress: ProgressCallback | undefined = isJson
      ? undefined
      : (taskId, status, detail) => {
          const icon = status === 'started' ? '\u27F3' : status === 'completed' ? '\u2713' : '\u2717';
          const suffix = detail ? ` (${detail})` : '';
          console.log(`  ${icon} ${taskId}${suffix}`);
        };

    const taskResults = await executeTasks(tasks, reflectOpts, survey, onProgress);

    // 6. Merge
    const result = mergeResults(taskResults, survey);

    // 7. Write output
    writeReflectionFiles(result, {
      ...options,
      days,
      project,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nReflection failed: ${message}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    if (error instanceof Error && 'cause' in error) {
      console.error('Cause:', error.cause);
    }
    process.exit(1);
  }
}
