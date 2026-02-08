/**
 * Parallel session execution against one OpenCode server.
 *
 * Starts ONE server, runs all tasks as independent sessions via Promise.allSettled,
 * and kills the server in finally.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'os';
import * as http from 'node:http';
import {
  getDexCredentials,
  importCredentials,
} from '../../providers/auth.js';
import {
  startServer,
  type OpenCodeServerState,
} from '../../providers/claude-code/client.js';
import {
  PLUGIN_VERSION,
  OPENCODE_CODEX_CONFIG,
} from '../../providers/codex/setup.js';
import { buildTaskPrompt } from './prompts.js';
import { parseReflectionOutput } from './output.js';
import type {
  ReflectionOptions,
  ReflectionTask,
  SurveyResult,
  TaskResult,
  ProgressCallback,
} from './types.js';

// Isolated OpenCode directories for reflect sessions
const DEX_OPENCODE_HOME = join(homedir(), '.dex', 'opencode');
const DEX_XDG_CONFIG = join(DEX_OPENCODE_HOME, 'config');
const DEX_XDG_DATA = join(DEX_OPENCODE_HOME, 'data');
const OPENCODE_CONFIG_DIR = join(DEX_XDG_CONFIG, 'opencode');
const OPENCODE_AUTH_FILE = join(DEX_XDG_DATA, 'opencode', 'auth.json');

// --- Helpers moved from index.ts ---

interface SessionResponse {
  id: string;
}

interface MessagePart {
  type: string;
  text?: string;
}

interface MessageInfo {
  error?: unknown;
}

interface PromptResponse {
  info?: MessageInfo;
  parts?: MessagePart[];
}

/**
 * Detect provider from model ID.
 */
export function detectProvider(modelId: string): 'openai' | 'anthropic' {
  if (modelId.startsWith('gpt-') || modelId.includes('codex')) {
    return 'openai';
  }
  return 'anthropic';
}

/**
 * Write OpenCode config + auth files so the server process picks them up.
 */
export async function writeServerConfig(modelOverride?: string): Promise<void> {
  mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
  mkdirSync(join(DEX_XDG_DATA, 'opencode'), { recursive: true });

  await importCredentials('anthropic');
  await importCredentials('openai');

  const anthropicCreds = getDexCredentials('anthropic');
  const openaiCreds = getDexCredentials('openai');

  const resolvedModel = modelOverride || 'claude-opus-4-6';
  const provider = detectProvider(resolvedModel);

  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      dex: {
        type: 'local',
        command: ['dex', 'serve'],
        enabled: true,
        timeout: 10000,
      },
    },
  };

  if (openaiCreds) {
    config.plugin = [`opencode-openai-codex-auth@${PLUGIN_VERSION}`];
    config.provider = {
      ...OPENCODE_CODEX_CONFIG.provider,
      anthropic: {},
    };
  } else if (anthropicCreds) {
    config.provider = { anthropic: {} };
  }

  config.model = `${provider}/${resolvedModel}`;

  const configPath = join(OPENCODE_CONFIG_DIR, 'opencode.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const authData: Record<string, unknown> = {};
  if (anthropicCreds) {
    authData.anthropic = {
      type: 'oauth',
      access: anthropicCreds.access,
      refresh: anthropicCreds.refresh,
      expires: anthropicCreds.expires,
    };
  }
  if (openaiCreds) {
    authData.openai = {
      type: 'oauth',
      access: openaiCreds.access,
      refresh: openaiCreds.refresh,
      expires: openaiCreds.expires,
    };
  }

  writeFileSync(OPENCODE_AUTH_FILE, JSON.stringify(authData, null, 2));
}

/**
 * HTTP POST with no timeout (for long-running agentic prompts).
 */
function httpPost(url: string, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const postData = JSON.stringify(body);

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 0,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(data);
          }
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(0);
    req.write(postData);
    req.end();
  });
}

// --- Server lifecycle ---

async function startAndWaitForServer(): Promise<OpenCodeServerState> {
  const serverState = await startServer({
    xdgConfigHome: DEX_XDG_CONFIG,
    xdgDataHome: DEX_XDG_DATA,
  });

  const stderrChunks: string[] = [];
  serverState.process.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
  });

  // Wait for server to fully initialize
  const maxWait = 15000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const check = await fetch(`${serverState.url}/session`);
      if (check.ok) return serverState;
    } catch {
      // Server not ready yet
    }
    if (serverState.process.exitCode !== null) {
      const stderr = stderrChunks.join('');
      throw new Error(
        `OpenCode server exited with code ${serverState.process.exitCode}. Stderr: ${stderr.slice(-2000)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return serverState;
}

/**
 * Fetch ALL messages from a session and extract text parts.
 * Used as fallback when the final response doesn't contain file markers
 * (the LLM may have output them in an earlier agentic turn).
 */
async function collectAllSessionText(
  baseUrl: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/session/${sessionId}/message`);
    if (!res.ok) return null;

    const messages = (await res.json()) as Array<{
      role?: string;
      parts?: MessagePart[];
    }>;

    const textParts: string[] = [];
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      for (const part of msg.parts ?? []) {
        if (part.type === 'text' && part.text) {
          textParts.push(part.text);
        }
      }
    }

    return textParts.length > 0 ? textParts.join('\n') : null;
  } catch {
    return null;
  }
}

// --- Single task execution ---

