/**
 * System prompts and user messages for reflection sessions.
 *
 * Keeps old buildSystemPrompt() / buildUserMessage() for backward compatibility
 * with existing tests. Adds new task-specific prompt builders for the parallel pipeline.
 */

import type {
  ReflectionOptions,
  ReflectionTask,
  SurveyResult,
} from './types.js';

// ============================================================================
// NEW: Task-specific prompt builders for parallel pipeline
// ============================================================================

/**
 * Base instructions shared across all task types.
 * Covers MCP tools, output format, and quality guidelines.
 */
function buildBaseInstructions(options: ReflectionOptions): string {
  const days = options.days ?? 90;

  return `## Available MCP Tools

You have access to these dex MCP tools:

- **dex_stats** — Overview statistics (conversation counts, date ranges, sources, top projects)
- **dex_list** — Browse conversations by filters (project, source, date range, branch). Supports limit/offset pagination.
- **dex_search** — Search conversation content by keywords. Supports file path filtering.
- **dex_get** — Retrieve conversation content. Formats: \`stripped\` (no tool outputs — use this), \`outline\` (summary), \`user_only\`, \`full\`. Supports \`max_tokens\` to cap large conversations. **IMPORTANT**: Use \`tail: true\` with \`max_tokens\` to read the END of conversations — this is where conclusions, fixes, and architecture decisions live.
- **dex_pr_reviews** — Browse and read GitHub PR review comments. List mode (no number): returns PR titles, review decisions, comment counts. Detail mode (with number): returns full review bodies and comments.

## Reading Strategy

1. Call dex_stats to understand the landscape
2. Call dex_list with limit=50 repeatedly (incrementing offset) to page through ALL conversations for this project${options.source ? ` from source "${options.source}"` : ''}
3. Read ALL conversations using dex_get with \`outline\` format first — this is very compact
4. **Keyword scan for user behavioral patterns:** Before deep-reading, use dex_search to scan ALL conversations for common user correction keywords. Run searches for terms like:
   - "simplify" / "too complex" / "overcomplicated"
   - "remove comments" / "no comments" / "unnecessary comments"
   - "parallelize" / "concurrent" / "in parallel"
   - "existing util" / "already have" / "don't reinvent" / "reuse"
   - "remove debug" / "remove logging" / "clean up"
   - "DRY" / "deduplicate" / "duplicated code"
   - "don't add" / "unnecessary" / "remove the" / "I said"

   For each search hitting 5+ conversations, that keyword represents a high-frequency user behavioral pattern. Use dex_get with \`user_only\` format on 2-3 representative hits to understand the exact preference. These patterns become Agent Instructions in the output.
5. Deep-read the top **15-20 most informative conversations** using \`stripped\` format with \`max_tokens: 30000\`
   - For short conversations (<30K tokens): read without max_tokens
   - For long conversations (>30K tokens): Use \`tail: true\` with \`max_tokens: 30000\` to read the ENDING
6. Prioritize conversations with debugging sessions, architecture decisions, error messages, performance issues
7. **Batch dex_get calls with at most 3-5 IDs at a time** to avoid exceeding response limits

## Analysis Guidelines

- Analyze the last ${days} days of conversations
- Frequency threshold: 2+ conversations for conventions/patterns; 1+ for commands/architecture/skills
- Be **evidence-based** — only include what you observed in actual conversations
- Be **root-cause oriented** — explain why, not just what

## Output Format — CRITICAL

You are operating in an agentic loop where only your LAST message is captured. All earlier messages are discarded. This means:

**You MUST include ALL file contents with markers in your VERY LAST message.**

Do NOT output file markers during intermediate tool-calling turns. Collect your analysis first, then output everything at the end in ONE message.

Use these exact markers (NOT inside code fences, NOT indented):

=== FILE: path/to/file.md ===
(file content)
=== END FILE ===

Rules:
- The content between markers IS the file written to disk. It must be complete and ready to use.
- After ALL file markers, include a brief summary of what you generated.
- If your response does not include === FILE: markers, the output will be MALFORMED and nothing will be saved.
- If your context is getting large, generate output immediately with what you have.
- NEVER say "I've already output the files above" — if markers aren't in THIS message, they are LOST.`;
}

/**
 * Quality instructions for pattern extraction — drives the reference-document-level detail.
 */
