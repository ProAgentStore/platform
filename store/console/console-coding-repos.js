    // ── Coding workspace — repos list, status, deploy, voice-from-list ────────
    // A workspace == this instance. This file owns the repository LIST surface:
    // loading repos/sessions, the live per-repo status + deploy badges, voice
    // play/reply from the list, add/rename/delete, and the header repo switcher.
    // The session/terminal surface lives in console-coding-session.js.
    //
    // NOTE: all shared coding state is declared HERE (these are classic scripts —
    // top-level `let` is shared across files via the global lexical environment, so
    // it must be declared exactly once). console-coding-session.js USES these vars
    // but does not re-declare them.

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
    let reposStatusTimer = null;          // live per-repo status poll (repos list view)
    let codingReposStatus = {};           // repoId -> 'thinking'|'idle'|'offline'
    let deployStatusTimer = null;         // GH Actions deploy status poll (optional)
    let codingDeployStatus = {};          // repoId -> { available, run }

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
        startDeployPolling(); // optional GH Actions deploy status (no-op if none on GitHub)
      } catch (e) {
        console.error(e);
        const list = document.getElementById('inst-coding-repos');
        if (list) list.innerHTML = `<div class="empty" style="padding:1rem">Couldn't load coding workspace: ${esc(e.message)}</div>`;
      }
    }

    // The Overseer (#9): one agent across ALL repos. Ask about everything, or tell a
    // specific repo to do something (it routes + delegates). Text now; voice later.
    async function askOverseer() {
      if (!currentInstance) return;
      const input = document.getElementById('inst-coding-overseer-input');
      const reply = document.getElementById('inst-coding-overseer-reply');
      const msg = (input.value || '').trim();
      if (!msg) return;
      input.value = '';
      if (reply) { reply.style.display = ''; reply.innerHTML = '<span style="color:var(--muted)">Thinking across your repos…</span>'; }
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/overseer`, { method: 'POST', body: JSON.stringify({ message: msg }) });
        if (reply) reply.innerHTML = `<div style="color:var(--muted-soft);font-size:0.78rem">You: ${esc(msg)}</div><div style="margin-top:0.25rem">${mdLite(d.reply || '(no response)')}</div>`;
        if (d.delegated) startReposStatusPolling(); // a repo is now working — refresh status
        if (codingVoiceOn) speakText(d.reply);
      } catch (e) {
        if (reply) reply.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
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
      // Stacked row (full names/URLs wrap, mobile-friendly): live status + name on
      // top, the full repo/URL below, then actions. Rename/delete live in the open
      // session's header now, not here. Status updates in real time (pollReposStatus).
      list.innerHTML = codingRepos.map(r => {
        const active = codingSessions.find(s => s.repoId === r.id && s.status === 'active');
        const sub = r.workdir || r.githubRepo || '';
        return `<div class="memory-item" style="display:block;padding:0.55rem 0.7rem">
          <div style="display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap">
            <span class="repo-status" data-repo-status="${r.id}" style="font-size:0.72rem;flex-shrink:0">${repoStatusIcon(r, active)}</span>
            <b style="font-size:0.9rem;overflow-wrap:anywhere">${esc(r.name)}</b>
            <span data-repo-deploy="${r.id}" style="flex-shrink:0">${repoDeployBadge(codingDeployStatus[r.id])}</span>
          </div>
          ${sub ? `<div style="font-size:0.72rem;color:var(--muted);margin-top:0.15rem;word-break:break-all">${esc(sub)}</div>` : ''}
          <div style="display:flex;gap:0.35rem;flex-wrap:wrap;margin-top:0.5rem;align-items:center">
            ${active ? `
              <button type="button" class="btn btn-outline btn-sm" onclick="playRepoLastReply('${r.id}', this)" title="Hear the agent's last reply">🔊 Play</button>
              <button type="button" id="repo-reply-${r.id}" class="btn btn-outline btn-sm" onclick="voiceReplyToRepo('${r.id}', this)" title="Reply by voice — sends straight to the agent">🎤 Reply</button>
              <button type="button" class="btn btn-primary btn-sm" onclick="openCodingTerminal('${active.id}')">Open</button>`
              : `<button type="button" class="btn btn-primary btn-sm" onclick="startCodingSession('${r.id}')">Start</button>`}
            ${repoLaunchIcons(r)}
          </div>
          <div id="repo-play-${r.id}" class="repo-play" style="display:none"></div>
        </div>`;
      }).join('');
      startReposStatusPolling();
    }

    // Per-repo status icon: spinner = working · green ● = ready for your reply ·
    // grey ○ = offline. Falls back to the repo's clone status when no live session.
    function repoStatusIcon(r, active) {
      if (active) {
        const st = codingReposStatus[r.id];
        if (st === 'thinking' || st === 'responding') return '<span class="coding-spin" title="working…"></span>';
        if (st === 'offline') return '<span title="runner offline" style="color:var(--muted)">○</span>';
        return '<span title="ready for your reply" style="color:var(--green)">●</span>';
      }
      const dot = { ready: 'var(--green)', cloning: 'var(--amber)', error: 'var(--red)' }[r.cloneStatus] || 'var(--muted)';
      return `<span title="${esc(r.cloneStatus || 'idle')}" style="color:${dot}">●</span>`;
    }

    // Live status for the repos list: poll each active session's run-state so you can
    // see at a glance which is working vs ready — without opening any of them.
    function startReposStatusPolling() {
      stopReposStatusPolling();
      pollReposStatus();
      reposStatusTimer = setInterval(pollReposStatus, 3000);
    }
    function stopReposStatusPolling() {
      if (reposStatusTimer) { clearInterval(reposStatusTimer); reposStatusTimer = null; }
    }
    async function pollReposStatus() {
      const section = document.getElementById('inst-coding-repos-section');
      if (!currentInstance || currentInstanceTab !== 'coding' || !section || section.classList.contains('hidden')) { stopReposStatusPolling(); return; }
      const actives = codingSessions.filter(s => s.status === 'active');
      await Promise.all(actives.map(async (s) => {
        try {
          const snap = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${s.id}/capture`);
          codingReposStatus[s.repoId] = snap.alive ? snap.runState : 'offline';
        } catch (e) { /* keep prior */ }
        const span = document.querySelector(`[data-repo-status="${s.repoId}"]`);
        const r = codingRepos.find(x => x.id === s.repoId);
        if (span && r) span.innerHTML = repoStatusIcon(r, s);
        // Don't let you fire another voice reply while this repo is working.
        const reply = document.getElementById(`repo-reply-${s.repoId}`);
        if (reply) reply.disabled = (codingReposStatus[s.repoId] === 'thinking' || codingReposStatus[s.repoId] === 'responding');
      }));
    }

    // ── Deployment status (optional GitHub Actions integration) ──────────────
    // Independent of the agent: shows the latest build/deploy run so you know when
    // it's running / failed / live (to check the version). Empty for local or
    // non-GitHub repos, or when the GitHub App isn't installed.
    function repoDeployBadge(d) {
      if (!d || !d.available || !d.run) return '';
      const run = d.run;
      let icon, label, color;
      if (run.status !== 'completed') { icon = '⏳'; label = 'Deploying'; color = 'var(--amber)'; }
      else if (run.conclusion === 'success') { icon = '✅'; label = 'Live'; color = 'var(--green)'; }
      else if (run.conclusion === 'failure') { icon = '❌'; label = 'Build failed'; color = 'var(--red)'; }
      else { icon = '◦'; label = String(run.conclusion || run.status); color = 'var(--muted)'; }
      const n = run.runNumber != null ? ` #${esc(run.runNumber)}` : '';
      return `<a href="${esc(run.url || '#')}" target="_blank" rel="noopener" class="btn btn-outline btn-sm" style="padding:0.12rem 0.4rem;font-size:0.72rem;text-decoration:none;color:${color}" title="${esc(label)} — ${esc(run.name || 'workflow')}${n} (${esc(run.branch || '')} ${esc(run.sha || '')})" onclick="event.stopPropagation()">${icon} ${label}${n}</a>`;
    }
    function startDeployPolling() {
      stopDeployPolling();
      pollReposDeployments();
      deployStatusTimer = setInterval(pollReposDeployments, 25000);
    }
    function stopDeployPolling() {
      if (deployStatusTimer) { clearInterval(deployStatusTimer); deployStatusTimer = null; }
    }
    async function pollReposDeployments() {
      if (!currentInstance || currentInstanceTab !== 'coding') { stopDeployPolling(); return; }
      const withGh = codingRepos.filter(r => r.githubRepo);
      if (!withGh.length) { stopDeployPolling(); return; }
      await Promise.all(withGh.map(async (r) => {
        try {
          const d = await api(`/v1/instances/${currentInstance.id}/coding/repos/${r.id}/deployment`);
          if (d) codingDeployStatus[r.id] = d;
        } catch (e) { /* keep prior */ }
        const span = document.querySelector(`[data-repo-deploy="${r.id}"]`);
        if (span) span.innerHTML = repoDeployBadge(codingDeployStatus[r.id]);
      }));
      const s = codingSessions.find(x => x.id === currentCodingSession);
      const hdr = document.getElementById('inst-coding-deploy');
      if (hdr) hdr.innerHTML = s ? repoDeployBadge(codingDeployStatus[s.repoId]) : '';
    }

    // Hear the agent's last reply for a repo, right from the list — showing the
    // running text and highlighting each word as it's spoken (karaoke).
    async function playRepoLastReply(repoId, btn) {
      const active = codingSessions.find(s => s.repoId === repoId && s.status === 'active');
      if (!currentInstance || !active) return;
      const el = document.getElementById(`repo-play-${repoId}`);
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${active.id}/timeline`);
        const last = (d.chat || []).slice().reverse().find(m => m.type === 'chat_assistant');
        const text = last ? last.content : 'No reply yet.';
        if (el) speakTextKaraoke(text, el); else speakText(text);
      } catch (e) { /* ignore */ }
    }

    // Speak text while showing it and highlighting each word in real time. Uses the
    // utterance 'boundary' event (where supported — desktop Chrome; iOS may not fire
    // it, in which case the text still shows, just without per-word highlight).
    function speakTextKaraoke(text, el) {
      if (!window.speechSynthesis || !el) return;
      const clean = String(text || '').replace(/[*_`#>•]/g, '').replace(/\s+/g, ' ').trim();
      if (!clean) { el.style.display = 'none'; return; }
      // Build word spans with their char offsets so a boundary charIndex maps to a word.
      const words = [];
      let html = '';
      const re = /(\S+)(\s*)/g; let m;
      while ((m = re.exec(clean)) !== null) {
        words.push({ start: m.index, end: m.index + m[1].length });
        html += `<span data-kw="${words.length - 1}">${esc(m[1])}</span>${esc(m[2])}`;
      }
      el.innerHTML = html;
      el.style.display = '';
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(clean.slice(0, 3000));
        u.rate = 1.0;
        let lastSpan = null;
        u.onboundary = (e) => {
          if (e.name && e.name !== 'word') return;
          let wi = words.findIndex(w => e.charIndex >= w.start && e.charIndex < w.end);
          if (wi < 0) wi = words.findIndex(w => w.start >= e.charIndex);
          if (wi < 0) return;
          if (lastSpan) lastSpan.classList.remove('kw-on');
          const span = el.querySelector(`[data-kw="${wi}"]`);
          if (span) { span.classList.add('kw-on'); span.scrollIntoView({ block: 'nearest' }); lastSpan = span; }
        };
        u.onend = () => { if (lastSpan) lastSpan.classList.remove('kw-on'); };
        speechSynthesis.speak(u);
      } catch (e) { /* unsupported */ }
    }

    // Reply by voice straight from the list — dictate, send to the agent, no need to
    // open the repo. The watcher notifies + the status icon flips to working.
    function voiceReplyToRepo(repoId, btn) {
      if (window.speechSynthesis) speechSynthesis.cancel(); // recording stops any playback
      const active = codingSessions.find(s => s.repoId === repoId && s.status === 'active');
      if (!currentInstance || !active) { alert('Start the session first.'); return; }
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { alert('Voice input isn\'t supported here. On iPhone use the keyboard mic; on desktop try Chrome.'); return; }
      if (codingRecognizer) { try { codingRecognizer.stop(); } catch (e) {} return; }
      const el = document.getElementById(`repo-play-${repoId}`);
      const rec = new SR();
      rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false; // interim → live running text
      codingRecognizer = rec;
      if (btn) btn.classList.add('active');
      if (el) { el.style.display = ''; el.innerHTML = '<span style="color:var(--muted)">🎤 Listening…</span>'; }
      let finalText = '';
      rec.onresult = (e) => {
        finalText = ''; let interim = '';
        for (let i = 0; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText += t; else interim += t;
        }
        if (el) el.innerHTML = `<b>You:</b> ${esc((finalText + interim).trim())}`; // running text as you speak
      };
      rec.onend = async () => {
        codingRecognizer = null;
        if (btn) btn.classList.remove('active');
        const text = finalText.trim();
        if (!text) { if (el) el.style.display = 'none'; return; }
        if (el) el.innerHTML = `<b>You:</b> ${esc(text)} <span style="color:var(--muted)">— sending…</span>`;
        try {
          await api(`/v1/instances/${currentInstance.id}/coding/sessions/${active.id}/message`, { method: 'POST', body: JSON.stringify({ text, chat: true }) });
          if (el) el.innerHTML = `<b>You:</b> ${esc(text)} <span style="color:var(--green)">✓ sent</span>`;
          codingReposStatus[repoId] = 'thinking';
          const span = document.querySelector(`[data-repo-status="${repoId}"]`);
          const r = codingRepos.find(x => x.id === repoId);
          if (span && r) span.innerHTML = repoStatusIcon(r, active);
          if (btn) btn.disabled = true; // working — block another reply until idle
        } catch (e) { if (el) el.innerHTML = `<span style="color:var(--red)">Send failed: ${esc(e.message)}</span>`; }
      };
      rec.onerror = () => { codingRecognizer = null; if (btn) btn.classList.remove('active'); if (el) el.style.display = 'none'; };
      try { rec.start(); } catch (e) { codingRecognizer = null; if (btn) btn.classList.remove('active'); }
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
    // Collapser removed — the repo list is always shown open and full.
    function setCodingReposCollapsed() { /* no-op */ }
    function toggleCodingRepos() { /* no-op */ }

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
    // Delete the open project (rename/delete moved here from the repo list).
    async function deleteCurrentCodingRepo() {
      const s = codingSessions.find(x => x.id === currentCodingSession);
      if (!currentInstance || !s) return;
      if (!confirm('Delete this project? It removes the repo from the workspace.')) return;
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/repos/${s.repoId}`, { method: 'DELETE' });
        closeCodingTerminal();
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
      // Launch icons for the open repo, in the header.
      const links = document.getElementById('inst-coding-links');
      const cur = codingRepos.find(r => r.id === curRepo);
      if (links) links.innerHTML = cur ? repoLaunchIcons(cur) : '';
      const dep = document.getElementById('inst-coding-deploy');
      if (dep) dep.innerHTML = cur ? repoDeployBadge(codingDeployStatus[cur.id]) : '';
    }

    // Open-in-new-tab launch links (dev/staging/prod) — only the ones that are set.
    // Rendered on both the repos list and the open session header.
    function repoLaunchIcons(r) {
      const u = (r && r.urls) || {};
      const items = [['Dev', u.dev], ['Stg', u.staging], ['Prod', u.prod]].filter(x => x[1]);
      if (!items.length) return '';
      return items.map(([label, url]) =>
        `<a href="${esc(url)}" target="_blank" rel="noopener" class="btn btn-outline btn-sm" style="padding:0.2rem 0.4rem;text-decoration:none" title="Open ${label}: ${esc(url)}" onclick="event.stopPropagation()">${label} ↗</a>`
      ).join('');
    }

    // Toggle the launch-links editor in the session header, prefilled from the repo.
    function toggleCodingLinksEditor() {
      const ed = document.getElementById('inst-coding-links-editor');
      if (!ed) return;
      const opening = ed.classList.contains('hidden');
      ed.classList.toggle('hidden');
      if (opening) {
        const s = codingSessions.find(x => x.id === currentCodingSession);
        const r = s && codingRepos.find(x => x.id === s.repoId);
        const u = (r && r.urls) || {};
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
        set('inst-coding-url-dev', u.dev); set('inst-coding-url-staging', u.staging); set('inst-coding-url-prod', u.prod);
      }
    }

    async function saveCodingLinks() {
      const s = codingSessions.find(x => x.id === currentCodingSession);
      if (!currentInstance || !s) return;
      const val = id => (document.getElementById(id) || {}).value || '';
      const urls = { dev: val('inst-coding-url-dev').trim(), staging: val('inst-coding-url-staging').trim(), prod: val('inst-coding-url-prod').trim() };
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/repos/${s.repoId}`, { method: 'PUT', body: JSON.stringify({ urls }) });
        await loadCoding();          // refresh codingRepos (now with urls)
        renderCodingRepoSelect();    // re-render header icons
        toggleCodingLinksEditor();   // close
      } catch (e) { alert('Save failed: ' + e.message); }
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
