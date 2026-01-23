export function generateReviewHtml(dataJson: string): string {
  // Escape </script> to prevent premature closing of script tag
  const safeJson = dataJson.replace(/<\/script>/gi, '\\u003c/script>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Branch Review</title>
  
  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  
  <!-- @pierre/diffs -->
  <script type="module">
    import { FileDiff, parsePatchFiles } from 'https://esm.sh/@pierre/diffs@1.0.4';
    window.FileDiff = FileDiff;
    window.parsePatchFiles = parsePatchFiles;
    window.pierreReady = true;
    window.dispatchEvent(new Event('pierre-ready'));
  </script>
  
  <style>
    /* ═══════════════════════════════════════════════════════════════════════════
       CSS RESET & VARIABLES - GitHub Light Style
       ═══════════════════════════════════════════════════════════════════════════ */
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    :root {
      /* GitHub Light palette */
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
      --color-success-fg: #1a7f37;
      --color-success-emphasis: #1f883d;
      --color-danger-fg: #d1242f;
      --color-success-subtle: #dafbe1;
      --color-danger-subtle: #ffebe9;
      
      /* Sizing */
      --header-height: 64px;
      --sidebar-width: 320px;
      
      /* Typography */
      --font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
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
    }
    
    /* ═══════════════════════════════════════════════════════════════════════════
       LAYOUT
       ═══════════════════════════════════════════════════════════════════════════ */
    #app {
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    
    /* Header */
    .header {
      height: var(--header-height);
      background: var(--color-canvas-subtle);
      border-bottom: 1px solid var(--color-border-default);
      display: flex;
      align-items: center;
      padding: 0 24px;
      gap: 16px;
      flex-shrink: 0;
    }
    
    .header-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--color-fg-default);
    }
    
    .header-branch {
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--color-canvas-inset);
      padding: 4px 8px;
      border-radius: 6px;
      color: var(--color-accent-fg);
      border: 1px solid var(--color-border-default);
    }
    
    .header-stats {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: var(--font-mono);
      font-size: 13px;
    }
    
    .stat-add { color: var(--color-success-fg); }
    .stat-del { color: var(--color-danger-fg); }
    
    /* Main Content */
    .main {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
    
    /* ═══════════════════════════════════════════════════════════════════════════
       SIDEBAR - Conversations List
       ═══════════════════════════════════════════════════════════════════════════ */
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
      padding: 16px;
      border-bottom: 1px solid var(--color-border-default);
      font-weight: 600;
      font-size: 14px;
      background: var(--color-canvas-default);
    }
    
    .conversation-list {
      flex: 1;
      overflow-y: auto;
    }
    
    .conversation-item {
      padding: 12px 16px;
      border-bottom: 1px solid var(--color-border-muted);
      cursor: pointer;
      transition: background 0.15s ease;
    }
    
    .conversation-item:hover {
      background: var(--color-canvas-default);
    }
    
    .conversation-item.active {
      background: var(--color-canvas-default);
      border-left: 3px solid var(--color-accent-emphasis);
      padding-left: 13px;
    }
    
    .conversation-title {
      font-weight: 500;
      font-size: 13px;
      color: var(--color-fg-default);
      margin-bottom: 4px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    
    .conversation-meta {
      font-size: 12px;
      color: var(--color-fg-muted);
      display: flex;
      gap: 8px;
      align-items: center;
    }
    
    .confidence-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 500;
    }
    
    .confidence-badge.high {
      background: var(--color-success-subtle);
      color: var(--color-success-fg);
    }
    
    .confidence-badge.medium {
      background: #fff8c5;
      color: #9a6700;
    }
    
    .confidence-badge.low {
      background: var(--color-canvas-inset);
      color: var(--color-fg-muted);
    }
    
    /* ═══════════════════════════════════════════════════════════════════════════
       CONTENT AREA - Split between Conversation and Diff
       ═══════════════════════════════════════════════════════════════════════════ */
    .content {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
    
    /* Conversation Panel */
    .conversation-panel {
      width: 45%;
      min-width: 300px;
      border-right: 1px solid var(--color-border-default);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    .panel-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--color-border-default);
      background: var(--color-canvas-subtle);
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    
    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }
    
    .message {
      margin-bottom: 24px;
    }
    
    .message:last-child {
      margin-bottom: 0;
    }
    
    .message-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    
    .message-avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      flex-shrink: 0;
    }
    
    .message-avatar.user {
      background: var(--color-canvas-inset);
      border: 1px solid var(--color-border-default);
    }
    
    .message-avatar.assistant {
      background: linear-gradient(135deg, #238636 0%, #2ea043 100%);
      color: white;
    }
    
    .message-role {
      font-weight: 600;
      font-size: 13px;
    }
    
    .message-time {
      font-size: 12px;
      color: var(--color-fg-muted);
    }
    
    .message-content {
      padding-left: 36px;
      font-size: 14px;
      line-height: 1.6;
      color: var(--color-fg-default);
    }
    
    .message-content p {
      margin-bottom: 12px;
    }
    
    .message-content p:last-child {
      margin-bottom: 0;
    }
    
    .message-content pre {
      background: var(--color-canvas-subtle);
      border: 1px solid var(--color-border-default);
      border-radius: 6px;
      padding: 12px;
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: 12px;
      margin: 12px 0;
    }
    
    .message-content code:not(pre code) {
      background: var(--color-canvas-subtle);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    
    /* Diff Panel */
    .diff-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 400px;
    }
    
    .diff-container {
      flex: 1;
      overflow: auto;
      padding: 0;
    }
    
    /* File list in diff panel */
    .file-list {
      padding: 16px;
    }
    
    .file-item {
      margin-bottom: 16px;
      border: 1px solid var(--color-border-default);
      border-radius: 6px;
      overflow: hidden;
    }
    
    .file-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: var(--color-canvas-subtle);
      border-bottom: 1px solid var(--color-border-default);
      cursor: pointer;
    }
    
    .file-header:hover {
      background: var(--color-canvas-inset);
    }
    
    .file-name {
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 500;
      color: var(--color-fg-default);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .file-stats {
      display: flex;
      gap: 8px;
      font-family: var(--font-mono);
      font-size: 12px;
    }
    
    .file-diff-content {
      background: var(--color-canvas-default);
    }
    
    /* Pierre diffs container styling */
    .file-diff-content pierre-container {
      display: block;
    }
    
    /* Viewed checkbox */
    .viewed-checkbox {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--color-fg-muted);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
    }
    
    .viewed-checkbox:hover {
      background: var(--color-canvas-inset);
    }
    
    .viewed-checkbox input {
      accent-color: var(--color-success-emphasis);
    }
    
    .viewed-checkbox.checked {
      color: var(--color-success-fg);
    }
    
    /* Empty state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--color-fg-muted);
      gap: 8px;
      padding: 40px;
      text-align: center;
    }
    
    .empty-state-icon {
      font-size: 32px;
      opacity: 0.5;
    }
    
    /* Loading state */
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--color-fg-muted);
    }
    
    /* ═══════════════════════════════════════════════════════════════════════════
       SCROLLBARS
       ═══════════════════════════════════════════════════════════════════════════ */
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
    
    /* ═══════════════════════════════════════════════════════════════════════════
       RESPONSIVE
       ═══════════════════════════════════════════════════════════════════════════ */
    @media (max-width: 1200px) {
      .sidebar {
        width: 260px;
        min-width: 260px;
      }
      .conversation-panel {
        width: 40%;
        min-width: 280px;
      }
    }
  </style>
