import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { preloadPatchDiff, type DiffLineAnnotation } from '@pierre/diffs/ssr';
import { Marked } from 'marked';
import { createHighlighter, type Highlighter } from 'shiki';
import type { ExportData } from '../review-export.js';

interface ServerOptions {
  port?: number;
  data: ExportData;
}

interface ParsedFile {
  path: string;
  content: string;
  additions: number;
  deletions: number;
}

interface LineAttributionData {
  conversationId: string;
  conversationTitle: string;
  messageIndex?: number;
}

let highlighter: Highlighter | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: ['typescript', 'javascript', 'python', 'rust', 'go', 'java', 'cpp', 'c', 'bash', 'json', 'yaml', 'html', 'css', 'sql', 'markdown', 'diff'],
    });
  }
  return highlighter;
}

function parseDiffIntoFiles(rawDiff: string): ParsedFile[] {
  if (!rawDiff) return [];

  const files: ParsedFile[] = [];
  let currentFile: ParsedFile | null = null;
  let currentContent: string[] = [];

  const lines = rawDiff.split('\n');

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile) {
        currentFile.content = currentContent.join('\n');
        files.push(currentFile);
      }
      currentFile = { path: '', content: '', additions: 0, deletions: 0 };
      currentContent = [line];
      continue;
    }

    if (line.startsWith('+++ b/') && currentFile) {
      currentFile.path = line.slice(6);
    }

    if (currentFile) {
      currentContent.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentFile.additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentFile.deletions++;
      }
    }
  }

  if (currentFile) {
    currentFile.content = currentContent.join('\n');
    files.push(currentFile);
  }

  return files;
}