function buildPatternQualityInstructions(): string {
  return `## Pattern Quality Requirements — CRITICAL

You are NOT generating codebase documentation. Your unique value is **EXPERIENTIAL KNOWLEDGE from conversations** — things developers learned by working with the code.

### The Litmus Test
For every rule you write, ask: **"Would I need to read conversation history to know this, or could I figure it out from the code alone?"** If the answer is "from the code alone", DELETE IT — UNLESS the pattern appears as a repeated user correction in 5+ conversations. High-frequency user corrections represent preferences that are invisible in the codebase (e.g., "keep it simple", "no comments", "use existing utils"). These are extremely valuable because they must be re-taught every session without CLAUDE.md.

### DO NOT INCLUDE (code-derivable):
- "Uses React with TypeScript" — obvious from package.json
- "Tests run with npm test" — obvious from scripts
- Basic tech stack listings without context
- Standard framework patterns

### DO INCLUDE (conversation-derived):
- **Bugs that bit developers** with exact error messages and fixes
- **Architecture decisions with WHY** — what constraints drove the decision
- **Non-obvious commands and flags** developers actually used
- **Performance measurements** — before/after numbers, batch sizes, timeouts
- **Workarounds for library/framework bugs** with specific patches
- **Gotchas that caused real issues** — saves hours of debugging
- **Code review patterns** reviewers consistently enforce
- **Stylistic conventions the team enforces** — coding style rules that developers or reviewers repeatedly correct (e.g., "always use X instead of Y", "never do Z"). These often have the HIGHEST frequency because they apply to every change.
- **Process conventions** — how the team expects things to be done (naming, file organization, commit style, cleanup steps)
- **User behavioral patterns (repeated corrections)** — Instructions users give the AI agent repeatedly: "simplify this", "remove the comments", "use the existing util", "parallelize this", "remove debug logging", "DRY this up". Each represents a standing preference the agent should follow automatically. These often have the HIGHEST frequency (20-60+ occurrences) because users must re-teach them every session.

### Prioritize by Frequency

Start with the **highest-frequency patterns first**. If developers corrected the same thing 20+ times, that pattern is more valuable than a one-off architecture decision. Look especially for:
- Repeated corrections or reminders across many conversations
- Rules that developers keep re-learning or forgetting
- Conventions that apply broadly (to every file, every PR, every feature)
- User behavioral patterns (corrections/instructions repeated in 5+ conversations) — look for phrases like "I told you", "always", "don't", "stop doing", "I prefer", "why did you", "too many", "unnecessary"

### Output Structure for Each Pattern

For EACH coding pattern or rule you extract, structure it as:

**Pattern N: Descriptive Title**

**Frequency:** N+ conversations

**Rule Specification:**
Clear, direct explanation of the rule. Then code examples:

\`\`\`language
// ❌ BAD — what developers kept doing wrong
bad_code_example

// ✅ GOOD — the correct approach
good_code_example
\`\`\`

Include specific error messages, gotcha descriptions, and "when to apply" guidelines.

**IMPORTANT: Do NOT include evidence quotes in the output.** Use evidence internally to validate patterns, but the final CLAUDE.md should contain only the rule specification and code examples — concise, actionable instructions that a coding agent can follow directly.

### Why This Structure Matters
- **Frequency** proves the pattern is real (not a one-off preference)
- **Code examples** make rules immediately actionable (no ambiguity)
- **Error messages** help developers recognize the pattern when they hit it

Aim for **15-25 patterns** per CLAUDE.md file. Every pattern must have frequency + specification.`;
}

/**
 * Build a task-specific prompt pair (system + user message).
 */
export function buildTaskPrompt(
  task: ReflectionTask,
  options: ReflectionOptions,
  survey: SurveyResult,
): { system: string; user: string } {
  const base = buildBaseInstructions(options);

  switch (task.context.kind) {
    case 'rules':
      return buildRulesPrompt(base, task, options, survey);
    case 'skills':
      return buildSkillsPrompt(base, task, options, survey);
    case 'directory':
      return buildDirectoryPrompt(base, task, options, survey);
    case 'pr-reviews':
      return buildPrReviewsPrompt(base, task, options, survey);
  }
}