async function executeTask(
  baseUrl: string,
  task: ReflectionTask,
  options: ReflectionOptions,
  survey: SurveyResult,
): Promise<TaskResult> {
  const start = Date.now();

  try {
    // Create session
    const sessionRes = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!sessionRes.ok) {
      throw new Error(`Failed to create session: ${sessionRes.status}`);
    }

    const session = (await sessionRes.json()) as SessionResponse;

    // Build task-specific prompt
    const { system, user } = buildTaskPrompt(task, options, survey);
    const modelId = options.model || 'claude-opus-4-6';
    const providerID = detectProvider(modelId);

    const promptBody: Record<string, unknown> = {
      system,
      model: {
        providerID,
        modelID: modelId,
      },
      parts: [{ type: 'text', text: user }],
    };

    // Send via httpPost (no timeout)
    const responseText = await httpPost(
      `${baseUrl}/session/${session.id}/message`,
      promptBody,
    );

    if (!responseText || !responseText.trim()) {
      throw new Error(`Server returned empty response for task ${task.id}`);
    }

    let result: PromptResponse;
    try {
      result = JSON.parse(responseText) as PromptResponse;
    } catch {
      throw new Error(
        `Failed to parse response for task ${task.id}: ${responseText.slice(0, 500)}`,
      );
    }

    // Extract text from response parts
    const allParts = result.parts ?? [];
    const textContent = allParts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text!)
      .join('\n');

    if (!textContent.trim()) {
      if (result.info?.error) {
        throw new Error(`LLM error for task ${task.id}: ${JSON.stringify(result.info.error)}`);
      }
      throw new Error(`LLM returned empty response for task ${task.id}`);
    }

    // Parse file markers from output
    let parsed = parseReflectionOutput(textContent);

    // Fallback: if no file markers found in the final response, fetch ALL session
    // messages and scan them. The LLM may have output markers in an earlier turn
    // during the agentic loop.
    if (parsed.files.length === 0 || (parsed.files.length === 1 && !parsed.files[0]!.path.includes('/'))) {
      const allText = await collectAllSessionText(baseUrl, session.id);
      if (allText) {
        const fullParsed = parseReflectionOutput(allText);
        if (fullParsed.files.length > parsed.files.length) {
          parsed = fullParsed;
        }
      }
    }

    return {
      taskId: task.id,
      status: 'success',
      files: parsed.files,
      summary: parsed.summary || `Completed ${task.label}`,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      taskId: task.id,
      status: 'error',
      files: [],
      summary: '',
      error: message,
      durationMs: Date.now() - start,
    };
  }
}

// --- Public API ---

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const remainingSecs = secs % 60;
  if (mins > 0) return `${mins}m ${remainingSecs}s`;
  return `${secs}s`;
}

// Max concurrent LLM sessions to avoid API rate limits
const MAX_CONCURRENCY = 5;

// Per-task timeouts — Opus is ~2x slower than Sonnet per agentic turn
const CORE_TASK_TIMEOUT_MS = 15 * 60 * 1000; // 15 min for rules, skills, pr-reviews
const DIR_TASK_TIMEOUT_MS = 8 * 60 * 1000;   // 8 min for directory tasks

/**
 * Wrap a task with a timeout. Returns an error TaskResult if the timeout fires.
 */
function withTimeout(
  taskPromise: Promise<TaskResult>,
  taskId: string,
  timeoutMs: number,
): Promise<TaskResult> {
  return Promise.race([
    taskPromise,
    new Promise<TaskResult>((resolve) => {
      setTimeout(() => {
        resolve({
          taskId,
          status: 'error',
          files: [],
          summary: '',
          error: `Task timed out after ${Math.round(timeoutMs / 1000)}s`,
          durationMs: timeoutMs,
        });
      }, timeoutMs);
    }),
  ]);
}

/**
 * Run async tasks with a concurrency limit.
 */
async function runWithConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<unknown>,
  limit: number,
): Promise<void> {
  const executing = new Set<Promise<unknown>>();

  for (const item of items) {
    const p = fn(item).then(() => { executing.delete(p); });
    executing.add(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
}

/**
 * Execute all tasks against one OpenCode server with concurrency limiting.
 */
export async function executeTasks(
  tasks: ReflectionTask[],
  options: ReflectionOptions,
  survey: SurveyResult,
  onProgress?: ProgressCallback,
): Promise<TaskResult[]> {
  // Write config + auth and start server
  await writeServerConfig(options.model);

  let serverState: OpenCodeServerState;
  try {
    serverState = await startAndWaitForServer();
  } catch (error) {
    throw new Error(`Failed to start OpenCode server: ${error}`);
  }

  const baseUrl = serverState.url;

  try {
    const results: TaskResult[] = [];

    await runWithConcurrency(
      tasks,
      async (task) => {
        onProgress?.(task.id, 'started');

        const timeout = task.kind === 'directory' ? DIR_TASK_TIMEOUT_MS : CORE_TASK_TIMEOUT_MS;
        const result = await withTimeout(
          executeTask(baseUrl, task, options, survey),
          task.id,
          timeout,
        );
        results.push(result);

        if (result.status === 'success') {
          onProgress?.(task.id, 'completed', formatDuration(result.durationMs));
        } else {
          onProgress?.(task.id, 'failed', result.error);
        }
      },
      MAX_CONCURRENCY,
    );

    return results;
  } finally {
    serverState.process.kill();
  }
}
