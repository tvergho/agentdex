/**
 * Main reflect() orchestrator — thin 4-stage pipeline.
 *
 * Survey (programmatic) → Plan (deterministic) → Execute (parallel LLM) → Merge (instant)
 */

import { getDefaultProvider } from '../../providers/auth.js';
import { surveyProject } from './survey.js';
import { planTasks } from './plan.js';
import { executeTasks } from './execute.js';
import { mergeResults } from './merge.js';
import type { ReflectionOptions, ReflectionResult } from './types.js';

export async function reflect(options: ReflectionOptions): Promise<ReflectionResult> {
  // 1. Programmatic survey — no LLM needed
  const survey = await surveyProject(options);

  if (survey.conversationCount === 0) {
    return {
      files: [],
      summary: 'No conversations found for this project.',
      projectRoot: survey.projectRoot,
    };
  }

  // 2. Check provider is configured
  const provider = getDefaultProvider();
  if (!provider) {
    throw new Error('No provider configured. Run `dex config` to set up.');
  }

  // 3. Deterministic task planning — instant
  const tasks = planTasks(survey, options);

  if (tasks.length === 0) {
    return {
      files: [],
      summary: 'No tasks generated (0 conversations found).',
      projectRoot: survey.projectRoot,
    };
  }

  // 4. Parallel execution — one server, multiple sessions
  const taskResults = await executeTasks(tasks, options, survey, options.onProgress);

  // 5. Merge results — instant
  return mergeResults(taskResults, survey);
}