function buildLineAttributionMap(data: ExportData): Map<string, LineAttributionData[]> {
  const map = new Map<string, LineAttributionData[]>();

  if (data.branchDiff?.lineAttributions) {
    for (const attr of data.branchDiff.lineAttributions) {
      if (!attr.fileEditPath) continue;
      const key = `${attr.fileEditPath}:${attr.lineNumber}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({
        conversationId: attr.conversationId,
        conversationTitle: attr.conversationTitle,
      });
    }
  }

  for (const commit of data.commits || []) {
    for (const attr of commit.lineAttributions || []) {
      if (!attr.fileEditPath) continue;
      const key = `${attr.fileEditPath}:${attr.lineNumber}`;
      if (!map.has(key)) map.set(key, []);
      const existing = map.get(key)!;
      if (!existing.some(e => e.conversationId === attr.conversationId)) {
        existing.push({
          conversationId: attr.conversationId,
          conversationTitle: attr.conversationTitle,
        });
      }
    }
  }

  return map;
}

async function prerenderDiffs(
  rawDiff: string,
  lineAttributionMap: Map<string, LineAttributionData[]>
): Promise<Map<string, { html: string; annotations: DiffLineAnnotation<LineAttributionData>[] }>> {
  const files = parseDiffIntoFiles(rawDiff);
  const renderedDiffs = new Map<string, { html: string; annotations: DiffLineAnnotation<LineAttributionData>[] }>();

  for (const file of files) {
    try {
      const annotations: DiffLineAnnotation<LineAttributionData>[] = [];
      
      let lineNumber = 0;
      for (const line of file.content.split('\n')) {
        if (line.startsWith('@@')) {
          const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
          if (match && match[1]) {
            lineNumber = parseInt(match[1], 10) - 1;
          }
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          lineNumber++;
          const key = `${file.path}:${lineNumber}`;
          const attrs = lineAttributionMap.get(key);
          if (attrs && attrs.length > 0 && attrs[0]) {
            annotations.push({
              side: 'additions',
              lineNumber,
              metadata: attrs[0],
            });
          }
        } else if (!line.startsWith('-') && !line.startsWith('\\')) {
          lineNumber++;
        }
      }

      const result = await preloadPatchDiff({
        patch: file.content,
        options: {
          theme: { dark: 'github-dark', light: 'github-light' },
          diffStyle: 'split',
          themeType: 'light',
          hunkSeparators: 'line-info',
          expandUnchanged: true,
          lineDiffType: 'word',
          diffIndicators: 'bars',
          overflow: 'scroll',
        },
        annotations,
      });
      renderedDiffs.set(file.path, { html: result.prerenderedHTML, annotations });
    } catch {
      renderedDiffs.set(file.path, {
        html: `<pre style="padding: 12px; font-family: var(--font-mono); font-size: 12px; overflow-x: auto; background: #f6f8fa;">${escapeHtml(file.content)}</pre>`,
        annotations: [],
      });
    }
  }

  return renderedDiffs;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderMarkdown(content: string): Promise<string> {
  const hl = await getHighlighter();
  
  const marked = new Marked({
    async: true,
    gfm: true,
    breaks: false,
  });

  marked.use({
    renderer: {
      code({ text, lang }) {
        const language = lang || 'text';
        try {
          const validLangs = ['typescript', 'javascript', 'python', 'rust', 'go', 'java', 'cpp', 'c', 'bash', 'json', 'yaml', 'html', 'css', 'sql', 'markdown', 'diff', 'ts', 'js', 'tsx', 'jsx'];
          const normalizedLang = language === 'ts' ? 'typescript' : language === 'js' ? 'javascript' : language;
          
          if (validLangs.includes(normalizedLang)) {
            const highlighted = hl.codeToHtml(text, {
              lang: normalizedLang as 'typescript',
              theme: 'github-dark',
            });
            return `<div class="code-block"><div class="code-lang-label">${escapeHtml(language)}</div>${highlighted}</div>`;
          }
        } catch { }
        return `<div class="code-block"><div class="code-lang-label">${escapeHtml(language)}</div><pre><code>${escapeHtml(text)}</code></pre></div>`;
      },
      codespan({ text }) {
        return `<code class="inline-code">${escapeHtml(text)}</code>`;
      },
    },
  });

  const result = await marked.parse(content);
  return result;
}

function generateHtml(
  data: ExportData,
  renderedDiffs: Map<string, { html: string; annotations: DiffLineAnnotation<LineAttributionData>[] }>,
  lineAttributionMap: Map<string, LineAttributionData[]>
): string {
  const files = parseDiffIntoFiles(data.branchDiff?.rawDiff || '');

  const fileConversationMap: Record<string, string[]> = {};
  for (const [key, attrs] of lineAttributionMap.entries()) {
    const filePath = key.split(':')[0];
    if (filePath === undefined) continue;
    if (!fileConversationMap[filePath]) fileConversationMap[filePath] = [];
    for (const attr of attrs) {
      if (attr && !fileConversationMap[filePath].includes(attr.conversationId)) {
        fileConversationMap[filePath].push(attr.conversationId);
      }
    }
  }

  const fileListHtml = files
    .map((file, index) => {
      const diffData = renderedDiffs.get(file.path);
      const diffHtml = diffData?.html || '';
      const fileConvIds = fileConversationMap[file.path] || [];
      return `
      <div class="file-item" data-file-path="${escapeHtml(file.path)}" data-conv-ids="${escapeHtml(JSON.stringify(fileConvIds))}">
        <div class="file-header" data-file-index="${index}">
          <span class="file-name">
            <svg class="chevron-icon" viewBox="0 0 16 16" width="12" height="12">
              <path fill="currentColor" d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"/>
            </svg>
            <svg class="file-icon" viewBox="0 0 16 16" width="16" height="16">
              <path fill="currentColor" d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/>
            </svg>
            ${escapeHtml(file.path)}
          </span>
          <div class="file-actions">
            <span class="file-stats">
              <span class="stat-add">+${file.additions}</span>
              <span class="stat-del">-${file.deletions}</span>
            </span>
            <label class="viewed-checkbox" onclick="event.stopPropagation()">
              <input type="checkbox" data-viewed-path="${escapeHtml(file.path)}">
              Viewed
            </label>
          </div>
        </div>
        <div class="file-diff-content" id="diff-${index}">${diffHtml}</div>
      </div>
    `;
    })
    .join('');

  const safeDataJson = JSON.stringify(data).replace(/<\/script>/gi, '\\u003c/script>');
  const lineAttrJson = JSON.stringify(Object.fromEntries(lineAttributionMap)).replace(/<\/script>/gi, '\\u003c/script>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Branch Review - ${escapeHtml(data.branch)}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.ico">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    :root {
      --color-canvas-default: #ffffff;
      --color-canvas-subtle: #f6f8fa;
      --color-canvas-inset: #eff2f5;
      --color-border-default: #d0d7de;
      --color-border-muted: #d8dee4;
      --color-fg-default: #1f2328;
      --color-fg-muted: #656d76;
      --color-fg-subtle: #6e7781;
      --color-accent-fg: #0969da;
      --color-accent-emphasis: #0969da;
      --color-accent-subtle: #ddf4ff;
      --color-success-fg: #1a7f37;
      --color-success-emphasis: #1f883d;
      --color-danger-fg: #cf222e;
      --color-success-subtle: #dafbe1;
      --color-danger-subtle: #ffebe9;
      --color-attention-subtle: #fff8c5;
      --color-attention-fg: #9a6700;
      --color-purple-fg: #8250df;
      --color-purple-subtle: #fbefff;

      --header-height: 60px;
      --sidebar-width: 320px;

      --font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;

      --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.12);

      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 12px;
    }

    html, body {
      height: 100%;
      overflow: hidden;
    }

    body {
      font-family: var(--font-family);
      font-size: 14px;
      line-height: 1.5;
      color: var(--color-fg-default);
      background: var(--color-canvas-default);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    #app {
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    /* Header */
    .header {
      height: var(--header-height);
      background: linear-gradient(180deg, #ffffff 0%, #fafbfc 100%);
      border-bottom: 1px solid var(--color-border-default);
      display: flex;
      align-items: center;
      padding: 0 24px;
      gap: 16px;
      flex-shrink: 0;
      box-shadow: var(--shadow-sm);
    }

    .header-logo {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .header-logo-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: 700;
      font-size: 14px;
      box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
    }

    .header-title {
      font-size: 17px;
      font-weight: 600;
      color: var(--color-fg-default);
      letter-spacing: -0.02em;
    }

    .header-divider {
      width: 1px;
      height: 24px;
      background: var(--color-border-default);
      margin: 0 8px;
    }

    .header-branches {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .header-branch {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 500;
      background: var(--color-canvas-subtle);
      padding: 6px 12px;
      border-radius: 20px;
      color: var(--color-fg-default);
      border: 1px solid var(--color-border-muted);
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .header-branch.source {
      background: linear-gradient(135deg, #ddf4ff 0%, #c8e7ff 100%);
      border-color: rgba(9, 105, 218, 0.2);
      color: var(--color-accent-fg);
    }

    .header-arrow {
      color: var(--color-fg-muted);
      font-size: 14px;
      display: flex;
      align-items: center;
    }

    .header-stats {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 20px;
    }

    .header-stat-group {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 14px;
      background: var(--color-canvas-subtle);
      border-radius: 20px;
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 500;
    }

    .stat-add { color: var(--color-success-fg); }
    .stat-del { color: var(--color-danger-fg); }

    .header-conv-count {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--color-fg-muted);
      font-size: 13px;
    }

    .header-conv-count svg {
      opacity: 0.7;
    }

    /* Main Layout */
    .main {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    /* Sidebar */
    .sidebar {
      width: var(--sidebar-width);
      min-width: 280px;
      max-width: 400px;
      background: var(--color-canvas-subtle);
      border-right: 1px solid var(--color-border-default);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .sidebar-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--color-border-default);
      background: var(--color-canvas-default);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .sidebar-title {
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .sidebar-count {
      font-weight: 500;
      color: var(--color-fg-muted);
      font-size: 12px;
      background: var(--color-canvas-inset);
      padding: 2px 8px;
      border-radius: 10px;
    }

    .sidebar-search {
      padding: 12px 16px;
      border-bottom: 1px solid var(--color-border-muted);
    }

    .search-input {
      width: 100%;
      padding: 8px 12px 8px 36px;
      border: 1px solid var(--color-border-default);
      border-radius: var(--radius-md);
      font-size: 13px;
      font-family: var(--font-family);
      background: var(--color-canvas-default) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23656d76' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'%3E%3C/circle%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'%3E%3C/line%3E%3C/svg%3E") no-repeat 12px center;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .search-input:focus {
      outline: none;
      border-color: var(--color-accent-emphasis);
      box-shadow: 0 0 0 3px var(--color-accent-subtle);
    }

    .search-input::placeholder {
      color: var(--color-fg-muted);
    }

    .conversation-list {
      flex: 1;
      overflow-y: auto;
    }

    .conversation-item {
      padding: 14px 20px;
      border-bottom: 1px solid var(--color-border-muted);
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;
    }

    .conversation-item:hover {
      background: var(--color-canvas-default);
    }

    .conversation-item.active {
      background: var(--color-canvas-default);
      box-shadow: inset 3px 0 0 var(--color-accent-emphasis);
    }

    .conversation-item.active::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: var(--color-accent-emphasis);
    }

    .conversation-header {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 8px;
    }

    .source-icon {
      width: 24px;
      height: 24px;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .source-icon.claude-code {
      background: linear-gradient(135deg, #d97706 0%, #ea580c 100%);
      color: white;
    }

    .source-icon.cursor {
      background: linear-gradient(135deg, #18181b 0%, #3f3f46 100%);
      color: white;
    }

    .source-icon.codex {
      background: linear-gradient(135deg, #059669 0%, #10b981 100%);
      color: white;
    }

    .source-icon.opencode {
      background: linear-gradient(135deg, #7c3aed 0%, #8b5cf6 100%);
      color: white;
    }

    .conversation-title {
      font-weight: 500;
      font-size: 14px;
      color: var(--color-fg-default);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      line-height: 1.4;
      flex: 1;
    }

    .conversation-meta {
      font-size: 12px;
      color: var(--color-fg-muted);
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      margin-left: 36px;
    }

    .meta-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .file-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      background: var(--color-canvas-inset);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-fg-muted);
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .confidence-badge {
      display: inline-flex;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .confidence-badge.high {
      background: var(--color-success-subtle);
      color: var(--color-success-fg);
    }

    .confidence-badge.medium {
      background: var(--color-attention-subtle);
      color: var(--color-attention-fg);
    }

    .confidence-badge.low {
      background: var(--color-canvas-inset);
      color: var(--color-fg-muted);
    }

    /* Content Area */
    .content {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    /* Conversation Panel */
    .conversation-panel {
      width: 45%;
      min-width: 380px;
      max-width: 600px;
      border-right: 1px solid var(--color-border-default);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--color-canvas-default);
    }

    .panel-header {
      padding: 14px 20px;
      border-bottom: 1px solid var(--color-border-default);
      background: var(--color-canvas-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }

    .panel-title {
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .panel-header-meta {
      font-weight: 400;
      font-size: 12px;
      color: var(--color-fg-muted);
    }

    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      background: linear-gradient(180deg, #fafbfc 0%, #ffffff 100%);
    }

    .message {
      padding: 16px 18px;
      border-radius: var(--radius-lg);
      border: 1px solid var(--color-border-muted);
      position: relative;
      box-shadow: var(--shadow-sm);
      transition: box-shadow 0.2s, border-color 0.2s;
    }

    .message[data-msg-index] {
      scroll-margin-top: 20px;
    }

    .message.highlighted {
      border-color: var(--color-accent-emphasis);
      box-shadow: 0 0 0 3px var(--color-accent-subtle), var(--shadow-md);
      animation: highlight-pulse 2s ease-out;
    }

    @keyframes highlight-pulse {
      0% { box-shadow: 0 0 0 6px var(--color-accent-subtle), var(--shadow-md); }
      100% { box-shadow: 0 0 0 3px var(--color-accent-subtle), var(--shadow-md); }
    }

    .message.user {
      background: var(--color-canvas-default);
    }

    .message.assistant {
      background: linear-gradient(135deg, #f8fbff 0%, #f0f7ff 100%);
      border-color: rgba(9, 105, 218, 0.12);
    }

    .message-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }

    .message-avatar {
      width: 28px;
      height: 28px;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
    }

    .message-avatar.user {
      background: linear-gradient(135deg, #f6f8fa 0%, #ebeef1 100%);
      border: 1px solid var(--color-border-muted);
    }

    .message-avatar.user svg {
      width: 16px;
      height: 16px;
      color: var(--color-fg-muted);
    }

    .message-avatar.assistant {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      box-shadow: 0 2px 6px rgba(102, 126, 234, 0.25);
    }

    .message-avatar.assistant svg {
      width: 16px;
      height: 16px;
      color: white;
    }

    .message-role {
      font-weight: 600;
      font-size: 13px;
      color: var(--color-fg-default);
    }

    .message-content {
      font-size: 14px;
      line-height: 1.65;
      color: var(--color-fg-default);
      overflow-wrap: break-word;
    }

    .message-content p {
      margin-bottom: 12px;
    }
    .message-content p:last-child {
      margin-bottom: 0;
    }

    .message-content h1,
    .message-content h2,
    .message-content h3,
    .message-content h4 {
      margin-top: 20px;
      margin-bottom: 10px;
      font-weight: 600;
      line-height: 1.3;
      color: var(--color-fg-default);
    }

    .message-content h1:first-child,
    .message-content h2:first-child,
    .message-content h3:first-child {
      margin-top: 0;
    }

    .message-content h1 { font-size: 1.4em; border-bottom: 1px solid var(--color-border-muted); padding-bottom: 8px; }
    .message-content h2 { font-size: 1.25em; border-bottom: 1px solid var(--color-border-muted); padding-bottom: 6px; }
    .message-content h3 { font-size: 1.1em; }
    .message-content h4 { font-size: 1em; }

    .message-content ul, .message-content ol {
      margin-bottom: 12px;
      padding-left: 24px;
    }

    .message-content li {
      margin-bottom: 4px;
    }

    .message-content li > ul,
    .message-content li > ol {
      margin-top: 4px;
      margin-bottom: 0;
    }

    .message-content blockquote {
      border-left: 3px solid var(--color-accent-emphasis);
      padding: 8px 16px;
      color: var(--color-fg-muted);
      margin: 12px 0;
      background: var(--color-canvas-subtle);
      border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    }

    .message-content strong { font-weight: 600; }
    .message-content em { font-style: italic; }

    .message-content .inline-code {
      background: rgba(175, 184, 193, 0.2);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 0.88em;
    }

    .message-content .code-block {
      margin: 14px 0;
      border-radius: var(--radius-md);
      overflow: hidden;
      border: 1px solid rgba(48, 54, 61, 0.4);
      box-shadow: var(--shadow-sm);
    }

    .message-content .code-block .code-lang-label {
      font-size: 11px;
      color: #8b949e;
      padding: 8px 14px;
      background: #161b22;
      border-bottom: 1px solid #30363d;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 500;
      font-family: var(--font-mono);
    }

    .message-content .code-block pre {
      margin: 0 !important;
      padding: 14px !important;
      background: #0d1117 !important;
      overflow-x: auto;
    }

    .message-content .code-block code {
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.5;
    }

    .message-content pre {
      background: #0d1117;
      color: #e6edf3;
      padding: 14px;
      border-radius: var(--radius-md);
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 12px;
      margin: 14px 0;
      line-height: 1.5;
    }

    .message-content pre code {
      background: transparent;
      padding: 0;
      font-size: inherit;
    }

    .message-content a {
      color: var(--color-accent-fg);
      text-decoration: none;
    }

    .message-content a:hover {
      text-decoration: underline;
    }

    .message-content table {
      border-collapse: collapse;
      width: 100%;
      margin: 14px 0;
      font-size: 13px;
    }

    .message-content th,
    .message-content td {
      border: 1px solid var(--color-border-default);
      padding: 8px 12px;
      text-align: left;
    }

    .message-content th {
      background: var(--color-canvas-subtle);
      font-weight: 600;
    }

    .message-content hr {
      border: none;
      border-top: 1px solid var(--color-border-muted);
      margin: 20px 0;
    }

    /* Tool Calls */
    .tool-call {
      margin: 12px 0;
      border: 1px solid var(--color-border-muted);
      border-radius: var(--radius-md);
      overflow: hidden;
      background: var(--color-canvas-default);
    }

    .tool-call-summary {
      padding: 10px 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--color-fg-muted);
      background: var(--color-canvas-subtle);
      user-select: none;
      transition: background 0.15s;
    }

    .tool-call-summary:hover {
      background: var(--color-canvas-inset);
    }

    .tool-call-icon {
      width: 20px;
      height: 20px;
      background: linear-gradient(135deg, var(--color-purple-subtle) 0%, #f3e8ff 100%);
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .tool-call-icon svg {
      width: 12px;
      height: 12px;
      color: var(--color-purple-fg);
    }

    .tool-call-name {
      font-weight: 600;
      color: var(--color-purple-fg);
    }

    .tool-call-args {
      color: var(--color-fg-default);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      opacity: 0.7;
    }

    .tool-call-chevron {
      transition: transform 0.2s;
      color: var(--color-fg-muted);
    }

    .tool-call.expanded .tool-call-chevron {
      transform: rotate(180deg);
    }

    .tool-call-details {
      display: none;
      padding: 12px;
      border-top: 1px solid var(--color-border-muted);
      background: var(--color-canvas-default);
      overflow-x: auto;
    }

    .tool-call.expanded .tool-call-details {
      display: block;
    }

    .tool-json {
      margin: 0 !important;
      background: transparent !important;
      padding: 0 !important;
      color: var(--color-fg-default) !important;
      font-size: 11px !important;
    }

    /* Diff Panel */
    .diff-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 500px;
      background: var(--color-canvas-default);
    }

    .diff-container {
      flex: 1;
      overflow: auto;
      padding: 20px;
      background: var(--color-canvas-subtle);
    }

    .file-item {
      margin-bottom: 16px;
      border: 1px solid var(--color-border-default);
      border-radius: var(--radius-md);
      overflow: hidden;
      transition: all 0.2s ease;
      background: var(--color-canvas-default);
      box-shadow: var(--shadow-sm);
    }

    .file-item.highlighted {
      border-color: var(--color-accent-emphasis);
      box-shadow: 0 0 0 3px var(--color-accent-subtle), var(--shadow-md);
    }

    .file-item.dimmed {
      opacity: 0.35;
    }

    .file-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: linear-gradient(180deg, #fafbfc 0%, #f6f8fa 100%);
      border-bottom: 1px solid var(--color-border-default);
      cursor: pointer;
      user-select: none;
      min-height: 44px;
    }

    .file-header:hover {
      background: linear-gradient(180deg, #f6f8fa 0%, #f0f2f4 100%);
    }

    .file-name {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 500;
      color: var(--color-fg-default);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .file-icon {
      color: var(--color-fg-muted);
      flex-shrink: 0;
    }

    .chevron-icon {
      color: var(--color-fg-muted);
      transition: transform 0.15s ease;
      flex-shrink: 0;
    }

    .file-item.collapsed .chevron-icon {
      transform: rotate(-90deg);
    }

    .file-item.collapsed .file-diff-content {
      display: none;
    }

    .file-actions {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .file-stats {
      display: flex;
      gap: 8px;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 500;
    }

    .viewed-checkbox {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--color-fg-muted);
      cursor: pointer;
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      transition: all 0.15s;
      border: 1px solid transparent;
    }

    .viewed-checkbox:hover {
      background: var(--color-canvas-default);
      border-color: var(--color-border-muted);
    }

    .viewed-checkbox input {
      accent-color: var(--color-success-emphasis);
      width: 14px;
      height: 14px;
    }

    .viewed-checkbox.checked {
      color: var(--color-success-fg);
      background: var(--color-success-subtle);
      border-color: rgba(31, 136, 61, 0.2);
    }

    .file-diff-content {
      background: var(--color-canvas-default);
      overflow-x: auto;
    }

    /* Attributed Diff Lines */
    .diff-line-attributed {
      position: relative;
    }

    .diff-line-attributed::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: var(--color-accent-emphasis);
      z-index: 1;
    }

    .diff-line-clickable {
      cursor: pointer;
      position: relative;
      transition: background 0.15s ease;
    }

    .diff-line-clickable::after {
      content: '';
      position: absolute;
      right: 16px;
      top: 50%;
      transform: translateY(-50%);
      width: 20px;
      height: 20px;
      background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%230969da' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'%3E%3C/path%3E%3C/svg%3E") no-repeat center center;
      background-size: 14px 14px;
      opacity: 0;
      transition: opacity 0.15s ease;
      pointer-events: none;
    }

    .diff-line-clickable:hover::after {
      opacity: 1;
    }

    .diff-line-clickable:hover {
      background: var(--color-accent-subtle) !important;
    }

    .file-diff-content pierre-container {
      display: block;
    }

    /* Empty States */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--color-fg-muted);
      gap: 16px;
      padding: 48px;
      text-align: center;
    }

    .empty-state-icon {
      width: 64px;
      height: 64px;
      background: var(--color-canvas-inset);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .empty-state-icon svg {
      width: 28px;
      height: 28px;
      color: var(--color-fg-muted);
      opacity: 0.5;
    }

    .empty-state-text {
      font-size: 14px;
    }

    /* Toast Notification */
    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: var(--color-fg-default);
      color: white;
      padding: 12px 20px;
      border-radius: var(--radius-md);
      font-size: 13px;
      font-weight: 500;
      box-shadow: var(--shadow-lg);
      z-index: 1000;
      opacity: 0;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .toast.show {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }

    .toast-icon {
      width: 18px;
      height: 18px;
    }

    /* Progress Bar */
    .progress-bar {
      height: 3px;
      background: var(--color-canvas-inset);
      border-radius: 2px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--color-success-emphasis) 0%, #22c55e 100%);
      transition: width 0.3s ease;
    }

    /* Scrollbar */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }

    ::-webkit-scrollbar-thumb {
      background: var(--color-border-default);
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--color-fg-muted);
    }

    /* Responsive */
    @media (max-width: 1400px) {
      .sidebar {
        width: 280px;
        min-width: 260px;
      }
      .conversation-panel {
        width: 40%;
        min-width: 340px;
      }
    }

    @media (max-width: 1200px) {
      .header-branch {
        max-width: 140px;
      }
    }
  </style>
</head>
<body>
  <div id="app">
    <header class="header">
      <div class="header-logo">
        <div class="header-logo-icon">dx</div>
        <span class="header-title">Branch Review</span>
      </div>
      <div class="header-divider"></div>
      <div class="header-branches">
        <span class="header-branch source" title="${escapeHtml(data.branch)}">${escapeHtml(data.branch)}</span>
        <span class="header-arrow">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </span>
        <span class="header-branch" title="${escapeHtml(data.baseBranch)}">${escapeHtml(data.baseBranch)}</span>
      </div>
      <div class="header-stats">
        <div class="header-stat-group">
          <span class="stat-add">+${data.branchDiff?.additions || 0}</span>
          <span class="stat-del">-${data.branchDiff?.deletions || 0}</span>
        </div>
        <div class="header-conv-count">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <span>${data.conversations.length} conversations</span>
        </div>
      </div>
    </header>
    
    <div class="main">
      <aside class="sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            Conversations
          </span>
          <span class="sidebar-count">${data.conversations.length}</span>
        </div>
        <div class="sidebar-search">
          <input type="text" class="search-input" id="conversation-search" placeholder="Filter conversations...">
        </div>
        <div class="conversation-list" id="conversation-list"></div>
      </aside>

      <div class="content">
        <div class="conversation-panel">
          <div class="panel-header">
            <span class="panel-title" id="conv-title">Select a conversation</span>
            <span class="panel-header-meta" id="conv-meta"></span>
          </div>
          <div class="messages-container" id="messages-container">
            <div class="empty-state">
              <div class="empty-state-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </div>
              <span class="empty-state-text">Select a conversation from the sidebar to view messages</span>
            </div>
          </div>
        </div>

        <div class="diff-panel">
          <div class="panel-header">
            <span class="panel-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
              Files Changed
            </span>
            <span class="panel-header-meta">
              <span id="viewed-count">0</span> of ${files.length} viewed
            </span>
          </div>
          <div class="diff-container">
            <div class="file-list" id="file-list">
              ${fileListHtml}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast">
    <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
    <span id="toast-message">Navigated to conversation</span>
  </div>
  
  <script id="review-data" type="application/json">${safeDataJson}</script>
  <script id="line-attribution-data" type="application/json">${lineAttrJson}</script>
  <script>
    const DATA = JSON.parse(document.getElementById('review-data').textContent);
    const LINE_ATTRIBUTIONS = JSON.parse(document.getElementById('line-attribution-data').textContent);

    const state = {
      selectedConversationId: null,
      highlightedMessageIndex: null,
      viewedFiles: new Set(),
      renderedMessages: new Map(),
      searchQuery: ''
    };

    function buildConversationFilesMap() {
      const map = {};

      if (DATA.branchDiff && DATA.branchDiff.lineAttributions) {
        for (const attr of DATA.branchDiff.lineAttributions) {
          if (!map[attr.conversationId]) map[attr.conversationId] = new Set();
          if (attr.fileEditPath) map[attr.conversationId].add(attr.fileEditPath);
        }
      }

      for (const commit of DATA.commits || []) {
        for (const convId of commit.attributedConversations || []) {
          if (!map[convId]) map[convId] = new Set();
          for (const file of commit.filesChanged || []) {
            map[convId].add(file);
          }
        }
        for (const attr of commit.lineAttributions || []) {
          if (!map[attr.conversationId]) map[attr.conversationId] = new Set();
          if (attr.fileEditPath) map[attr.conversationId].add(attr.fileEditPath);
        }
      }

      const result = {};
      for (const [convId, files] of Object.entries(map)) {
        result[convId] = Array.from(files);
      }
      return result;
    }

    const conversationFilesMap = buildConversationFilesMap();

    function escapeHtml(text) {
      if (!text) return '';
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function truncate(str, len) {
      if (!str) return '';
      return str.length <= len ? str : str.slice(0, len - 1) + '...';
    }

    function showToast(message) {
      const toast = document.getElementById('toast');
      const toastMessage = document.getElementById('toast-message');
      toastMessage.textContent = message;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3000);
    }

    function getSourceIcon(source) {
      const s = (source || '').toLowerCase();
      if (s.includes('claude')) return { class: 'claude-code', label: 'CC' };
      if (s.includes('cursor')) return { class: 'cursor', label: 'Cu' };
      if (s.includes('codex')) return { class: 'codex', label: 'Cx' };
      if (s.includes('opencode')) return { class: 'opencode', label: 'OC' };
      return { class: 'claude-code', label: 'AI' };
    }

    async function fetchRenderedMarkdown(content, msgId) {
      if (state.renderedMessages.has(msgId)) {
        return state.renderedMessages.get(msgId);
      }

      try {
        const response = await fetch('/api/render-markdown', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        });
        const data = await response.json();
        state.renderedMessages.set(msgId, data.html);
        return data.html;
      } catch (e) {
        console.error('Failed to render markdown:', e);
        return escapeHtml(content).replace(/\\n/g, '<br>');
      }
    }

    function getFilteredConversations() {
      if (!state.searchQuery) return DATA.conversations;
      const q = state.searchQuery.toLowerCase();
      return DATA.conversations.filter(conv => {
        const title = (conv.title || '').toLowerCase();
        const source = (conv.source || '').toLowerCase();
        const files = conversationFilesMap[conv.id] || [];
        return title.includes(q) || source.includes(q) || files.some(f => f.toLowerCase().includes(q));
      });
    }

    function renderConversationList() {
      const container = document.getElementById('conversation-list');
      const conversations = getFilteredConversations();

      if (conversations.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-state-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
            </div>
            <span class="empty-state-text">\${state.searchQuery ? 'No conversations match your search' : 'No conversations found'}</span>
          </div>\`;
        return;
      }

      container.innerHTML = conversations.map(conv => {
        const isActive = conv.id === state.selectedConversationId;
        const files = conversationFilesMap[conv.id] || [];
        const sourceIcon = getSourceIcon(conv.source);
        const fileBadges = files.slice(0, 2).map(f => {
          const name = f.split('/').pop() || f;
          return \`<span class="file-badge" title="\${escapeHtml(f)}">\${escapeHtml(name)}</span>\`;
        }).join('');
        const moreFiles = files.length > 2 ? \`<span class="file-badge">+\${files.length - 2}</span>\` : '';

        return \`
          <div class="conversation-item \${isActive ? 'active' : ''}" data-conv-id="\${conv.id}">
            <div class="conversation-header">
              <div class="source-icon \${sourceIcon.class}" title="\${escapeHtml(conv.source)}">\${sourceIcon.label}</div>
              <div class="conversation-title">\${escapeHtml(truncate(conv.title, 65))}</div>
            </div>
            <div class="conversation-meta">
              <span class="confidence-badge \${conv.confidence || 'low'}">\${conv.confidence || 'low'}</span>
              <span class="meta-item">\${conv.messageCount} msgs</span>
              \${fileBadges}\${moreFiles}
            </div>
          </div>
        \`;
      }).join('');

      container.querySelectorAll('.conversation-item').forEach(item => {
        item.addEventListener('click', () => {
          state.selectedConversationId = item.dataset.convId;
          state.highlightedMessageIndex = null;
          renderConversationList();
          renderMessages();
          highlightRelatedFiles();
        });
      });
    }

    function highlightRelatedFiles() {
      const files = conversationFilesMap[state.selectedConversationId] || [];
      const fileSet = new Set(files);

      document.querySelectorAll('.file-item').forEach(item => {
        const path = item.dataset.filePath;
        item.classList.remove('highlighted', 'dimmed');

        if (files.length > 0) {
          if (fileSet.has(path)) {
            item.classList.add('highlighted');
          } else {
            item.classList.add('dimmed');
          }
        }
      });
    }

    async function renderMessages() {
      const conv = DATA.conversations.find(c => c.id === state.selectedConversationId);
      const titleEl = document.getElementById('conv-title');
      const metaEl = document.getElementById('conv-meta');
      const container = document.getElementById('messages-container');

      if (!conv) {
        titleEl.textContent = 'Select a conversation';
        metaEl.textContent = '';
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-state-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <span class="empty-state-text">Select a conversation from the sidebar to view messages</span>
          </div>\`;
        return;
      }

      titleEl.textContent = truncate(conv.title, 45);
      metaEl.textContent = conv.messageCount + ' messages';

      const messages = (conv.messages || []).slice(0, 100);

      if (messages.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-state-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <span class="empty-state-text">No messages in this conversation</span>
          </div>\`;
        return;
      }

      container.innerHTML = \`
        <div class="empty-state">
          <div class="empty-state-icon" style="animation: pulse 1.5s infinite">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 6v6l4 2"/>
            </svg>
          </div>
          <span class="empty-state-text">Loading messages...</span>
        </div>\`;

      const userSvg = \`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>\`;
      const assistantSvg = \`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>\`;

      const messageHtmls = await Promise.all(messages.map(async (msg, idx) => {
        const isUser = msg.role === 'user';
        const roleClass = isUser ? 'user' : 'assistant';
        const avatar = isUser ? userSvg : assistantSvg;
        const isHighlighted = state.highlightedMessageIndex === idx;

        const msgId = \`\${conv.id}-\${idx}\`;
        const renderedContent = await fetchRenderedMarkdown(msg.content || '', msgId);

        return \`
          <div class="message \${roleClass} \${isHighlighted ? 'highlighted' : ''}" data-msg-index="\${idx}">
            <div class="message-header">
              <div class="message-avatar \${roleClass}">
                \${avatar}
              </div>
              <span class="message-role">\${isUser ? 'User' : 'Assistant'}</span>
            </div>
            <div class="message-content">
              \${renderedContent}
            </div>
          </div>
        \`;
      }));

      container.innerHTML = messageHtmls.join('');

      if (state.highlightedMessageIndex !== null) {
        const highlightedMsg = container.querySelector(\`[data-msg-index="\${state.highlightedMessageIndex}"]\`);
        if (highlightedMsg) {
          setTimeout(() => {
            highlightedMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 100);
        }
      }
    }

    function navigateToConversationMessage(conversationId, messageIndex, fromDiffClick = false) {
      const conv = DATA.conversations.find(c => c.id === conversationId);
      state.selectedConversationId = conversationId;
      state.highlightedMessageIndex = messageIndex;
      renderConversationList();
      renderMessages();
      highlightRelatedFiles();

      if (fromDiffClick && conv) {
        showToast(\`Navigated to: \${truncate(conv.title, 40)}\`);
      }
    }

    function setupDiffLineClickHandlers() {
      document.querySelectorAll('.file-item').forEach(fileItem => {
        const filePath = fileItem.dataset.filePath;
        if (!filePath) return;

        const diffContent = fileItem.querySelector('.file-diff-content');
        if (!diffContent) return;

        // @pierre/diffs uses data-line="N" attribute on div elements
        // Only target addition lines (data-line-type contains 'addition')
        const lineElements = diffContent.querySelectorAll('[data-line][data-line-type*="addition"]');

        lineElements.forEach(lineEl => {
          const lineNum = lineEl.getAttribute('data-line');
          if (!lineNum) return;

          const key = \`\${filePath}:\${lineNum}\`;
          const attrs = LINE_ATTRIBUTIONS[key];

          if (attrs && attrs.length > 0) {
            lineEl.classList.add('diff-line-clickable');
            lineEl.classList.add('diff-line-attributed');
            lineEl.title = \`Click to view: \${attrs[0].conversationTitle}\`;
            lineEl.addEventListener('click', (e) => {
              e.stopPropagation();
              const attr = attrs[0];
              navigateToConversationMessage(attr.conversationId, attr.messageIndex || 0, true);
            });
          }
        });
      });
    }

    function setupFileHandlers() {
      document.querySelectorAll('.file-header').forEach(header => {
        header.addEventListener('click', (e) => {
          if (e.target.closest('.viewed-checkbox')) return;
          const fileItem = header.closest('.file-item');
          fileItem.classList.toggle('collapsed');
        });
      });

      document.querySelectorAll('input[data-viewed-path]').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
          const path = checkbox.dataset.viewedPath;
          const label = checkbox.closest('.viewed-checkbox');

          if (checkbox.checked) {
            state.viewedFiles.add(path);
            label.classList.add('checked');
          } else {
            state.viewedFiles.delete(path);
            label.classList.remove('checked');
          }

          updateViewedCount();
        });
      });
    }

    function setupSearch() {
      const searchInput = document.getElementById('conversation-search');
      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          state.searchQuery = e.target.value;
          renderConversationList();
        });
      }
    }

    function updateViewedCount() {
      const total = document.querySelectorAll('input[data-viewed-path]').length;
      const viewed = state.viewedFiles.size;
      document.getElementById('viewed-count').textContent = viewed;
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Cmd/Ctrl+K to focus search
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('conversation-search')?.focus();
      }
      // Escape to clear search
      if (e.key === 'Escape') {
        const searchInput = document.getElementById('conversation-search');
        if (searchInput && document.activeElement === searchInput) {
          searchInput.value = '';
          state.searchQuery = '';
          renderConversationList();
          searchInput.blur();
        }
      }
    });

    // Initialize
    renderConversationList();
    setupFileHandlers();
    setupDiffLineClickHandlers();
    setupSearch();

    if (DATA.conversations.length > 0) {
      state.selectedConversationId = DATA.conversations[0].id;
      renderConversationList();
      renderMessages();
      highlightRelatedFiles();
    }
  </script>
</body>
</html>`;
}

export async function startReviewServer(options: ServerOptions): Promise<{ port: number; close: () => void }> {
  const { data, port = 0 } = options;

  console.log('Pre-rendering diffs...');
  const lineAttributionMap = buildLineAttributionMap(data);
  const renderedDiffs = await prerenderDiffs(data.branchDiff?.rawDiff || '', lineAttributionMap);
  console.log(`Rendered ${renderedDiffs.size} file diffs`);

  await getHighlighter();

  const html = generateHtml(data, renderedDiffs, lineAttributionMap);

  const app = new Hono();

  app.get('/', (c) => {
    return c.html(html);
  });

  app.get('/favicon.ico', (c) => {
    // SVG favicon as data URI - "dx" logo
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#6366f1"/><text x="16" y="22" font-family="system-ui" font-size="16" font-weight="bold" fill="white" text-anchor="middle">dx</text></svg>`;
    const base64 = Buffer.from(svg).toString('base64');
    return c.body(Buffer.from(svg), 200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    });
  });

  app.get('/api/data', (c) => {
    return c.json(data);
  });

  app.post('/api/render-markdown', async (c) => {
    try {
      const body = await c.req.json();
      const content = body.content || '';
      
      const lines = content.split('\n');
      const renderedParts: string[] = [];
      let currentText = '';
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const json = JSON.parse(trimmed);
            if (json.name || json.tool || json.type === 'tool_use' || (json.function && json.arguments)) {
              if (currentText.trim()) {
                const md = await renderMarkdown(currentText);
                renderedParts.push(md);
                currentText = '';
              }
              let name = json.name || (json.function ? json.function.name : 'Tool');
              let args = '';
              const input = json.input || json.arguments || (json.function ? json.function.arguments : {});
              if (typeof input === 'string') {
                args = input;
              } else if (input.path || input.filePath) {
                args = 'path: ' + (input.path || input.filePath);
              } else if (input.command) {
                args = 'cmd: ' + input.command;
              } else if (input.query) {
                args = 'query: ' + input.query;
              }
              if (args.length > 50) args = args.slice(0, 50) + '...';
              
              const jsonStr = JSON.stringify(json, null, 2);
              renderedParts.push(`
                <div class="tool-call">
                  <div class="tool-call-summary" onclick="this.parentElement.classList.toggle('expanded')">
                    <div class="tool-call-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                      </svg>
                    </div>
                    <span class="tool-call-name">${escapeHtml(name)}</span>
                    <span class="tool-call-args">${escapeHtml(args)}</span>
                    <svg class="tool-call-chevron" viewBox="0 0 16 16" width="12" height="12">
                      <path fill="currentColor" d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"/>
                    </svg>
                  </div>
                  <div class="tool-call-details">
                    <pre class="tool-json">${escapeHtml(jsonStr)}</pre>
                  </div>
                </div>
              `);
              continue;
            }
          } catch { }
        }
        currentText += line + '\n';
      }
      
      if (currentText.trim()) {
        const md = await renderMarkdown(currentText);
        renderedParts.push(md);
      }
      
      return c.json({ html: renderedParts.join('') });
    } catch (e) {
      console.error('Markdown render error:', e);
      return c.json({ html: '<p>Error rendering content</p>' }, 500);
    }
  });

  const actualPort = port || 3456;

  const server = serve({
    fetch: app.fetch,
    port: actualPort,
  });

  return {
    port: actualPort,
    close: () => server.close(),
  };
}
