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
    let codingVoiceOn = false;            // read replies aloud (TTS)
    let codingRecognizer = null;          // active speech-to-text session
    let codingTapBound = false;           // touch double-tap handler attached once
    let codingPollTick = 0;               // drives the slower chat poll within the terminal poll
    let lastCodingPane = '';              // skip re-render when the pane is unchanged (keeps selection)

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
        list.innerHTML = '<div class="empty" style="padding:0.75rem;font-size:0.82rem">No repos yet — tap <b>+ Add</b>.</div>';
        setAddRepoOpen(true); // first run → show the add form
        return;
      }
      // One compact row per repo: status dot · name · live badge · Open/Start · ✕
      list.innerHTML = codingRepos.map(r => {
        const active = codingSessions.find(s => s.repoId === r.id && s.status === 'active');
        const dot = { ready: 'var(--green)', cloning: 'var(--amber)', error: 'var(--red)' }[r.cloneStatus] || 'var(--muted)';
        const sub = r.workdir || r.githubRepo || '';
        return `<div class="memory-item" style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;padding:0.45rem 0.6rem">
          <div style="min-width:0">
            <div style="display:flex;align-items:center;gap:0.4rem">
              <span title="${esc(r.cloneStatus)}" style="color:${dot};font-size:0.7rem">●</span>
              <b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name)}</b>
              ${active ? '<span style="font-size:0.62rem;color:var(--green);border:1px solid var(--green);border-radius:999px;padding:0 0.35rem">live</span>' : ''}
            </div>
            ${sub ? `<div style="font-size:0.7rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">${esc(sub)}</div>` : ''}
          </div>
          <div style="display:flex;gap:0.3rem;flex-shrink:0">
            ${active
              ? `<button type="button" class="btn btn-primary btn-sm" onclick="openCodingTerminal('${active.id}')">Open</button>`
              : `<button type="button" class="btn btn-primary btn-sm" onclick="startCodingSession('${r.id}')">Start</button>`}
            <button type="button" class="btn btn-outline btn-sm" onclick="renameCodingRepo('${r.id}')" title="Rename project">✎</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="deleteCodingRepo('${r.id}')" title="Remove repo" style="color:var(--red)">✕</button>
          </div>
        </div>`;
      }).join('');
    }

    // ── Coding page space-savers (progressive disclosure) ────────────────────
    function setAddRepoOpen(open) {
      const el = document.getElementById('inst-coding-add');
      if (el) el.classList.toggle('hidden', !open);
    }
    function toggleAddRepo() {
      const el = document.getElementById('inst-coding-add');
      if (el) setAddRepoOpen(el.classList.contains('hidden'));
    }
    function setCodingReposCollapsed(collapsed) {
      const wrap = document.getElementById('inst-coding-collapsible');
      const caret = document.getElementById('inst-coding-repos-caret');
      if (wrap) wrap.classList.toggle('hidden', collapsed);
      if (caret) caret.textContent = collapsed ? '▸' : '▾';
    }
    function toggleCodingRepos() {
      const wrap = document.getElementById('inst-coding-collapsible');
      if (wrap) setCodingReposCollapsed(!wrap.classList.contains('hidden'));
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
        setAddRepoOpen(false); // collapse the form once a repo is added
      } catch (e) { alert('Add repo failed: ' + e.message); }
    }

    async function deleteCodingRepo(repoId) {
      if (!currentInstance || !confirm('Remove this repo from the workspace?')) return;
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/repos/${repoId}`, { method: 'DELETE' });
        await loadCoding();
      } catch (e) { alert('Delete failed: ' + e.message); }
    }

    // Give the project a friendlier, editable name (the repo name alone is generic).
    async function renameCodingRepo(repoId) {
      if (!currentInstance) return;
      const r = codingRepos.find(x => x.id === repoId);
      const name = prompt('Project name:', r ? r.name : '');
      if (name == null) return;
      const trimmed = name.trim();
      if (!trimmed || (r && trimmed === r.name)) return;
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/repos/${repoId}`, { method: 'PUT', body: JSON.stringify({ name: trimmed }) });
        await loadCoding();
        renderCodingRepoSelect();
      } catch (e) { alert('Rename failed: ' + e.message); }
    }
    // Rename the project for the currently-open session (from the header).
    function renameCurrentCodingRepo() {
      const s = codingSessions.find(x => x.id === currentCodingSession);
      if (s) renameCodingRepo(s.repoId);
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

    // Reflect the open repo + view in the URL so a reload (or a home-screen PWA
    // saved on this exact view) lands right back here. Keyed by REPO (stable
    // across sessions), with the summary|terminal view as the last segment.
    function setCodingUrl(replace = false) {
      if (!currentInstance || !currentCodingSession) return;
      const s = codingSessions.find(x => x.id === currentCodingSession);
      const repoId = s && s.repoId;
      if (!repoId) return;
      setConsoleUrl(`/instances/${encodeURIComponent(currentInstance.id)}/coding/repos/${encodeURIComponent(repoId)}/${currentCodingView}`, replace);
    }

    // Restore path: open a repo's live session at a given view (used by the router
    // on reload / PWA launch). Loads coding data first so the session map exists.
    async function openCodingRepoView(repoId, view) {
      await loadCoding();
      const active = codingSessions.find(s => s.repoId === repoId && s.status === 'active');
      if (active) {
        await openCodingTerminal(active.id, false);
        switchCodingView(view === 'terminal' ? 'terminal' : 'summary', false);
        setCodingUrl(true); // normalize the URL to the canonical form
      }
      // No active session for this repo → leave the repo list visible (tap Start).
    }

    async function openCodingTerminal(sessionId, updateUrl = true) {
      currentCodingSession = sessionId;
      codingSummaryHistory = [];
      lastCodingPane = ''; // force a fresh colourised render for this session
      const panel = document.getElementById('inst-coding-terminal');
      if (panel) panel.classList.remove('hidden');
      // Full-screen the session: the repo list moves into the header selector.
      document.getElementById('inst-coding-repos-section')?.classList.add('hidden');
      renderCodingRepoSelect();
      bindCodingSummaryTaps();
      switchCodingView('summary', updateUrl); // default to the condensed co-pilot view
      renderCodingSummary();
      stopCodingPolling();
      codingPollTimer = setInterval(codingTick, 1500);
      pollCodingTerminal();
      // Ensure the session is live on the runner — reattaches an orphaned session
      // (created while the runner was offline) or one lost to a runner restart.
      // Idempotent: the runner no-ops if it's already running.
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/sessions/${sessionId}/start`, { method: 'POST', body: '{}' });
        setTimeout(pollCodingTerminal, 400);
      } catch (e) { /* runner offline → pane shows the 'no runner' hint */ }
      // Restore the persisted conversation from last time, then only auto-summarize
      // if this session has no history yet (avoids an unsolicited LLM call on reopen).
      await loadCodingHistory(sessionId);
      if (!codingSummaryHistory.length) setTimeout(refreshCodingSummary, 1200);
    }

    async function loadCodingHistory(sessionId) {
      if (!currentInstance) return;
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${sessionId}/timeline`);
        codingSummaryHistory = (d.chat || []).map(codingTurn);
      } catch (e) { codingSummaryHistory = []; }
      // Guard against a race: only render if we're still on this session.
      if (currentCodingSession === sessionId) renderCodingSummary();
    }

    // A persisted timeline entry → a chat turn. chat_assistant = the agent/co-pilot;
    // everything else you authored (chat_user, command) shows as your turn.
    function codingTurn(m) {
      return { role: m.type === 'chat_assistant' ? 'assistant' : 'user', content: m.content };
    }

    // Poll the persisted thread so the server-side watcher's "✅ done" summary (and any
    // other turns) appear here even when it lands minutes after you sent the message —
    // and even if you were away. Server is the source of truth once it has our echoes.
    async function pollCodingChat() {
      if (!currentInstance || !currentCodingSession || codingSummaryBusy) return;
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/timeline`);
        const chat = (d.chat || []).map(codingTurn);
        if (chat.length < codingSummaryHistory.length) return; // not caught up to local echoes yet
        const last = codingSummaryHistory[codingSummaryHistory.length - 1];
        const slast = chat[chat.length - 1];
        const changed = chat.length !== codingSummaryHistory.length || (slast && (!last || slast.content !== last.content));
        if (!changed) return;
        const grewWithReply = chat.length > codingSummaryHistory.length && slast && slast.role === 'assistant';
        codingSummaryHistory = chat;
        renderCodingSummary();
        if (grewWithReply && codingVoiceOn) speakText(slast.content); // read the agent's update aloud
      } catch (e) { /* transient */ }
    }

    // One poll tick: refresh the terminal every 1.5s; check the chat thread every ~4.5s.
    function codingTick() {
      pollCodingTerminal();
      if (++codingPollTick % 3 === 0) pollCodingChat();
    }

    function switchCodingView(name, updateUrl = true) {
      currentCodingView = name;
      const sum = document.getElementById('inst-coding-view-summary');
      const term = document.getElementById('inst-coding-view-terminal');
      if (sum) sum.classList.toggle('hidden', name !== 'summary');
      if (term) term.classList.toggle('hidden', name !== 'terminal');
      const sb = document.getElementById('inst-coding-view-summary-btn');
      const tb = document.getElementById('inst-coding-view-terminal-btn');
      if (sb) sb.classList.toggle('active', name === 'summary');
      if (tb) tb.classList.toggle('active', name === 'terminal');
      // Summary is for talking only — hide raw-terminal controls (Esc / Ctrl-C) there.
      document.querySelectorAll('.coding-term-only').forEach(el => el.classList.toggle('hidden', name !== 'terminal'));
      if (updateUrl) setCodingUrl();
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
      el.innerHTML = codingSummaryHistory.map((m, i) => {
        if (m.role === 'user') {
          return `<div style="margin:0.5rem 0;text-align:right"><span style="display:inline-block;background:var(--accent,#7c3aed);color:#fff;padding:0.3rem 0.6rem;border-radius:10px;max-width:85%;text-align:left">${esc(m.content)}</span></div>`;
        }
        // Double-tap an assistant message to hear it spoken. ondblclick covers mouse;
        // a touch double-tap detector (bindCodingSummaryTaps) covers iOS, where finger
        // double-taps don't reliably fire dblclick.
        return `<div data-msg-idx="${i}" ondblclick="speakCodingMsg(${i})" title="Double-tap to hear it" style="margin:0.5rem 0;cursor:pointer">${mdLite(m.content)}</div>`;
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
          body: JSON.stringify({ question: question || '' }),
        });
        codingSummaryHistory.push({ role: 'assistant', content: d.reply || '(no response)' });
        speakCoding(d.reply);
      } catch (e) {
        codingSummaryHistory.push({ role: 'assistant', content: 'Could not summarize: ' + e.message });
      } finally {
        codingSummaryBusy = false;
        renderCodingSummary();
      }
    }

    function refreshCodingSummary() { callExplain(''); }

    // ── Voice: talk to the co-pilot, and hear it back ────────────────────────
    function startCodingDictation(btn) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { alert('Voice input isn\'t supported in this browser. On iPhone, use the keyboard\'s mic; on desktop, try Chrome.'); return; }
      if (codingRecognizer) { try { codingRecognizer.stop(); } catch (e) {} return; }
      const input = document.getElementById('inst-coding-ask');
      const rec = new SR();
      rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
      codingRecognizer = rec;
      if (btn) btn.classList.add('active');
      let finalText = '';
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText += t; else interim += t;
        }
        if (input) input.value = (finalText + interim).trim();
      };
      rec.onend = () => {
        codingRecognizer = null;
        if (btn) btn.classList.remove('active');
        // Don't auto-send — the dictated text could be a co-pilot question OR an
        // instruction for the agent, so leave it for the user to pick Ask or ➤ Agent.
      };
      rec.onerror = () => { codingRecognizer = null; if (btn) btn.classList.remove('active'); };
      try { rec.start(); } catch (e) { codingRecognizer = null; if (btn) btn.classList.remove('active'); }
    }

    // Speak text NOW. Must be reachable from a user gesture (iOS/Chrome block
    // speech that isn't triggered by a tap/click — which is why auto-speak after
    // an async summary often stays silent; double-tap a message is the reliable path).
    function speakText(text) {
      if (!window.speechSynthesis || !text) return;
      const clean = String(text).replace(/[*_`#>•]/g, '').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(clean.slice(0, 1500));
        u.rate = 1.05;
        speechSynthesis.speak(u);
      } catch (e) { /* unsupported */ }
    }

    // Double-tap / click a summary message to hear it (direct gesture → works on iOS).
    function speakCodingMsg(i) {
      const m = codingSummaryHistory[i];
      if (m && m.content) speakText(m.content);
    }

    // Reliable touch double-tap on the thread (iOS often won't fire dblclick for a
    // finger double-tap). Attached once; survives re-renders since the container
    // element is stable. speakText() cancels first, so a stray double-fire is benign.
    function bindCodingSummaryTaps() {
      if (codingTapBound) return;
      const el = document.getElementById('inst-coding-summary-thread');
      if (!el) return;
      codingTapBound = true;
      let lastTs = 0, lastIdx = -1;
      el.addEventListener('touchend', (e) => {
        const div = e.target.closest && e.target.closest('[data-msg-idx]');
        if (!div) return;
        const idx = Number(div.dataset.msgIdx);
        const now = Date.now();
        if (idx === lastIdx && now - lastTs < 400) {
          e.preventDefault();
          speakCodingMsg(idx);
          lastTs = 0; lastIdx = -1;
        } else { lastTs = now; lastIdx = idx; }
      }, { passive: false });
    }

    function toggleCodingVoiceOutput(btn) {
      codingVoiceOn = !codingVoiceOn;
      if (btn) btn.classList.toggle('active', codingVoiceOn);
      if (codingVoiceOn) {
        // Speak the latest summary right now — this is inside the click gesture, so
        // it both confirms voice works and "unlocks" the synth for later auto-speak.
        const last = codingSummaryHistory.slice().reverse().find(m => m.role === 'assistant');
        speakText(last ? last.content : 'Voice on.');
      } else if (window.speechSynthesis) {
        speechSynthesis.cancel();
      }
    }

    // Auto-speak after a new reply (only when the toggle is on; may be blocked on
    // iOS since it's not a gesture — the double-tap is the guaranteed path).
    function speakCoding(text) { if (codingVoiceOn) speakText(text); }

    async function askCoding() {
      const input = document.getElementById('inst-coding-ask');
      const q = (input.value || '').trim();
      if (!q) return;
      input.value = '';
      codingSummaryHistory.push({ role: 'user', content: q });
      renderCodingSummary();
      await callExplain(q);
    }

    // The Agent chat: relay your words to Claude on your behalf — it types your
    // message into the CLI (drives it). Persisted as a chat turn (chat:true) so it
    // survives reload; a durable server-side watcher then summarizes + notifies when
    // Claude finishes (chat polling below shows that reply, even minutes later).
    async function sendCodingInstruction() {
      if (!currentInstance || !currentCodingSession) return;
      const input = document.getElementById('inst-coding-ask');
      const text = (input.value || '').trim();
      if (!text) return;
      input.value = '';
      codingSummaryHistory.push({ role: 'user', content: text });
      renderCodingSummary();
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/message`, {
          method: 'POST', body: JSON.stringify({ text, chat: true }),
        });
        setTimeout(pollCodingTerminal, 300);
      } catch (e) {
        codingSummaryHistory.push({ role: 'assistant', content: 'Could not reach the agent: ' + e.message });
        renderCodingSummary();
      }
    }

    // Clear the conversation thread (the activity log/timeline of the agent's work is
    // kept — this only wipes the chat). Persisted so it stays cleared on reload.
    async function clearCodingSummary() {
      if (!currentInstance || !currentCodingSession) return;
      if (!confirm('Clear this conversation? The activity history is kept.')) return;
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/timeline`, { method: 'DELETE' });
      } catch (e) { /* clear locally regardless */ }
      codingSummaryHistory = [];
      renderCodingSummary();
    }

    // The header repo switcher (repos live in the coding top-nav so the session is
    // full-screen). Lists every repo; the live one is marked.
    function renderCodingRepoSelect() {
      const sel = document.getElementById('inst-coding-repo-select');
      if (!sel) return;
      const s = codingSessions.find(x => x.id === currentCodingSession);
      const curRepo = s ? s.repoId : '';
      sel.innerHTML = codingRepos.map(r => {
        const active = codingSessions.find(x => x.repoId === r.id && x.status === 'active');
        return `<option value="${esc(r.id)}"${r.id === curRepo ? ' selected' : ''}>${esc(r.name)}${active ? ' • live' : ''}</option>`;
      }).join('');
    }

    // Switch repos from the header dropdown: open its live session, or start one.
    function onCodingRepoSelect(repoId) {
      if (!repoId) return;
      const cur = codingSessions.find(x => x.id === currentCodingSession);
      if (cur && cur.repoId === repoId) return; // already viewing it
      const active = codingSessions.find(x => x.repoId === repoId && x.status === 'active');
      if (active) openCodingTerminal(active.id);
      else startCodingSession(repoId);
    }

    function closeCodingTerminal() {
      const hadSession = !!currentCodingSession;
      stopCodingPolling();
      if (window.speechSynthesis) speechSynthesis.cancel();
      setCodingReposCollapsed(false); // bring the repo list back
      document.getElementById('inst-coding-repos-section')?.classList.remove('hidden');
      currentCodingSession = null;
      const panel = document.getElementById('inst-coding-terminal');
      if (panel) panel.classList.add('hidden');
      // Drop back to the repo-list URL only if we were actually viewing a session
      // (avoids a spurious history entry when openInstance tears down an empty tab).
      if (hadSession && currentInstance) setConsoleUrl(`/instances/${encodeURIComponent(currentInstance.id)}/coding`);
    }

    function stopCodingPolling() {
      if (codingPollTimer) { clearInterval(codingPollTimer); codingPollTimer = null; }
    }

    // Re-arm the terminal poll when returning to the Coding tab on the same
    // instance (leaving the tab stops the timer but keeps the panel + session).
    function resumeCodingPollingIfOpen() {
      if (currentCodingSession && !codingPollTimer) {
        pollCodingTerminal();
        codingPollTimer = setInterval(codingTick, 1500);
      }
    }

    // Run-state shown as an icon, not a word (the word lives in the tooltip):
    // ⟳ spinner = working · ● green = ready · ○ grey = offline.
    function setCodingRunState(state) {
      const badge = document.getElementById('inst-coding-runstate');
      if (!badge) return;
      badge.title = state;
      if (state === 'thinking' || state === 'responding') {
        badge.innerHTML = '<span class="coding-spin" aria-label="working"></span>';
      } else if (state === 'idle') {
        badge.textContent = '●';
        badge.style.color = 'var(--green)';
      } else {
        badge.textContent = '○';
        badge.style.color = 'var(--muted)';
      }
    }

    // Colour the raw terminal by line type so you can see at a glance who said what:
    // cyan ❯ = you · green = the agent's reply · amber ⚙ = a tool it ran · slate ↳ =
    // that tool's result · red = an error. Each ❯/reply line is timestamped [HH:MM:SS].
    function colorizeCodingPane(text) {
      return String(text || '').split('\n').map(line => {
        const e = esc(line);
        if (/^\s*❯ /.test(line)) return `<span style="color:#7dd3fc;font-weight:600">${e}</span>`;
        if (/^⚙ /.test(line)) return `<span style="color:#fbbf24">${e}</span>`;
        if (/^\s*↳ /.test(line)) return `<span style="color:#94a3b8">${e}</span>`;
        if (/^\[(error|claude)/.test(line)) return `<span style="color:#f87171">${e}</span>`;
        return `<span style="color:#86efac">${e}</span>`;
      }).join('\n');
    }

    async function pollCodingTerminal() {
      if (!currentInstance || !currentCodingSession) return;
      try {
        const snap = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/capture`);
        const pre = document.getElementById('inst-coding-pane');
        if (pre) {
          const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
          if (snap.pane) {
            if (snap.pane !== lastCodingPane) { pre.innerHTML = colorizeCodingPane(snap.pane); lastCodingPane = snap.pane; }
          } else {
            pre.textContent = snap.runnerConnected ? '(waiting for the CLI…)' : '(no runner connected — run `pags up`)';
            lastCodingPane = '';
          }
          if (atBottom) pre.scrollTop = pre.scrollHeight;
        }
        setCodingRunState(snap.alive ? snap.runState : 'offline');
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
