// biome-ignore-all lint/correctness/noUnusedVariables: Console functions are called from inline HTML handlers.
// ── Helpers ──────────────────────────────────────────────────

    async function copyChatHistory(type, evt) {
      const btn = evt?.target?.closest('button') || evt?.target;
      try {
        const id = (type === 'agent') ? currentAgent?.id : currentInstance?.id;
        if (!id) { alert('No active instance'); return; }
        const base = (type === 'agent') ? `/v1/agents/${id}` : `/v1/instances/${id}`;
        const data = await api(`${base}/messages?limit=10`);
        const messages = (data.messages || []).map(m => ({
          role: m.role,
          content: (m.content || '').replace(/^\[Context:[\s\S]*?\]\s*\n*/i, ''),
          timestamp: m.createdAt,
        }));
        const json = JSON.stringify(messages, null, 2);
        await navigator.clipboard.writeText(json);
        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.innerHTML = '&#128203;'; }, 1500); }
      } catch (e) {
        alert('Copy failed: ' + e.message);
      }
    }

    /** Render a chat message bubble with copy button. */
    function chatBubble(role, rawContent) {
      const content = role === 'assistant' ? renderMd(rawContent) : esc(rawContent);
      const copyBtn = `<button class="copy-msg" onclick="copyMsgText(this)" title="Copy">&#128203;</button>`;
      const el = document.createElement('div');
      el.className = `chat-msg ${role}`;
      el.setAttribute('data-raw', rawContent || '');
      el.innerHTML = copyBtn + content;
      const tmp = document.createElement('div');
      tmp.appendChild(el);
      return tmp.innerHTML;
    }
    function copyMsgText(btn) {
      const raw = btn.parentElement.getAttribute('data-raw') || btn.parentElement.innerText;
      navigator.clipboard.writeText(raw).then(() => {
        btn.textContent = '\u2713'; setTimeout(() => { btn.innerHTML = '&#128203;'; }, 1200);
      });
    }

    function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

    /** Render markdown-ish text: code blocks, inline code, bold, italic, lists, links, JSON. */
    function renderMd(raw) {
      let s = raw || '';

      // Strip embedded tool-call JSON blobs
      s = s.replace(/\{[^{}]*"type"\s*:\s*"function"[^{}]*"name"\s*:\s*"([^"]+)"[^{}]*(?:\{[^{}]*\}[^{}]*)*\};?/g,
        (_, name) => `\n\n> *Tool executed: ${name}*\n\n`);

      // Pure JSON response
      const trimmed = s.trim();
      if (/^[{[]/.test(trimmed) && /[\]}]$/.test(trimmed)) {
        try { return renderJson(JSON.parse(trimmed)); } catch {}
      }

      // Fenced code blocks (preserve, don't process inside)
      const codeBlocks = [];
      s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
        codeBlocks.push(`<pre><code>${esc(code.trim())}</code></pre>`);
        return `@@CODE_BLOCK_${codeBlocks.length - 1}@@`;
      });

      // Inline code
      s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${esc(c)}</code>`);

      // Headers
      s = s.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
      s = s.replace(/^###\s+(.+)$/gm, '<h4>$1</h4>');
      s = s.replace(/^##\s+(.+)$/gm, '<h3>$1</h3>');

      // Bold then italic (order matters)
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

      // Blockquotes
      s = s.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');

      // Links
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      s = s.replace(/(?<![="'/])https?:\/\/[^\s<)"']+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);

      // Process lists block by block (split on double newline)
      const blocks = s.split(/\n{2,}/);
      const out = [];
      for (const block of blocks) {
        const lines = block.split('\n');
        // Check if all lines are unordered list items
        if (lines.every(l => /^[-*]\s+/.test(l.trim()) || !l.trim())) {
          out.push('<ul>' + lines.filter(l => l.trim()).map(l => `<li>${l.replace(/^[-*]\s+/, '')}</li>`).join('') + '</ul>');
        }
        // Check if all lines are numbered list items
        else if (lines.every(l => /^\d+\.\s+/.test(l.trim()) || !l.trim())) {
          out.push('<ol>' + lines.filter(l => l.trim()).map(l => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`).join('') + '</ol>');
        }
        // Check for indented sub-items (- **Key**: value pattern)
        else if (lines.some(l => /^\s+[-*]\s+/.test(l))) {
          const items = [];
          for (const l of lines) {
            if (/^[-*]\s+/.test(l.trim()) || /^\s+[-*]\s+/.test(l)) {
              items.push(`<li>${l.replace(/^\s*[-*]\s+/, '')}</li>`);
            } else if (l.trim()) {
              items.push(l);
            }
          }
          out.push('<ul>' + items.join('') + '</ul>');
        }
        // Regular paragraph
        else {
          const text = block.replace(/\n/g, '<br>');
          if (text.trim() && !text.startsWith('<h') && !text.startsWith('<blockquote') && !text.startsWith('<ul') && !text.startsWith('<ol')) {
            out.push(`<p>${text}</p>`);
          } else {
            out.push(text);
          }
        }
      }
      s = out.join('');

      // Restore code blocks
      s = s.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, i) => codeBlocks[parseInt(i, 10)]);

      // Clean empty tags
      s = s.replace(/<p>\s*<\/p>/g, '');
      return s;
    }

    /** Pretty-print JSON with syntax highlighting. */
    function renderJson(obj) {
      const s = JSON.stringify(obj, null, 2);
      const highlighted = esc(s)
        .replace(/"([^"]+)"(?=\s*:)/g, '<span class="json-key">"$1"</span>')
        .replace(/:\s*"([^"]*)"/g, ': <span class="json-str">"$1"</span>')
        .replace(/:\s*(\d+\.?\d*)/g, ': <span class="json-num">$1</span>')
        .replace(/:\s*(true|false|null)/g, ': <span class="json-bool">$1</span>');
      return `<div class="json-block">${highlighted}</div>`;
    }
    function escAttr(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
    function safeExternalUrl(value) {
      try {
        const url = new URL(String(value || ''));
        return url.protocol === 'https:' ? url.href : '';
      } catch {
        return '';
      }
    }
    function githubRepoUrl(org, repo) {
      const cleanOrg = encodeURIComponent(String(org || 'ProAgentStore'));
      const cleanRepo = encodeURIComponent(String(repo || ''));
      return `https://github.com/${cleanOrg}/${cleanRepo}`;
    }
    function showError(id, msg) { const el = document.getElementById(id); el.textContent = msg; el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 5000); }

    // ── Init ────────────────────────────────────────────────────

    async function handleSubscribeParam() {
      const params = new URLSearchParams(window.location.search);
      const agentId = params.get('subscribe');
      const cloneId = params.get('clone');
      if (agentId || cloneId) window.history.replaceState({}, '', window.location.pathname);

      if (agentId && token) {
        try {
          const res = await api(`/v1/instances/${encodeURIComponent(agentId)}/subscribe`, { method: 'POST' });
          if (res.instanceId) { showDashboard('instances'); return true; }
        } catch (e) {
          if (e.message.includes('Already subscribed')) { showDashboard('instances'); return true; }
          alert(`Subscribe failed: ${e.message}`);
        }
      }

      if (cloneId && token) {
        const slug = prompt('Choose a slug for your cloned agent (lowercase, hyphens):');
        if (!slug) return false;
        try {
          const res = await api(`/v1/agents/${encodeURIComponent(cloneId)}/clone`, {
            method: 'POST',
            body: JSON.stringify({ slug }),
          });
          if (res.id) { alert(`Cloned! Your agent: ${slug}`); showDashboard('agents'); return true; }
        } catch (e) { alert(`Clone failed: ${e.message}`); }
      }
      return false;
    }

    async function restoreConsoleRoute() {
      const parts = routeParts();
      const page = parts[0] || 'agents';
      const validAgentTabs = ['chat', 'knowledge', 'memory', 'tasks', 'settings', 'analytics', 'ops'];
      const validInstanceTabs = ['chat', 'board', 'knowledge'];

      routeApplying = true;
      try {
        if (page === 'agents' && parts[1]) {
          routeApplying = false;
          await openAgent(parts[1], validAgentTabs.includes(parts[2]) ? parts[2] : 'chat', false);
          routeApplying = true;
          return;
        }
        if (page === 'instances' && parts[1] && parts[2] === 'applications' && parts[3]) {
          // Deep link to application detail: /instances/:id/applications/:recordId
          routeApplying = false;
          await openInstance(parts[1], null, 'applications', false);
          await showApplicationDetail(parts[3]);
          routeApplying = true;
          return;
        }
        if (page === 'instances' && parts[1]) {
          const instanceTab = validInstanceTabs.includes(parts[2]) ? parts[2] : 'chat';
          const runtimeTaskId = instanceTab === 'board' && parts[3] === 'tasks' ? parts[4] : null;
          routeApplying = false;
          await openInstance(parts[1], null, instanceTab, false, runtimeTaskId);
          routeApplying = true;
          return;
        }
        if (page === 'instances') {
          showDashboard('instances', false);
          return;
        }
        if (page === 'dashboard') {
          showDashboard('dashboard', false);
          return;
        }
        if (page === 'profile') {
          showProfile(false);
          return;
        }
        if (page === 'notifications') {
          await showNotifications(false);
          return;
        }
        showDashboard('agents', false);
      } finally {
        routeApplying = false;
      }
    }

    (async () => {
      const fromOAuth = await handleOAuthCallback();
      if (fromOAuth && !user) await checkAuth();
      const authed = fromOAuth || await checkAuth();
      if (authed && user) {
        showUser();
        loadNotifBadge();
        const handledQuery = await handleSubscribeParam();
        if (!handledQuery) await restoreConsoleRoute();
      } else {
        showPage('login-page');
      }
    })();

    window.addEventListener('popstate', () => {
      if (token && user) restoreConsoleRoute();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Escape: go back to dashboard from any detail view
      if (e.key === 'Escape') {
        const onAppDetail = !document.getElementById('application-detail').classList.contains('hidden');
        if (onAppDetail) {
          showPage('instance-detail');
          switchInstTab('board');
          e.preventDefault();
          return;
        }
        const current = ['agent-detail', 'instance-detail', 'profile-page', 'notifications-page']
          .find(id => !document.getElementById(id).classList.contains('hidden'));
        if (current) { showDashboard(); e.preventDefault(); }
      }
      // Cmd/Ctrl+K: focus chat input (if in agent/instance detail)
      if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        const onAppDetail = !document.getElementById('application-detail').classList.contains('hidden');
        if (onAppDetail) { document.getElementById('app-detail-chat-input')?.focus(); return; }
        const onInstance = !document.getElementById('instance-detail').classList.contains('hidden');
        const onAgent = !document.getElementById('agent-detail').classList.contains('hidden');
        if (onInstance && currentInstanceTab !== 'chat') switchInstTab('chat');
        if (onAgent && currentAgentTab !== 'chat') switchTab('chat');
        const chatInput = onInstance
          ? document.getElementById('inst-chat-input')
          : onAgent
            ? document.getElementById('chat-input')
            : null;
        if (chatInput) chatInput.focus();
      }
      // Cmd/Ctrl+N: toggle create form (if on dashboard)
      if ((e.metaKey || e.ctrlKey) && e.key === 'n' && !document.getElementById('dashboard').classList.contains('hidden')) {
        e.preventDefault();
        toggleCreateForm();
      }
    });
