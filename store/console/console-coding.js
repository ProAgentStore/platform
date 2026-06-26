    // ── Coding workspace (the AgentCoder port) ───────────────────────────────
    // A workspace == this instance. Repos hang off it; each coding session drives
    // a local AI CLI (Claude/Gemini/…) in a tmux pane on the user's `pags up`
    // runner. This tab lists repos + sessions, shows the live terminal (polled
    // capture), lets you drive the CLI manually or hand it to the autonomous brain
    // (CodingSessionWorkflow), and supports human takeover on a stuck handoff.

    let codingRepos = [];
    let codingSessions = [];
    let currentCodingSession = null;
    let codingPollTimer = null;
    let currentCodingView = 'summary';   // 'summary' (co-pilot) | 'terminal' (raw)
    let codingSummaryHistory = [];        // [{role:'user'|'assistant', content}]
    let codingSummaryBusy = false;

    async function loadCoding() {
      if (!currentInstance) return;
      const host = document.getElementById('inst-coding-body');
      if (host) host.classList.remove('hidden');
      try {
        const [repos, sessions] = await Promise.all([
          api(`/v1/instances/${currentInstance.id}/coding/repos`),
          api(`/v1/instances/${currentInstance.id}/coding/sessions`),
        ]);
        codingRepos = repos.repos || [];
        codingSessions = sessions.sessions || [];
        renderCodingRepos();
        checkGitHubApp();
      } catch (e) {
        console.error(e);
        const list = document.getElementById('inst-coding-repos');
        if (list) list.innerHTML = `<div class="empty" style="padding:1rem">Couldn't load coding workspace: ${esc(e.message)}</div>`;
      }
    }

    function renderCodingRepos() {
      const list = document.getElementById('inst-coding-repos');
      if (!list) return;
      if (!codingRepos.length) {
        list.innerHTML = '<div class="empty" style="padding:1rem">No repos yet. Add one above, then start a coding session.</div>';
        return;
      }
      list.innerHTML = codingRepos.map(r => {
        const sessions = codingSessions.filter(s => s.repoId === r.id);
        const active = sessions.filter(s => s.status === 'active');
        const statusBadge = { ready: 'var(--green)', cloning: 'var(--amber)', error: 'var(--red)' }[r.cloneStatus] || 'var(--muted)';
        return `<div class="memory-item" style="display:block">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem">
            <div>
              <b>${esc(r.name)}</b>
              ${r.githubRepo ? `<span style="color:var(--muted);font-size:0.8rem"> ${esc(r.githubRepo)}</span>` : ''}
              <span style="color:${statusBadge};font-size:0.72rem;margin-left:0.4rem">● ${esc(r.cloneStatus)}</span>
            </div>
            <div style="display:flex;gap:0.35rem">
              <select id="coding-client-${r.id}" class="btn-sm" style="padding:0.2rem">
                ${['claude','gemini','codex','grok'].map(c => `<option value="${c}"${c===r.defaultClient?' selected':''}>${c}</option>`).join('')}
              </select>
              <button type="button" class="btn btn-primary btn-sm" onclick="startCodingSession('${r.id}')">Start session</button>
              <button type="button" class="btn btn-outline btn-sm" onclick="deleteCodingRepo('${r.id}')" style="color:var(--red)">Delete</button>
            </div>
          </div>
          ${active.length ? `<div style="margin-top:0.5rem;display:flex;flex-direction:column;gap:0.3rem">${active.map(s => `
            <div style="display:flex;justify-content:space-between;align-items:center;background:var(--bg-2);padding:0.35rem 0.5rem;border-radius:6px">
              <span style="font-size:0.82rem">${esc(s.clientType)} session <span style="color:var(--muted)">${s.id.slice(0,14)}…</span></span>
              <button type="button" class="btn btn-sm" onclick="openCodingTerminal('${s.id}')">Open terminal</button>
            </div>`).join('')}</div>` : ''}
        </div>`;
      }).join('');
    }

    async function checkGitHubApp() {
      const btn = document.getElementById('inst-coding-gh-btn');
      if (!btn) return;
      try {
        const s = await api('/v1/github/status');
        btn.classList.toggle('hidden', !s.configured);
      } catch (e) { btn.classList.add('hidden'); }
    }

    async function importFromGitHub() {
      if (!currentInstance) return;
      const list = document.getElementById('inst-coding-gh-list');
      list.innerHTML = '<span style="color:var(--muted);font-size:0.8rem">Loading installations…</span>';
      try {
        const { installations } = await api('/v1/github/installations');
        if (!installations.length) {
          const url = (await api('/v1/github/install-url')).installUrl;
          list.innerHTML = `<a href="${esc(url)}" target="_blank" class="btn btn-outline btn-sm">Install the GitHub App →</a>`;
          return;
        }
        const repoSets = await Promise.all(installations.map(i =>
          api(`/v1/github/installations/${i.id}/repos`).then(r => r.repos).catch(() => [])));
        const repos = repoSets.flat();
        if (!repos.length) { list.innerHTML = '<span style="color:var(--muted);font-size:0.8rem">No repos accessible.</span>'; return; }
        list.innerHTML = repos.slice(0, 60).map(r =>
          `<button type="button" class="btn btn-outline btn-sm" onclick='importGitHubRepo(${JSON.stringify(JSON.stringify({ fullName: r.fullName, cloneUrl: r.cloneUrl, branch: r.defaultBranch }))})'>
            ${esc(r.fullName)}${r.private ? ' 🔒' : ''}
          </button>`).join('');
      } catch (e) { list.innerHTML = `<span style="color:var(--red);font-size:0.8rem">${esc(e.message)}</span>`; }
    }

    async function importGitHubRepo(json) {
      const r = JSON.parse(json);
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/repos`, {
          method: 'POST', body: JSON.stringify({ name: r.fullName.split('/').pop(), githubRepo: r.fullName, cloneUrl: r.cloneUrl, branch: r.branch }),
        });
        document.getElementById('inst-coding-gh-list').innerHTML = '';
        await loadCoding();
      } catch (e) { alert('Import failed: ' + e.message); }
    }

    async function addCodingRepo() {
      if (!currentInstance) return;
      const input = document.getElementById('inst-coding-repo-input');
      const raw = (input.value || '').trim();
      if (!raw) return;
      // Accept a local checkout path (/… or ~/…), "owner/repo", a GitHub URL, or a clone URL.
      const body = {};
      if (/^(\/|~\/)/.test(raw)) {
        body.localPath = raw; // run in your existing checkout on the runner machine — no clone
      } else if (/^https?:\/\//.test(raw) || raw.endsWith('.git')) {
        body.cloneUrl = raw;
        const m = raw.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
        if (m) body.githubRepo = m[1];
      } else if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
        body.githubRepo = raw;
        body.cloneUrl = `https://github.com/${raw}.git`;
      } else {
        body.name = raw;
      }
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/repos`, { method: 'POST', body: JSON.stringify(body) });
        input.value = '';
        await loadCoding();
      } catch (e) { alert('Add repo failed: ' + e.message); }
    }

    async function deleteCodingRepo(repoId) {
      if (!currentInstance || !confirm('Remove this repo from the workspace?')) return;
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/repos/${repoId}`, { method: 'DELETE' });
        await loadCoding();
      } catch (e) { alert('Delete failed: ' + e.message); }
    }

    async function startCodingSession(repoId) {
      if (!currentInstance) return;
      const clientType = (document.getElementById(`coding-client-${repoId}`) || {}).value || 'claude';
      try {
        const res = await api(`/v1/instances/${currentInstance.id}/coding/sessions`, {
          method: 'POST', body: JSON.stringify({ repoId, clientType }),
        });
        if (!res.runnerConnected) {
          alert('Session created, but no runner is connected. Start it on your machine with:  pags up');
        }
        await loadCoding();
        openCodingTerminal(res.session.id);
      } catch (e) { alert('Start session failed: ' + e.message); }
    }

    async function openCodingTerminal(sessionId) {
      currentCodingSession = sessionId;
      codingSummaryHistory = [];
      const panel = document.getElementById('inst-coding-terminal');
      if (panel) panel.classList.remove('hidden');
      const label = document.getElementById('inst-coding-term-label');
      if (label) label.textContent = (sessionId || '').slice(0, 16) + '…';
      switchCodingView('summary'); // default to the condensed co-pilot view
      renderCodingSummary();
      stopCodingPolling();
      codingPollTimer = setInterval(pollCodingTerminal, 1500);
      pollCodingTerminal();
      // Ensure the session is live on the runner — reattaches an orphaned session
      // (created while the runner was offline) or one lost to a runner restart.
      // Idempotent: the runner no-ops if it's already running.
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/sessions/${sessionId}/start`, { method: 'POST', body: '{}' });
        setTimeout(pollCodingTerminal, 400);
      } catch (e) { /* runner offline → pane shows the 'no runner' hint */ }
      // Kick off the first summary so the user sees plain language immediately.
      setTimeout(refreshCodingSummary, 1200);
    }

    function switchCodingView(name) {
      currentCodingView = name;
      const sum = document.getElementById('inst-coding-view-summary');
      const term = document.getElementById('inst-coding-view-terminal');
      if (sum) sum.classList.toggle('hidden', name !== 'summary');
      if (term) term.classList.toggle('hidden', name !== 'terminal');
      const sb = document.getElementById('inst-coding-view-summary-btn');
      const tb = document.getElementById('inst-coding-view-terminal-btn');
      if (sb) sb.classList.toggle('active', name === 'summary');
      if (tb) tb.classList.toggle('active', name === 'terminal');
    }

    // Light markdown: escape, then bold / inline-code / bullets / line breaks.
    function mdLite(text) {
      let h = esc(text || '');
      h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
      h = h.replace(/^\s*[-*]\s+(.*)$/gm, '• $1');
      return h.replace(/\n/g, '<br>');
    }

    function renderCodingSummary() {
      const el = document.getElementById('inst-coding-summary-thread');
      if (!el) return;
      if (!codingSummaryHistory.length && !codingSummaryBusy) {
        el.innerHTML = '<div style="color:var(--muted)">Reading the terminal…</div>';
        return;
      }
      el.innerHTML = codingSummaryHistory.map(m => {
        if (m.role === 'user') {
          return `<div style="margin:0.5rem 0;text-align:right"><span style="display:inline-block;background:var(--accent,#7c3aed);color:#fff;padding:0.3rem 0.6rem;border-radius:10px;max-width:85%;text-align:left">${esc(m.content)}</span></div>`;
        }
        return `<div style="margin:0.5rem 0">${mdLite(m.content)}</div>`;
      }).join('') + (codingSummaryBusy ? '<div style="color:var(--muted);font-size:0.8rem">…</div>' : '');
      el.scrollTop = el.scrollHeight;
    }

    async function callExplain(question) {
      if (!currentInstance || !currentCodingSession) return;
      codingSummaryBusy = true;
      renderCodingSummary();
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/explain`, {
          method: 'POST',
          body: JSON.stringify({ question: question || '', history: codingSummaryHistory.slice(-6) }),
        });
        codingSummaryHistory.push({ role: 'assistant', content: d.reply || '(no response)' });
      } catch (e) {
        codingSummaryHistory.push({ role: 'assistant', content: 'Could not summarize: ' + e.message });
      } finally {
        codingSummaryBusy = false;
        renderCodingSummary();
      }
    }

    function refreshCodingSummary() { callExplain(''); }

    async function askCoding() {
      const input = document.getElementById('inst-coding-ask');
      const q = (input.value || '').trim();
      if (!q) return;
      input.value = '';
      codingSummaryHistory.push({ role: 'user', content: q });
      renderCodingSummary();
      await callExplain(q);
    }

    function closeCodingTerminal() {
      stopCodingPolling();
      currentCodingSession = null;
      const panel = document.getElementById('inst-coding-terminal');
      if (panel) panel.classList.add('hidden');
    }

    function stopCodingPolling() {
      if (codingPollTimer) { clearInterval(codingPollTimer); codingPollTimer = null; }
    }

    // Re-arm the terminal poll when returning to the Coding tab on the same
    // instance (leaving the tab stops the timer but keeps the panel + session).
    function resumeCodingPollingIfOpen() {
      if (currentCodingSession && !codingPollTimer) {
        pollCodingTerminal();
        codingPollTimer = setInterval(pollCodingTerminal, 1500);
      }
    }

    async function pollCodingTerminal() {
      if (!currentInstance || !currentCodingSession) return;
      try {
        const snap = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/capture`);
        const pre = document.getElementById('inst-coding-pane');
        if (pre) {
          const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
          pre.textContent = snap.pane || (snap.runnerConnected ? '(waiting for the CLI…)' : '(no runner connected — run `pags up`)');
          if (atBottom) pre.scrollTop = pre.scrollHeight;
        }
        const badge = document.getElementById('inst-coding-runstate');
        if (badge) {
          const color = { idle: 'var(--green)', thinking: 'var(--amber)', responding: 'var(--amber)' }[snap.runState] || 'var(--muted)';
          badge.textContent = snap.alive ? snap.runState : 'offline';
          badge.style.color = color;
        }
      } catch (e) { /* transient — keep polling */ }
    }

    async function sendCodingMessage(ev) {
      if (ev && ev.key && ev.key !== 'Enter') return;
      if (!currentInstance || !currentCodingSession) return;
      const input = document.getElementById('inst-coding-msg');
      const text = (input.value || '').trim();
      if (!text) return;
      input.value = '';
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/message`, {
          method: 'POST', body: JSON.stringify({ text }),
        });
        setTimeout(pollCodingTerminal, 300);
      } catch (e) { alert('Send failed: ' + e.message); }
    }

    async function sendCodingKey(keys) {
      if (!currentInstance || !currentCodingSession) return;
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/message`, {
          method: 'POST', body: JSON.stringify({ keys }),
        });
        setTimeout(pollCodingTerminal, 300);
      } catch (e) { /* ignore */ }
    }

    async function runCodingBrain() {
      if (!currentInstance || !currentCodingSession) return;
      const objective = prompt('What should the AI accomplish in this repo?');
      if (!objective || !objective.trim()) return;
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/run`, {
          method: 'POST', body: JSON.stringify({ objective: objective.trim() }),
        });
        alert('Handed to the autonomous brain. Watch the terminal — it will pause for takeover if it gets stuck.');
      } catch (e) { alert('Run failed: ' + e.message); }
    }

    async function resumeCodingBrain() {
      if (!currentInstance || !currentCodingSession) return;
      // If the brain paused for a value (needs_input), let the user supply it.
      const value = prompt('Resume the AI. If it was waiting for a value, enter it here (or leave blank to just continue):') || '';
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/resume`, {
          method: 'POST', body: JSON.stringify(value ? { value } : {}),
        });
      } catch (e) { alert('Resume failed: ' + e.message); }
    }

    async function endCodingSession() {
      if (!currentInstance || !currentCodingSession) return;
      if (!confirm('End this coding session? The tmux session on your machine will be stopped.')) return;
      const sid = currentCodingSession;
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/sessions/${sid}/end`, { method: 'POST', body: '{}' });
      } catch (e) { /* ignore */ }
      closeCodingTerminal();
      await loadCoding();
    }