function buildRulesPrompt(
  base: string,
  task: ReflectionTask,
  options: ReflectionOptions,
  survey: SurveyResult,
): { system: string; user: string } {
  const days = options.days ?? 90;
  const dirExclusions = survey.majorDirectories.length > 0
    ? `\n\n**Scope note:** The following subdirectories will also get their own CLAUDE.md: ${survey.majorDirectories.map((d) => d.relativePath).join(', ')}. You should still include important patterns in the ROOT CLAUDE.md even if they primarily affect one directory — the root file should be comprehensive. Directory-specific CLAUDE.md files will go deeper into local concerns.`
    : '';

  const system = `You are a senior engineering consultant analyzing a project's coding agent conversation history. Your task is to generate a ROOT CLAUDE.md file with coding conventions, architecture patterns, commands, and common pitfalls.

${base}

${buildPatternQualityInstructions()}
${dirExclusions}

## CLAUDE.md File Structure

Your CLAUDE.md should have these sections (include only where you have evidence):

1. **Project Overview** (5-10 lines max — just orientation)
2. **Tech Stack** (brief, only non-obvious choices with rationale)
3. **Commands** (exact commands that work — very valuable)
4. **Architecture Patterns** (with WHY decisions were made)
5. **Coding Conventions** (structured as numbered patterns with frequency/evidence/spec)
6. **Common Issues / Pitfalls** (structured as numbered patterns with frequency/evidence/spec)
7. **Testing** (gotchas, specific commands, what breaks)
8. **Agent Instructions** (standing user preferences enforced repeatedly — simplicity, commenting style, code reuse, cleanup expectations. Format as numbered patterns with frequency.)

The Coding Conventions and Common Issues sections should follow the pattern structure (frequency + evidence + code examples). Keep Project Overview and Tech Stack SHORT. Spend most of your output on experiential knowledge.

At the end of the CLAUDE.md, include a **Summary Statistics** table:

\`\`\`markdown
## Summary Statistics

| Pattern | Frequency | Category |
|---------|-----------|----------|
| Pattern name | N+ | Category |
...

**Total conversations analyzed:** N
**Time period:** N days
**Sources:** list of sources
\`\`\`

Use **imperative voice**: "Use TypeScript strict mode" not "The project uses TypeScript strict mode"`;

  const existingContext = task.context.kind === 'rules' && task.context.existingClaudeMd && !options.force
    ? `\nAn existing root CLAUDE.md is provided below. Do a progressive update — preserve content that is still accurate, update outdated sections, add new observations. Don't throw away good existing content.\n\n--- EXISTING CLAUDE.md ---\n${task.context.existingClaudeMd}\n--- END EXISTING CLAUDE.md ---`
    : '';

  const forceNote = options.force ? '\nGenerate everything fresh from scratch (ignore any existing files).' : '';

  const user = `Analyze ALL conversations for project "${survey.projectRoot}" over the last ${days} days.${options.source ? ` Only source: ${options.source}.` : ''}${forceNote}${existingContext}

Generate a root CLAUDE.md with structured patterns following the frequency/evidence/specification format. Survey every conversation via outline, deep-read the top 15-20 most informative ones, and output using === FILE: CLAUDE.md === markers.

Focus on extracting EXPERIENTIAL knowledge — bugs, fixes, gotchas, architecture rationale, performance numbers, non-obvious commands. NOT code-structure documentation.

ALSO: Before deep-reading, use dex_search to scan for repeated user corrections (e.g., "simplify", "remove comments", "parallelize", "existing util", "DRY", "remove debug"). For each keyword hitting 5+ conversations, read 2-3 examples with \`user_only\` format and extract the standing preference as an Agent Instruction.`;

  return { system, user };
}

