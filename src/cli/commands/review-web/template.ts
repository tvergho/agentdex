export function generateReviewHtml(dataJson: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Branch Review</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html/bundles/css/diff2html.min.css">
  <script src="https://cdn.jsdelivr.net/npm/diff2html/bundles/js/diff2html-ui.min.js"></script>
  <style>
    .d2h-wrapper { background: #0d1117; }
    .d2h-file-header { background: #161b22 !important; border-color: #30363d !important; }
    .d2h-file-name { color: #c9d1d9 !important; }
    .d2h-code-line { background: #0d1117 !important; }
    .d2h-code-line-ctn { color: #c9d1d9 !important; }
    .d2h-ins { background: rgba(46, 160, 67, 0.15) !important; }
    .d2h-ins .d2h-code-line-ctn { color: #7ee787 !important; }
    .d2h-del { background: rgba(248, 81, 73, 0.15) !important; }
    .d2h-del .d2h-code-line-ctn { color: #ffa198 !important; }
    .d2h-info { background: #161b22 !important; color: #8b949e !important; }
    .d2h-file-list { background: #0d1117 !important; border-color: #30363d !important; }
    .d2h-file-list-wrapper { background: #0d1117 !important; }
    .d2h-file-list-line { color: #c9d1d9 !important; }
    .d2h-code-linenumber { background: #161b22 !important; color: #8b949e !important; border-color: #30363d !important; }
    .d2h-code-side-linenumber { background: #161b22 !important; }
    .d2h-diff-table { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
    .d2h-file-diff { border-color: #30363d !important; }
    .d2h-emptyplaceholder { background: #161b22 !important; }
    .line-attributed { background: rgba(59, 130, 246, 0.25) !important; }
    .line-attribution { 
      color: #60a5fa; 
      font-size: 0.75rem; 
      margin-left: 1rem;
      cursor: pointer;
      opacity: 0.8;
    }
    .line-attribution:hover { opacity: 1; text-decoration: underline; }
    .diff-add { color: #7ee787; }
    .diff-del { color: #ffa198; }
    .diff-hunk { color: #60a5fa; }
    pre code { white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body class="bg-gray-900 text-gray-100 min-h-screen">
  <div id="app"></div>
  
  <script>
    const DATA = ${dataJson};
    
    // State
    let currentView = 'dashboard';
    let selectedCommit = null;
    let selectedConversation = null;
    
    // Render functions
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    function formatDate(dateStr) {
      return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    }
    
    function coverageBar(percent) {
      const filled = Math.floor(percent / 10);
      const empty = 10 - filled;
      const color = percent >= 70 ? 'bg-green-500' : percent >= 40 ? 'bg-yellow-500' : 'bg-red-500';
      return \`
        <div class="flex items-center gap-2">
          <div class="flex gap-0.5">
            \${Array(filled).fill('<div class="w-2 h-4 \${color} rounded-sm"></div>').join('')}
            \${Array(empty).fill('<div class="w-2 h-4 bg-gray-700 rounded-sm"></div>').join('')}
          </div>
          <span class="text-sm text-gray-400">\${percent}%</span>
        </div>
      \`;
    }
    
    function renderDiff(diff, lineAttributions) {
      const attrMap = new Map();
      if (lineAttributions) {
        for (const attr of lineAttributions) {
          attrMap.set(attr.lineContent, attr);
        }
      }
      
      return diff.split('\\n').map(line => {
        const lineContent = line.startsWith('+') ? line.slice(1).trim() : null;
        const attr = lineContent ? attrMap.get(lineContent) : null;
        
        if (line.startsWith('+') && !line.startsWith('+++')) {
          if (attr) {
            const convTitle = escapeHtml(attr.conversationTitle.slice(0, 40));
            return \`<span class="diff-add line-attributed">\${escapeHtml(line)}<span class="line-attribution" onclick="showConversation('\${attr.conversationId}')" title="\${escapeHtml(attr.conversationTitle)}">← \${convTitle}</span></span>\`;
          }
          return \`<span class="diff-add">\${escapeHtml(line)}</span>\`;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          return \`<span class="diff-del">\${escapeHtml(line)}</span>\`;
        } else if (line.startsWith('@@')) {
          return \`<span class="diff-hunk">\${escapeHtml(line)}</span>\`;
        }
        return escapeHtml(line);
      }).join('\\n');
    }
    
    let diff2htmlRendered = false;
    
    function renderFilesChanged() {
      const bd = DATA.branchDiff;
      if (!bd) return '<div class="p-8 text-gray-400">No branch diff available</div>';
      
      return \`
        <div class="max-w-7xl mx-auto px-4 py-8">
          <div class="flex items-center justify-between mb-6">
            <h1 class="text-2xl font-bold">Files Changed</h1>
            <div class="flex items-center gap-4 text-sm">
              <span class="text-green-400">+\${bd.additions} additions</span>
              <span class="text-red-400">-\${bd.deletions} deletions</span>
              <span class="text-gray-400">\${bd.filesChanged.length} files</span>
            </div>
          </div>
          
          <div class="mb-4 flex items-center gap-4">
            <div class="flex items-center gap-2">
              \${coverageBar(DATA.summary.overallCoveragePercent)}
              <span class="text-sm text-gray-400">
                \${DATA.summary.matchedLines}/\${DATA.summary.totalLines} lines from AI conversations
              </span>
            </div>
          </div>
          
          <div class="mb-4 text-sm text-gray-400">
            💡 Lines highlighted in <span class="text-blue-400">blue</span> were generated by AI conversations
          </div>
          
          <div id="diff2html-container" class="rounded-lg overflow-hidden border border-gray-700"></div>
        </div>
      \`;
    }
    
    function initDiff2Html() {
      if (!DATA.branchDiff || diff2htmlRendered) return;
      
      const container = document.getElementById('diff2html-container');
      if (!container) return;
      
      const diffString = DATA.branchDiff.rawDiff;
      const attrMap = new Map();
      if (DATA.branchDiff.lineAttributions) {
        for (const attr of DATA.branchDiff.lineAttributions) {
          attrMap.set(attr.lineContent, attr);
        }
      }
      
      const diff2htmlUi = new Diff2HtmlUI(container, diffString, {
        drawFileList: true,
        matching: 'lines',
        outputFormat: 'side-by-side',
        highlight: true,
        fileListToggle: true,
        fileListStartVisible: true,
        fileContentToggle: true,
        synchronisedScroll: true
      });
      
      diff2htmlUi.draw();
      diff2htmlUi.highlightCode();
      diff2htmlRendered = true;
      
      setTimeout(() => {
        const addedLines = container.querySelectorAll('.d2h-ins .d2h-code-line-ctn');
        addedLines.forEach(lineEl => {
          const lineText = lineEl.textContent?.trim() || '';
          const attr = attrMap.get(lineText);
          if (attr) {
            const row = lineEl.closest('tr') || lineEl.closest('.d2h-code-line');
            if (row) {
              row.classList.add('line-attributed');
              row.title = 'From: ' + attr.conversationTitle;
              row.style.cursor = 'pointer';
              row.onclick = () => showConversation(attr.conversationId);
            }
          }
        });
      }, 100);
    }
    
    function renderNav() {
      return \`
        <nav class="bg-gray-800 border-b border-gray-700 sticky top-0 z-10">
          <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
            <div class="flex items-center gap-4">
              <button onclick="navigate('dashboard')" class="text-xl font-bold hover:text-blue-400 transition-colors">
                📊 Branch Review
              </button>
              <span class="text-gray-500">|</span>
              <span class="text-gray-400">\${DATA.branch}</span>
              <span class="text-gray-600">→</span>
              <span class="text-gray-500">\${DATA.baseBranch}</span>
            </div>
            <div class="flex items-center gap-2">
              \${DATA.branchDiff ? \`
                <button onclick="navigate('files')" 
                  class="px-3 py-1 rounded \${currentView === 'files' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'} transition-colors">
                  Files Changed
                </button>
              \` : ''}
              <button onclick="navigate('commits')" 
                class="px-3 py-1 rounded \${currentView === 'commits' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'} transition-colors">
                Commits
              </button>
              <button onclick="navigate('conversations')" 
                class="px-3 py-1 rounded \${currentView === 'conversations' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'} transition-colors">
                Conversations
              </button>
            </div>
          </div>
        </nav>
      \`;
    }
    
    function renderDashboard() {
      const s = DATA.summary;
      return \`
        <div class="max-w-7xl mx-auto px-4 py-8">
          <h1 class="text-3xl font-bold mb-2">\${DATA.branch}</h1>
          <p class="text-gray-400 mb-8">Compared to \${DATA.baseBranch} • Exported \${formatDate(DATA.exportedAt)}</p>
          
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <div class="bg-gray-800 rounded-lg p-4">
              <div class="text-3xl font-bold text-blue-400">\${s.totalCommits}</div>
              <div class="text-gray-400">Total Commits</div>
            </div>
            <div class="bg-gray-800 rounded-lg p-4">
              <div class="text-3xl font-bold text-green-400">\${s.matchedCommits}</div>
              <div class="text-gray-400">Matched Commits</div>
            </div>
            <div class="bg-gray-800 rounded-lg p-4">
              <div class="text-3xl font-bold text-yellow-400">\${DATA.conversations.length}</div>
              <div class="text-gray-400">Conversations</div>
            </div>
            <div class="bg-gray-800 rounded-lg p-4">
              <div class="text-3xl font-bold \${s.overallCoveragePercent >= 50 ? 'text-green-400' : 'text-orange-400'}">\${s.overallCoveragePercent}%</div>
              <div class="text-gray-400">Code Coverage</div>
            </div>
          </div>
          
          <div class="grid md:grid-cols-2 gap-8">
            <div>
              <h2 class="text-xl font-semibold mb-4 flex items-center gap-2">
                <span>📝</span> Recent Commits
              </h2>
              <div class="space-y-2">
                \${DATA.commits.slice(0, 5).map(c => \`
                  <button onclick="showCommit('\${c.hash}')" 
                    class="w-full text-left bg-gray-800 hover:bg-gray-750 rounded-lg p-3 transition-colors">
                    <div class="flex items-center justify-between mb-1">
                      <code class="text-blue-400">\${c.shortHash}</code>
                      \${coverageBar(c.coveragePercent)}
                    </div>
                    <div class="text-sm text-gray-300 truncate">\${escapeHtml(c.message)}</div>
                  </button>
                \`).join('')}
                \${DATA.commits.length > 5 ? \`
                  <button onclick="navigate('commits')" class="text-blue-400 hover:text-blue-300 text-sm">
                    View all \${DATA.commits.length} commits →
                  </button>
                \` : ''}
              </div>
            </div>
            
            <div>
              <h2 class="text-xl font-semibold mb-4 flex items-center gap-2">
                <span>💬</span> Conversations
              </h2>
              <div class="space-y-2">
                \${DATA.conversations.slice(0, 5).map(c => \`
                  <button onclick="showConversation('\${c.id}')" 
                    class="w-full text-left bg-gray-800 hover:bg-gray-750 rounded-lg p-3 transition-colors">
                    <div class="text-gray-300 truncate">\${escapeHtml(c.title)}</div>
                    <div class="text-sm text-gray-500 mt-1">
                      \${c.source} • \${c.messageCount} messages • \${formatDate(c.date)}
                    </div>
                  </button>
                \`).join('')}
                \${DATA.conversations.length > 5 ? \`
                  <button onclick="navigate('conversations')" class="text-blue-400 hover:text-blue-300 text-sm">
                    View all \${DATA.conversations.length} conversations →
                  </button>
                \` : ''}
              </div>
            </div>
          </div>
        </div>
      \`;
    }
    
    function renderCommitsList() {
      return \`
        <div class="max-w-7xl mx-auto px-4 py-8">
          <h1 class="text-2xl font-bold mb-6">All Commits (\${DATA.commits.length})</h1>
          <div class="space-y-2">
            \${DATA.commits.map(c => \`
              <button onclick="showCommit('\${c.hash}')" 
                class="w-full text-left bg-gray-800 hover:bg-gray-750 rounded-lg p-4 transition-colors">
                <div class="flex items-center justify-between mb-2">
                  <div class="flex items-center gap-3">
                    <code class="text-blue-400 font-mono">\${c.shortHash}</code>
                    <span class="text-gray-300">\${escapeHtml(c.message)}</span>
                  </div>
                  \${coverageBar(c.coveragePercent)}
                </div>
                <div class="flex items-center gap-4 text-sm text-gray-500">
                  <span>\${c.author}</span>
                  <span>\${formatDate(c.date)}</span>
                  <span>\${c.filesChanged.length} files</span>
                  \${c.attributedConversations.length > 0 ? \`
                    <span class="text-green-400">\${c.attributedConversations.length} conversation\${c.attributedConversations.length > 1 ? 's' : ''}</span>
                  \` : ''}
                </div>
              </button>
            \`).join('')}
          </div>
        </div>
      \`;
    }
    
    function renderCommitDetail(commit) {
      const conversations = commit.attributedConversations.map(id => 
        DATA.conversations.find(c => c.id === id)
      ).filter(Boolean);
      
      return \`
        <div class="max-w-7xl mx-auto px-4 py-8">
          <button onclick="navigate('commits')" class="text-blue-400 hover:text-blue-300 mb-4 flex items-center gap-1">
            ← Back to commits
          </button>
          
          <div class="bg-gray-800 rounded-lg p-6 mb-6">
            <div class="flex items-center justify-between mb-4">
              <code class="text-2xl text-blue-400 font-mono">\${commit.shortHash}</code>
              \${coverageBar(commit.coveragePercent)}
            </div>
            <h1 class="text-xl font-semibold mb-4">\${escapeHtml(commit.message)}</h1>
            <div class="flex items-center gap-4 text-gray-400">
              <span>👤 \${commit.author}</span>
              <span>📅 \${formatDate(commit.date)}</span>
              <span>📁 \${commit.filesChanged.length} files changed</span>
            </div>
          </div>
          
          \${conversations.length > 0 ? \`
            <div class="mb-6">
              <h2 class="text-lg font-semibold mb-3">Attributed Conversations</h2>
              <div class="space-y-2">
                \${conversations.map(c => \`
                  <button onclick="showConversation('\${c.id}')" 
                    class="w-full text-left bg-gray-800 hover:bg-gray-750 rounded-lg p-3 transition-colors">
                    <div class="text-gray-300">\${escapeHtml(c.title)}</div>
                    <div class="text-sm text-gray-500">\${c.source} • \${c.messageCount} messages</div>
                  </button>
                \`).join('')}
              </div>
            </div>
          \` : ''}
          
          <div class="mb-4">
            <h2 class="text-lg font-semibold mb-3">Files Changed</h2>
            <div class="flex flex-wrap gap-2">
              \${commit.filesChanged.map(f => \`
                <span class="bg-gray-800 px-2 py-1 rounded text-sm font-mono text-gray-300">\${f}</span>
              \`).join('')}
            </div>
          </div>
          
          <div>
            <h2 class="text-lg font-semibold mb-3">Diff</h2>
            \${commit.lineAttributions && commit.lineAttributions.length > 0 ? \`
              <div class="mb-2 text-sm text-gray-400">
                💡 \${commit.lineAttributions.length} lines attributed to conversations (highlighted in blue)
              </div>
            \` : ''}
            <pre class="bg-gray-950 rounded-lg p-4 overflow-x-auto text-sm"><code>\${renderDiff(commit.diff, commit.lineAttributions)}</code></pre>
          </div>
        </div>
      \`;
    }
    
    function renderConversationsList() {
      return \`
        <div class="max-w-7xl mx-auto px-4 py-8">
          <h1 class="text-2xl font-bold mb-6">All Conversations (\${DATA.conversations.length})</h1>
          <div class="space-y-2">
            \${DATA.conversations.map(c => \`
              <button onclick="showConversation('\${c.id}')" 
                class="w-full text-left bg-gray-800 hover:bg-gray-750 rounded-lg p-4 transition-colors">
                <div class="text-gray-300 text-lg mb-1">\${escapeHtml(c.title)}</div>
                <div class="flex items-center gap-4 text-sm text-gray-500">
                  <span class="px-2 py-0.5 bg-gray-700 rounded">\${c.source}</span>
                  <span>\${c.messageCount} messages</span>
                  <span>\${formatDate(c.date)}</span>
                </div>
              </button>
            \`).join('')}
          </div>
        </div>
      \`;
    }
    
    function renderConversationDetail(conv) {
      return \`
        <div class="max-w-4xl mx-auto px-4 py-8">
          <button onclick="navigate('conversations')" class="text-blue-400 hover:text-blue-300 mb-4 flex items-center gap-1">
            ← Back to conversations
          </button>
          
          <div class="bg-gray-800 rounded-lg p-6 mb-6">
            <h1 class="text-xl font-semibold mb-2">\${escapeHtml(conv.title)}</h1>
            <div class="flex items-center gap-4 text-gray-400">
              <span class="px-2 py-0.5 bg-gray-700 rounded">\${conv.source}</span>
              <span>\${conv.messageCount} messages</span>
              <span>\${formatDate(conv.date)}</span>
            </div>
          </div>
          
          <div class="space-y-4">
            \${conv.messages.map(m => \`
              <div class="bg-gray-800 rounded-lg p-4 \${m.role === 'user' ? 'border-l-4 border-blue-500' : 'border-l-4 border-green-500'}">
                <div class="text-sm font-semibold mb-2 \${m.role === 'user' ? 'text-blue-400' : 'text-green-400'}">
                  \${m.role === 'user' ? '👤 User' : '🤖 Assistant'}
                </div>
                <div class="text-gray-300 whitespace-pre-wrap">\${escapeHtml(m.content || '')}</div>
              </div>
            \`).join('')}
          </div>
        </div>
      \`;
    }
    
    // Navigation
    function navigate(view) {
      currentView = view;
      selectedCommit = null;
      selectedConversation = null;
      render();
    }
    
    function showCommit(hash) {
      selectedCommit = DATA.commits.find(c => c.hash === hash);
      currentView = 'commit-detail';
      render();
      window.scrollTo(0, 0);
    }
    
    function showConversation(id) {
      selectedConversation = DATA.conversations.find(c => c.id === id);
      currentView = 'conversation-detail';
      render();
      window.scrollTo(0, 0);
    }
    
    // Main render
    function render() {
      let content = '';
      diff2htmlRendered = false;
      
      switch (currentView) {
        case 'dashboard':
          content = renderDashboard();
          break;
        case 'files':
          content = renderFilesChanged();
          break;
        case 'commits':
          content = renderCommitsList();
          break;
        case 'commit-detail':
          content = renderCommitDetail(selectedCommit);
          break;
        case 'conversations':
          content = renderConversationsList();
          break;
        case 'conversation-detail':
          content = renderConversationDetail(selectedConversation);
          break;
      }
      
      document.getElementById('app').innerHTML = renderNav() + content;
      
      if (currentView === 'files') {
        setTimeout(initDiff2Html, 0);
      }
    }
    
    // Initialize
    render();
  </script>
</body>
</html>`;
}