</head>
<body>
  <div id="app">
    <div class="loading">Loading...</div>
  </div>
  
  <script id="review-data" type="application/json">${safeJson}</script>
  <script type="module">
    // ═══════════════════════════════════════════════════════════════════════════
    // DATA & STATE
    // ═══════════════════════════════════════════════════════════════════════════
    const DATA = JSON.parse(document.getElementById('review-data').textContent);
    
    const state = {
      selectedConversationId: DATA.conversations[0]?.id || null,
      viewedFiles: new Set(),
      expandedFiles: new Set(),
      fileDiffInstances: new Map()
    };
    
    // ═══════════════════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════════════════
    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    function formatDate(dateStr) {
      if (!dateStr) return '';
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    }
    
    function truncate(str, len) {
      if (!str) return '';
      return str.length <= len ? str : str.slice(0, len - 1) + '...';
    }
    
    // Parse unified diff into files
    function parseDiffIntoFiles(rawDiff) {
      if (!rawDiff) return [];
      
      const files = [];
      let currentFile = null;
      let currentContent = [];
      
      const lines = rawDiff.split('\\n');
      
      for (const line of lines) {
        if (line.startsWith('diff --git')) {
          if (currentFile) {
            currentFile.content = currentContent.join('\\n');
            files.push(currentFile);
          }
          currentFile = { path: '', additions: 0, deletions: 0 };
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
        currentFile.content = currentContent.join('\\n');
        files.push(currentFile);
      }
      
      return files;
    }
    
    // Render markdown-like content (basic)
    function renderContent(content) {
      if (!content) return '';
      
      let html = escapeHtml(content);
      
      // Code blocks
      html = html.replace(/\`\`\`([a-z]*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
        return \`<pre><code>\${code}</code></pre>\`;
      });
      
      // Inline code
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      
      // Paragraphs
      html = html.split('\\n\\n').map(p => \`<p>\${p}</p>\`).join('');
      
      return html;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RENDER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════
    function renderHeader() {
      const additions = DATA.branchDiff?.additions || 0;
      const deletions = DATA.branchDiff?.deletions || 0;
      
      return \`
        <header class="header">
          <span class="header-title">Branch Review</span>
          <span class="header-branch">\${escapeHtml(DATA.branch)}</span>
          <span style="color: var(--color-fg-muted)">into</span>
          <span class="header-branch">\${escapeHtml(DATA.baseBranch)}</span>
          <div class="header-stats">
            <span class="stat-add">+\${additions}</span>
            <span class="stat-del">-\${deletions}</span>
            <span style="color: var(--color-fg-muted)">\${DATA.conversations.length} conversations</span>
          </div>
        </header>
      \`;
    }
    
    function renderSidebar() {
      if (DATA.conversations.length === 0) {
        return \`
          <aside class="sidebar">
            <div class="sidebar-header">Conversations</div>
            <div class="empty-state">
              <span class="empty-state-icon">💬</span>
              <span>No conversations found</span>
            </div>
          </aside>
        \`;
      }
      
      const items = DATA.conversations.map(conv => {
        const isActive = conv.id === state.selectedConversationId;
        return \`
          <div class="conversation-item \${isActive ? 'active' : ''}" data-conv-id="\${conv.id}">
            <div class="conversation-title">\${escapeHtml(truncate(conv.title, 60))}</div>
            <div class="conversation-meta">
              <span class="confidence-badge \${conv.confidence || 'low'}">\${conv.confidence || 'low'}</span>
              <span>\${conv.messageCount} msgs</span>
              <span>\${escapeHtml(conv.source)}</span>
            </div>
          </div>
        \`;
      }).join('');
      
      return \`
        <aside class="sidebar">
          <div class="sidebar-header">Conversations (\${DATA.conversations.length})</div>
          <div class="conversation-list">\${items}</div>
        </aside>
      \`;
    }
    
    function renderConversationPanel() {
      const conv = DATA.conversations.find(c => c.id === state.selectedConversationId);
      
      if (!conv) {
        return \`
          <div class="conversation-panel">
            <div class="panel-header">Conversation</div>
            <div class="empty-state">
              <span class="empty-state-icon">💬</span>
              <span>Select a conversation</span>
            </div>
          </div>
        \`;
      }
      
      const messages = (conv.messages || []).map(msg => {
        const isUser = msg.role === 'user';
        return \`
          <div class="message" data-msg-id="\${msg.id || ''}">
            <div class="message-header">
              <div class="message-avatar \${isUser ? 'user' : 'assistant'}">
                \${isUser ? '👤' : '🤖'}
              </div>
              <span class="message-role">\${isUser ? 'User' : 'Assistant'}</span>
              <span class="message-time">\${formatDate(msg.timestamp || msg.createdAt)}</span>
            </div>
            <div class="message-content">
              \${renderContent(msg.content)}
            </div>
          </div>
        \`;
      }).join('');
      
      return \`
        <div class="conversation-panel">
          <div class="panel-header">
            <span>\${escapeHtml(truncate(conv.title, 40))}</span>
            <span style="font-weight: normal; color: var(--color-fg-muted); font-size: 12px;">\${conv.messageCount} messages</span>
          </div>
          <div class="messages-container">
            \${messages || '<div class="empty-state">No messages</div>'}
          </div>
        </div>
      \`;
    }
    
    function renderDiffPanel() {
      const files = parseDiffIntoFiles(DATA.branchDiff?.rawDiff);
      
      if (files.length === 0) {
        return \`
          <div class="diff-panel">
            <div class="panel-header">Files Changed</div>
            <div class="empty-state">
              <span class="empty-state-icon">📄</span>
              <span>No diff available</span>
            </div>
          </div>
        \`;
      }
      
      const fileItems = files.map((file, index) => {
        const isViewed = state.viewedFiles.has(file.path);
        const isExpanded = state.expandedFiles.has(file.path) || state.expandedFiles.size === 0;
        
        return \`
          <div class="file-item" data-file-path="\${escapeHtml(file.path)}">
            <div class="file-header" data-file-index="\${index}">
              <span class="file-name">
                <span>\${isExpanded ? '▼' : '▶'}</span>
                📄 \${escapeHtml(file.path)}
              </span>
              <div style="display: flex; align-items: center; gap: 12px;">
                <span class="file-stats">
                  <span class="stat-add">+\${file.additions}</span>
                  <span class="stat-del">-\${file.deletions}</span>
                </span>
                <label class="viewed-checkbox \${isViewed ? 'checked' : ''}">
                  <input type="checkbox" \${isViewed ? 'checked' : ''} data-viewed-path="\${escapeHtml(file.path)}">
                  Viewed
                </label>
              </div>
            </div>
            <div class="file-diff-content" id="diff-\${index}" style="display: \${isExpanded ? 'block' : 'none'};" data-diff-content="\${encodeURIComponent(file.content)}"></div>
          </div>
        \`;
      }).join('');
      
      return \`
        <div class="diff-panel">
          <div class="panel-header">
            <span>Files Changed (\${files.length})</span>
            <span style="font-weight: normal; color: var(--color-fg-muted); font-size: 12px;">
              \${state.viewedFiles.size} of \${files.length} viewed
            </span>
          </div>
          <div class="diff-container">
            <div class="file-list">\${fileItems}</div>
          </div>
        </div>
      \`;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // MAIN RENDER
    // ═══════════════════════════════════════════════════════════════════════════
    function render() {
      const app = document.getElementById('app');
      app.innerHTML = \`
        \${renderHeader()}
        <div class="main">
          \${renderSidebar()}
          <div class="content">
            \${renderConversationPanel()}
            \${renderDiffPanel()}
          </div>
        </div>
      \`;
      
      attachEventListeners();
      renderDiffs();
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EVENT HANDLERS
    // ═══════════════════════════════════════════════════════════════════════════
    function attachEventListeners() {
      // Conversation selection
      document.querySelectorAll('.conversation-item').forEach(item => {
        item.addEventListener('click', () => {
          state.selectedConversationId = item.dataset.convId;
          render();
        });
      });
      
      // File expand/collapse
      document.querySelectorAll('.file-header').forEach(header => {
        header.addEventListener('click', (e) => {
          if (e.target.closest('.viewed-checkbox')) return;
          
          const fileItem = header.closest('.file-item');
          const path = fileItem.dataset.filePath;
          
          if (state.expandedFiles.has(path)) {
            state.expandedFiles.delete(path);
          } else {
            state.expandedFiles.add(path);
          }
          render();
        });
      });
      
      // Viewed checkboxes
      document.querySelectorAll('input[data-viewed-path]').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
          e.stopPropagation();
          const path = checkbox.dataset.viewedPath;
          if (checkbox.checked) {
            state.viewedFiles.add(path);
          } else {
            state.viewedFiles.delete(path);
          }
          render();
        });
      });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // RENDER DIFFS WITH @pierre/diffs
    // ═══════════════════════════════════════════════════════════════════════════
    async function renderDiffs() {
      // Wait for pierre/diffs to load
      if (!window.pierreReady) {
        await new Promise(resolve => {
          window.addEventListener('pierre-ready', resolve, { once: true });
        });
      }
      
      const { FileDiff, parsePatchFiles } = window;
      
      document.querySelectorAll('.file-diff-content').forEach(async (container) => {
        if (container.style.display === 'none') return;
        if (container.dataset.rendered) return;
        
        const diffContent = decodeURIComponent(container.dataset.diffContent);
        if (!diffContent) return;
        
        try {
          // Parse the patch to get file info
          const patches = parsePatchFiles(diffContent);
          
          if (patches.length > 0 && patches[0].files?.length > 0) {
            const fileDiff = patches[0].files[0];
            
            const instance = new FileDiff({
              theme: { dark: 'github-dark', light: 'github-light' },
              diffStyle: 'split',
            });
            
            instance.render({
              fileDiff,
              fileContainer: container
            });
            
            container.dataset.rendered = 'true';
          }
        } catch (err) {
          // Fallback to simple rendering
          container.innerHTML = \`<pre style="padding: 12px; font-family: var(--font-mono); font-size: 12px; overflow-x: auto;">\${escapeHtml(diffContent)}</pre>\`;
          container.dataset.rendered = 'true';
        }
      });
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // INITIALIZE
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Expand first few files by default
    const files = parseDiffIntoFiles(DATA.branchDiff?.rawDiff);
    files.slice(0, 3).forEach(f => state.expandedFiles.add(f.path));
    
    render();
  </script>
</body>
</html>`;
}