function buildSkillsPrompt(
  base: string,
  task: ReflectionTask,
  options: ReflectionOptions,
  survey: SurveyResult,
): { system: string; user: string } {
  const days = options.days ?? 90;

  const system = `You are a senior engineering consultant analyzing a project's coding agent conversation history. Your task is to extract recurring multi-step workflows and generate reusable skill files.

${base}

## What Are Skills?

Skills are reusable workflow templates placed in \`.claude/skills/<skill-name>/SKILL.md\`. They automate recurring multi-step procedures that developers perform repeatedly.

**SKILL.md format:**
\`\`\`
---
name: skill-name
description: Short description shown in skill list
user-invocable: true
---

# Skill Title

## Context
Brief context about when to use this skill.

## Procedure
1. Step-by-step instructions
2. With specific commands, file paths, patterns
3. That the AI agent should follow

## Important Notes
- Key gotchas or constraints
\`\`\`

**Frontmatter fields:**
- \`name\`: kebab-case identifier (required)
- \`description\`: Short description (required)
- \`user-invocable\`: Set to \`true\` for slash-command invocation (default)
- \`allowed-tools\`: Restrict which tools the skill can use (optional)
- \`argument-hint\`: Hint for what argument the skill expects (optional)

## What Makes a Good Skill

Look for workflows that:
- Appear in 1-2+ conversations with 3+ steps
- Involve specific commands, file paths, or patterns unique to this project
- Would save significant time if automated (debugging, deployment, migration, etc.)
- Have non-obvious gotchas that developers keep running into

**Good skill candidates:**
- Recurring development workflows (add feature, create migration, add API endpoint)
- Deployment/release procedures
- Debugging workflows for common issues
- Testing workflows (set up test data, run specific suites)
- Data pipeline or batch job procedures
- On-call/incident triage procedures

**Bad skill candidates:**
- Generic workflows anyone could figure out (e.g., "run npm install")
- One-step operations
- Workflows that are already documented in README
- **Standard git/CI workflows** (committing, pushing, creating PRs, resolving merge conflicts, fixing lint errors) — these are universal, not project-specific

### The Skill Litmus Test

For every skill you generate, ask: **"Would this skill's procedure be meaningfully different for a different project?"** If the answer is no, DO NOT generate it.

A good skill MUST reference at least 2 of:
- Project-specific file paths or directory structures
- Project-specific commands, flags, or scripts
- Project-specific tools, services, or APIs
- Project-specific gotchas or workarounds

Example: A "resolve merge conflicts" skill that just says "run git status, fix markers, commit" is GENERIC — don't generate it. A "add-database-migration" skill that references specific ORM commands, model files, and migration directory conventions IS project-specific — generate it.

Generate each skill as a separate file: \`=== FILE: .claude/skills/<name>/SKILL.md ===\`

Be aggressive about generating skills, but ONLY project-specific ones. Prefer fewer high-quality skills over many generic ones.`;

  const user = `Analyze ALL conversations for project "${survey.projectRoot}" over the last ${days} days.${options.source ? ` Only source: ${options.source}.` : ''}

Focus on finding recurring multi-step workflows: debugging procedures, deployment steps, migration patterns, testing workflows, data operations. Survey all conversations via outline, deep-read ones with procedural content, and generate .claude/skills/*/SKILL.md files.

Output using === FILE: .claude/skills/<name>/SKILL.md === markers.`;

  return { system, user };
}

function buildDirectoryPrompt(
  base: string,
  task: ReflectionTask,
  options: ReflectionOptions,
  survey: SurveyResult,
): { system: string; user: string } {
  const days = options.days ?? 90;
  const ctx = task.context as { kind: 'directory'; relativePath: string; packageName?: string };
  const dirPath = ctx.relativePath;
  const pkgNote = ctx.packageName ? ` (package: ${ctx.packageName})` : '';

  const system = `You are a senior engineering consultant analyzing a project's coding agent conversation history. Your task is to generate a CLAUDE.md file specifically for the \`${dirPath}/\` directory${pkgNote}.

${base}

${buildPatternQualityInstructions()}

## Scope

Generate ONLY patterns and knowledge specific to the \`${dirPath}/\` directory. Do NOT include project-wide patterns (those go in the root CLAUDE.md).

**Use dex_search with file filters** to find conversations involving files in \`${dirPath}/\`. Example: search for files matching "${dirPath}/" to find relevant conversations.

## CLAUDE.md File Structure

Your ${dirPath}/CLAUDE.md should have these sections (include only where you have evidence):

1. **Overview** (what this directory is/does — 3-5 lines)
2. **Tech Stack** (directory-specific dependencies and tools)
3. **Commands** (directory-specific build, test, lint commands)
4. **Architecture Patterns** (directory-specific patterns with rationale)
5. **Coding Conventions** (structured patterns with frequency/evidence/spec)
6. **Common Issues / Pitfalls** (structured patterns with frequency/evidence/spec)
7. **Testing** (directory-specific test setup and gotchas)

Use **imperative voice**: "Use TypeScript strict mode" not "The project uses TypeScript strict mode"`;

  const user = `Analyze conversations for project "${survey.projectRoot}" over the last ${days} days, focusing on the \`${dirPath}/\` directory.${options.source ? ` Only source: ${options.source}.` : ''}

Use dex_search with file path filter "${dirPath}/" to find relevant conversations. If fewer than 3 conversations involve this directory, output a minimal CLAUDE.md with just a brief overview and skip the pattern extraction — there isn't enough data for meaningful patterns.

If there ARE enough conversations, survey those via outline, deep-read the most informative ones, and generate a ${dirPath}/CLAUDE.md with structured patterns.

Output using === FILE: ${dirPath}/CLAUDE.md === markers.`;

  return { system, user };
}

function buildPrReviewsPrompt(
  _base: string,
  task: ReflectionTask,
  _options: ReflectionOptions,
  _survey: SurveyResult,
): { system: string; user: string } {
  const ctx = task.context as { kind: 'pr-reviews'; githubRepo: string; prData?: { dir: string; count: number; inlineContent: string } };

  const system = `You are a senior engineering consultant analyzing GitHub PR review comments to extract coding conventions that a coding agent should follow. Your task is to identify patterns that reviewers consistently enforce.

## What to Extract — CODING-ACTIONABLE patterns only

Extract patterns that directly affect how code should be written. These are things a coding agent needs to know to write correct code on the first try:

- **Code style rules** reviewers enforce (naming, formatting, patterns)
- **Architecture rules** ("don't put X in Y", "always use service X for Y")
- **API/framework usage patterns** ("use styled() not sx", "use observable.map not Map")
- **Required patterns** ("always add index with concurrently:true", "always scope queries by workspaceId")
- **Common mistakes** reviewers catch (wrong import path, missing type, incorrect API usage)
- **Testing requirements** that affect code structure ("always add tests for X")

## What NOT to Extract

Skip patterns that are about team process, not code:
- Approval workflows ("get cross-team approval before merging")
- Deployment timing ("deploy after-hours", "babysit risky changes")
- Communication norms ("ping the team in Slack")
- QA processes ("have QA hammer this before GA")
- Release management ("wait for sign-off")

Ask yourself: **"Would a coding agent need this to write better code?"** If no, skip it.

## Output Format — CRITICAL

Your FINAL response MUST contain file contents wrapped in markers. This is machine-parsed.

Use these exact markers (NOT inside code fences, NOT indented):

=== FILE: path/to/file.md ===
(file content)
=== END FILE ===

Generate a **## Code Review Patterns** section for CLAUDE.md. For each pattern:

**Pattern N: Title**

**Frequency:** N+ PRs

**Rule Specification:**
Clear, direct explanation with code examples where applicable. No evidence quotes — just the actionable rule.

Output using === FILE: CLAUDE.md === markers. The content will be appended to the root CLAUDE.md.

**Do NOT use any tools.** All data is provided below. Just analyze and produce output immediately.`;

  const user = ctx.prData?.inlineContent
    ? `Analyze the following ${ctx.prData.count} PR reviews from ${ctx.githubRepo}. Extract team conventions that reviewers consistently enforce across multiple PRs.

<pr-review-data>
${ctx.prData.inlineContent}
</pr-review-data>

Output using === FILE: CLAUDE.md === with a ## Code Review Patterns header.`
    : `No PR review data was available for ${ctx.githubRepo}. Output an empty file:

=== FILE: CLAUDE.md ===
## Code Review Patterns

No PR review data available.
=== END FILE ===`;

  return { system, user };
}

// ============================================================================
// LEGACY: Original monolithic prompt builders (kept for backward compatibility)
// ============================================================================

export function buildSystemPrompt(options: ReflectionOptions): string {
  const days = options.days ?? 90;

  return `You are a senior engineering consultant analyzing a project's coding agent conversation history. You produce two types of output:

1. **CLAUDE.md files** — Scoped instructions at every meaningful directory level (root, frontend/, backend/, packages/, etc.)
2. **Custom skills** — Reusable workflow templates placed in \`.claude/skills/\` that automate recurring multi-step procedures

## Available Tools

You have access to these dex MCP tools:

- **dex_stats** — Overview statistics (conversation counts, date ranges, sources, top projects)
- **dex_list** — Browse conversations by filters (project, source, date range, branch). Supports limit/offset pagination.
- **dex_search** — Search conversation content by keywords. Supports file path filtering.
- **dex_get** — Retrieve conversation content. Formats: \`stripped\` (no tool outputs — use this), \`outline\` (summary), \`user_only\`, \`full\`. Supports \`max_tokens\` to cap large conversations. **IMPORTANT**: Use \`tail: true\` with \`max_tokens\` to read the END of conversations — this is where conclusions, fixes, and architecture decisions live.
- **dex_pr_reviews** — Browse and read GitHub PR review comments. List mode (no number): returns PR titles, review decisions, comment counts. Detail mode (with number): returns full review bodies and comments. PR reviews contain team knowledge: conventions enforced by reviewers, architecture decisions, "don't do X" warnings. Very token-efficient (~2K tokens per PR thread vs ~50K per conversation).

## Your Task — Three Phases

### Phase 1: Survey & Inventory (be thorough)

1. Call dex_stats to understand the landscape
2. Call dex_list with limit=50 repeatedly (incrementing offset) to page through ALL conversations for this project${options.source ? ` from source "${options.source}"` : ''}
3. Build a complete inventory: total conversation count, major subdirectories involved, sources used
4. **Do NOT skip conversations.** Read every single one using \`outline\` format first to survey, then selectively deep-read the most informative ones.
5. If the project has a GitHub repo, call dex_pr_reviews to survey merged PRs. Focus on PRs with review discussion (CHANGES_REQUESTED or multiple comments).

### Phase 2: Deep Read (context-aware)

**CRITICAL: You have a ~200K token context window. Manage it carefully.**

1. First pass: Read ALL conversations using dex_get with \`outline\` format — this is very compact and lets you survey everything.
2. Identify the most informative conversations: ones with debugging sessions, architecture decisions, error messages, performance issues, deployment problems, workflow patterns. Skip trivial conversations ("fix typo", single-line changes, simple refactors).
3. Deep-read the top **20-40 most informative conversations** using \`stripped\` format with \`max_tokens: 30000\` per conversation.
   - **IMPORTANT**: The most valuable content (conclusions, fixes, architecture decisions) is typically at the END of conversations. When you deep-read long conversations:
     - For short conversations (<30K tokens): read without max_tokens to get everything
     - For long conversations (>30K tokens): Use \`tail: true\` with \`max_tokens: 30000\` to read the ENDING (where conclusions/fixes are). Optionally also read the beginning (without tail) for initial context.
   - The ENDING of a conversation is where developers reach conclusions, document what worked, and summarize learnings. Always prefer \`tail: true\` for deep reads.
4. If a project has >200 conversations, prioritize: conversations with the most messages (longer = more debugging/decisions), recent conversations, conversations mentioning errors or bugs.
5. Also deep-read the top 10-15 PRs with the most review discussion — call dex_pr_reviews with specific PR numbers. PR review comments are extremely token-efficient (~2K tokens per PR thread vs ~50K per conversation) and contain team conventions that don't appear in agent conversations.
6. As you read, specifically extract:
   - **Bugs and their fixes**: Exact error messages, what caused them, how they were resolved
   - **Architecture decisions with rationale**: Not just "uses X" but WHY X was chosen, what constraints drove the decision
   - **Non-obvious commands and flags**: Commands developers actually ran (not from package.json)
   - **Performance measurements**: Before/after numbers, batch sizes, timeouts, thresholds
   - **Workarounds for library/framework bugs**: Specific patches, hacks, or defensive patterns
   - **Recurring multi-step workflows**: Exact procedures developers followed repeatedly — these become skills
   - **Gotchas that caused real production issues**: The kind of knowledge that saves hours of debugging

### Phase 3: Generate Output

Based on your exhaustive read, produce:

#### A. Hierarchical CLAUDE.md files

Generate a CLAUDE.md at EVERY directory level that has distinct patterns. Be aggressive about this — if a subdirectory has its own tech stack, conventions, or commands, it deserves its own CLAUDE.md.

**Root CLAUDE.md** — Project overview, shared conventions, monorepo structure, cross-cutting concerns
**Subdirectory CLAUDE.md files** — For EACH major directory (frontend/, functions/, packages/, tests/, etc.):
  - Directory-specific tech stack and dependencies
  - Directory-specific commands (build, test, lint)
  - Directory-specific conventions and patterns
  - Directory-specific pitfalls

Do NOT put frontend-specific instructions in the root CLAUDE.md if there's a frontend/ directory. Scope instructions to where they apply.

Each CLAUDE.md should have these sections (include only where you have evidence):
- Project Overview (what this directory is/does)
- Tech Stack
- Commands (very valuable — exact commands that work)
- Architecture Patterns
- Coding Conventions
- Testing
- Common Issues / Pitfalls

Use **imperative voice**: "Use TypeScript strict mode" not "The project uses TypeScript strict mode"

#### B. Custom skill files (.claude/skills/)

Generate reusable skill files for recurring multi-step workflows you observe. Skills are the modern Claude Code format — each skill is a directory containing a SKILL.md file at \`.claude/skills/<skill-name>/SKILL.md\`.

**Skill directory structure:**
\`\`\`
.claude/skills/<skill-name>/SKILL.md
\`\`\`

**SKILL.md format:**
\`\`\`
---
name: skill-name
description: Short description shown in skill list
user-invocable: true
---

# Skill Title

## Context
Brief context about when to use this skill.

## Procedure
1. Step-by-step instructions
2. With specific commands, file paths, patterns
3. That the AI agent should follow

## Important Notes
- Key gotchas or constraints
\`\`\`

**Frontmatter fields:**
- \`name\`: kebab-case identifier (required)
- \`description\`: Short description shown in skill list (required)
- \`user-invocable\`: Set to \`true\` for skills invoked via slash commands (default)
- \`allowed-tools\`: Restrict which tools the skill can use (optional)
- \`argument-hint\`: Hint for what argument the skill expects (optional)

**Good skill candidates** (generate these when you see the pattern):
- Recurring development workflows (add feature, create migration, add API endpoint)
- Deployment/release procedures
- Debugging workflows for common issues
- Code review checklists specific to the project
- Testing workflows (run specific test suites, set up test data)
- On-call/incident triage procedures
- Data pipeline or batch job procedures

**Skill naming**: Use kebab-case directory names (e.g., \`add-migration\`, \`deploy-staging\`, \`debug-temporal\`)

Be aggressive about generating skills. If a workflow appears in even 1-2 conversations and involves 3+ steps, it's worth a skill.

## What Makes Your Output Valuable — CRITICAL

You are NOT generating codebase documentation. Anyone can run \`tree\` and \`cat package.json\` to get that. Your unique value is **EXPERIENTIAL KNOWLEDGE from conversations** — things developers learned by working with the code.

### The Litmus Test

For every bullet you write, ask: **"Would I need to read conversation history to know this, or could I figure it out from the code alone?"** If the answer is "from the code alone", DELETE IT.

### DO NOT INCLUDE (code-derivable — someone could figure this out in 5 minutes):
- "Uses React with MobX" — obvious from package.json
- "Tests run with npm test" — obvious from package.json scripts
- "Frontend components are in frontend/src/components/" — obvious from directory structure
- Basic tech stack listings without context
- File paths that are self-evident from directory names
- Standard framework patterns (e.g., "MobX stores use @observable")

### DO INCLUDE (conversation-derived — requires reading actual developer experiences):
- **Bugs that bit developers and their fixes**: "MobX observer wrapping is the #1 frontend bug — TaskButtonContent had stale UI because it used useMemo with an observable Map. The Map mutated in place so useMemo dependencies didn't change. Fix: remove useMemo, read observables directly inside observer()."
- **Architecture decisions with the WHY**: "Temporal workflows CANNOT import Sequelize models directly — use activities instead. Direct imports crash the worker because Sequelize native bindings can't be serialized across the workflow sandbox boundary."
- **Real performance numbers**: "32K individual Firestore reads → getAll() batched: 105s → 27.5s. Then p-limit(200) for concurrency eliminated event loop blocking entirely."
- **Gotchas with specific error messages**: "If you get 'fragment not found' from LanceDB FTS, the index is corrupted. Fix: rebuild with createIndex({replace: true}), then retry."
- **Workarounds for library bugs**: "Deepagents SkillsMetadata concurrent update bug: when 2+ subagents run in parallel, they corrupt shared metadata. The patch in patches/deepagents+1.6.0.patch serializes the updates."
- **Non-obvious command flags**: "npx tsc --noEmit on a single file does NOT work — always run full project typecheck. Single-file mode misses path alias resolution."
- **Debugging procedures that actually worked**: Steps developers followed to diagnose real issues, not hypothetical procedures
- **Migration/deployment gotchas**: "Adding a non-nullable column to a table with existing rows fails silently in staging but crashes in production. Always use allowNull: true or provide defaultValue."
- **Code review patterns your team enforces**: Conventions that reviewers consistently flag in PRs — "Reviewers consistently flag missing error boundaries around async MobX actions — always wrap observer callbacks..."

### Content Guidelines
- Keep basic tech stack / project structure sections **short** (5-10 lines max) — just enough for orientation
- Spend most of your output on **experiential knowledge**: bugs, fixes, gotchas, non-obvious commands, architecture rationale, performance lessons
- Every "Common Issues" or "Pitfalls" section should reference **specific incidents or bugs** from conversations
- Skills should capture **actual workflows developers performed**, not hypothetical procedures
- If a section would be identical for any project using the same framework, it's too generic — cut it

## Analysis Guidelines

- Analyze the last ${days} days of conversations
- Frequency threshold: 2+ conversations for conventions/patterns; 1+ for skills and architecture
- Aim for 20-50 rules per CLAUDE.md file — but every rule must be SPECIFIC to this project
- Be **evidence-based** — only include what you observed in actual conversations
- Be **root-cause oriented** — explain why, not just what
- If you can't write something specific, don't write it at all. Zero generic bullets.

## Output Format — CRITICAL

Your FINAL response MUST contain the actual file contents wrapped in markers. This is machine-parsed.

Use these exact markers (NOT inside code fences, NOT indented):

=== FILE: CLAUDE.md ===
(root CLAUDE.md content)
=== END FILE ===

=== FILE: frontend/CLAUDE.md ===
(frontend-specific content)
=== END FILE ===

=== FILE: functions/CLAUDE.md ===
(backend-specific content)
=== END FILE ===

=== FILE: .claude/skills/add-migration/SKILL.md ===
(skill file content with --- frontmatter ---)
=== END FILE ===

Rules:
- The content between markers IS the file written to disk. It must be complete and ready to use.
- Generate as many files as the project warrants. Err on the side of MORE files, not fewer.
- Every major subdirectory with distinct patterns gets its own CLAUDE.md.
- Every recurring workflow gets its own skill file.
- After ALL file markers, include a brief summary of what you generated.
- If your response does not include === FILE: markers, the output will be MALFORMED.

## Important Notes

- Use \`outline\` format for surveying — extremely compact, lets you read ALL conversations
- Use \`stripped\` format with \`max_tokens: 30000\` for deep reads of important conversations
- For very long conversations (>30K tokens), also read the ending portion separately — conclusions and fixes live at the end
- NEVER use \`full\` format — it includes raw tool outputs and will blow your context
- Survey ALL conversations via outline, then deep-read the top 20-40 most informative ones thoroughly
- **CRITICAL: Batch dex_get calls with at most 3-5 IDs at a time** to avoid exceeding response limits. If a response says "skipped_ids", fetch those in a follow-up call.
- Fetch conversations in batches using limit/offset on dex_list, then dex_get with multiple IDs
- Prioritize QUALITY of reading over QUANTITY — 20 deeply-read conversations yield better insights than 100 skimmed ones
- If you notice your context getting large, **generate output immediately** with what you have — partial deep coverage is better than crashing. Begin writing your === FILE: markers as soon as you have enough evidence.`;
}

export function buildUserMessage(
  options: ReflectionOptions,
  existingClaudeMd?: string | null,
): string {
  const parts: string[] = [];

  const project = options.project || 'the current project';
  const days = options.days ?? 90;

  parts.push(`Analyze ALL conversations for project "${project}" over the last ${days} days. Survey every single one via outline format, then deep-read the most informative ones.`);

  if (options.source) {
    parts.push(`Only look at conversations from source: ${options.source}.`);
  }

  if (options.githubRepo) {
    parts.push(`The project's GitHub repo is ${options.githubRepo} — also survey PR review comments using dex_pr_reviews for team conventions and code review patterns.`);
  }

  if (existingClaudeMd && !options.force) {
    parts.push(
      `\nAn existing root CLAUDE.md is provided below. Do a progressive update — preserve content that is still accurate, update outdated sections, add new observations, and consider splitting directory-specific content into subdirectory CLAUDE.md files.\n\n--- EXISTING CLAUDE.md ---\n${existingClaudeMd}\n--- END EXISTING CLAUDE.md ---`,
    );
  } else if (options.force) {
    parts.push('Generate everything fresh from scratch (ignore any existing files).');
  }

  parts.push('\nBegin by calling dex_stats, then page through ALL conversations with dex_list. Survey ALL via outline format, then deep-read the top 20-40 most informative conversations with stripped format (max_tokens: 30000). For long conversations, also read the ending portion separately — the best insights are at the end. Focus on extracting EXPERIENTIAL knowledge (bugs, fixes, gotchas, architecture rationale, performance numbers) not code-structure documentation. Then output the complete file contents using === FILE: path === / === END FILE === markers.');

  return parts.join(' ');
}
