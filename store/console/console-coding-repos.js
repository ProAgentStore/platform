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
    let handsOffOn = false;               // hands-off voice mode running
    let handsOffPaused = false;
    let handsOffFocusIdx = 0;             // which eligible repo is focused
    let handsOffExcluded = {};            // repoId -> true (opted out of hands-off)
    let handsOffRec = null;               // continuous recognizer
    let handsOffLastStatus = {};          // repoId -> last runState (finish narration)
    let codingEngines = [];               // [{id,label,command}] — CLI launch presets
    let codingDefaultEngineId = 'claude'; // which preset is the default
    let codingRunnerOnline = null;        // last capture's runnerConnected (null=unknown)

    async function loadCoding() {
      if (!currentInstance) return;
      const host = document.getElementById('inst-coding-body');
      if (host) host.classList.remove('hidden');
      try {
        const [repos, sessions, engines] = await Promise.all([
          api(`/v1/instances/${currentInstance.id}/coding/repos`),
          api(`/v1/instances/${currentInstance.id}/coding/sessions`),
          api(`/v1/instances/${currentInstance.id}/coding/engines`).catch(() => null),
        ]);
        codingRepos = repos.repos || [];
        codingSessions = sessions.sessions || [];
        if (engines && Array.isArray(engines.engines) && engines.engines.length) {
          codingEngines = engines.engines;
          codingDefaultEngineId = engines.defaultEngineId || codingEngines[0].id;
        }
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
          <div data-repo-live="${r.id}" style="font-size:0.74rem;margin-top:0.15rem">${repoLiveLabel(r, active)}</div>
          ${sub ? `<div style="font-size:0.72rem;color:var(--muted);margin-top:0.1rem;word-break:break-all">${esc(sub)}</div>` : ''}
          <div style="display:flex;gap:0.35rem;flex-wrap:wrap;margin-top:0.5rem;align-items:center">
            ${active ? `
              <button type="button" class="btn btn-outline btn-sm" onclick="playRepoLastReply('${r.id}', this)" title="Hear the agent's last reply">🔊 Play</button>
              <button type="button" id="repo-reply-${r.id}" class="btn btn-outline btn-sm" onclick="voiceReplyToRepo('${r.id}', this)" title="Reply by voice — sends straight to the agent">🎤 Reply</button>
              <button type="button" class="btn btn-outline btn-sm" onclick="copyCodingConversation('${active.id}', this)" title="Copy this repo's conversation as JSON">⧉ Copy</button>
              <button type="button" class="btn btn-primary btn-sm" onclick="openCodingTerminal('${active.id}')">Open</button>`
              : `<button type="button" class="btn btn-primary btn-sm" onclick="chooseEngineThenStart('${r.id}')">Start</button>`}
            ${repoLaunchIcons(r)}
            ${handsOffOn && active ? `<label style="display:flex;align-items:center;gap:0.25rem;font-size:0.72rem;color:var(--muted);margin-left:auto" title="Include this repo in hands-off mode"><input type="checkbox" ${handsOffExcluded[r.id] ? '' : 'checked'} onchange="toggleHandsOffRepo('${r.id}', this.checked)" style="width:auto;margin:0"> hands-off</label>` : ''}
          </div>
          <div id="repo-play-${r.id}" class="repo-play" style="display:none"></div>
        </div>`;
      }).join('');
      renderCodingActivity();
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

    // Which engine a session is running (Claude / Codex / Grok / …), from its
    // client type or the first word of its launch command.
    function engineLabel(active) {
      const c = (active && (active.clientType || (active.launchCommand || '').trim().split(/\s+/)[0])) || 'claude';
      return c.charAt(0).toUpperCase() + c.slice(1);
    }
    // A human, real-time phrase for what a repo is doing right now — the heart of
    // "see what's happening". Driven by the live capture run-state + deploy + clone.
    function repoLiveLabel(r, active) {
      if (!active) {
        const m = { ready: 'No session — tap Start', cloning: 'Cloning…', error: 'Clone failed' }[r.cloneStatus] || 'No session';
        return `<span style="color:var(--muted)">${m}</span>`;
      }
      const st = codingReposStatus[r.id];
      const eng = engineLabel(active);
      if (st === 'offline') return `<span style="color:var(--muted)">⏸ Runner offline — run <code>pags up</code></span>`;
      if (st === 'thinking' || st === 'responding') return `<span style="color:var(--accent,#7c3aed)"><span class="coding-spin" style="vertical-align:-1px"></span> ${esc(eng)} is working…</span>`;
      const d = codingDeployStatus[r.id];
      if (d && d.available && d.run && d.run.status !== 'completed') return `<span style="color:var(--amber)">⏳ Deploying #${esc(d.run.runNumber)}…</span>`;
      if (d && d.available && d.run && d.run.conclusion === 'failure') return `<span style="color:var(--red)">❌ Build failed — ${esc(eng)} idle</span>`;
      return `<span style="color:var(--green)">✓ ${esc(eng)} ready for your reply</span>`;
    }

    // A one-line aggregate across all repos: how many are working / deploying /
    // ready / offline. Updated live alongside the per-row labels.
    function renderCodingActivity() {
      const el = document.getElementById('inst-coding-activity');
      if (!el) return;
      const actives = codingSessions.filter(s => s.status === 'active');
      if (!actives.length) { el.innerHTML = ''; return; }
      let working = 0, ready = 0, offline = 0, deploying = 0;
      actives.forEach(s => {
        const st = codingReposStatus[s.repoId];
        if (st === 'thinking' || st === 'responding') working++;
        else if (st === 'offline') offline++;
        else ready++;
        const d = codingDeployStatus[s.repoId];
        if (d && d.available && d.run && d.run.status !== 'completed') deploying++;
      });
      const parts = [];
      if (working) parts.push(`<span style="color:var(--accent,#7c3aed)"><span class="coding-spin" style="vertical-align:-1px"></span> ${working} working</span>`);
      if (deploying) parts.push(`<span style="color:var(--amber)">⏳ ${deploying} deploying</span>`);
      if (ready) parts.push(`<span style="color:var(--green)">✓ ${ready} ready</span>`);
      if (offline) parts.push(`<span style="color:var(--muted)">⏸ ${offline} offline</span>`);
      el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
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
          codingReposStatus[s.repoId] = snap.runnerConnected === false ? 'offline' : (snap.alive ? snap.runState : 'idle');
        } catch (e) { /* keep prior */ }
        // Hands-off proactive narration: when a repo finishes working, say so (and
        // play its last reply) — so you don't have to watch the screen.
        const now = codingReposStatus[s.repoId];
        const prev = handsOffLastStatus[s.repoId];
        if (handsOffOn && !handsOffPaused && !handsOffExcluded[s.repoId] &&
            (prev === 'thinking' || prev === 'responding') && now === 'idle') {
          const rr = codingRepos.find(x => x.id === s.repoId);
          if (rr) { speakText(`${rr.name} finished.`); }
        }
        handsOffLastStatus[s.repoId] = now;
        const span = document.querySelector(`[data-repo-status="${s.repoId}"]`);
        const r = codingRepos.find(x => x.id === s.repoId);
        if (span && r) span.innerHTML = repoStatusIcon(r, s);
        const live = document.querySelector(`[data-repo-live="${s.repoId}"]`);
        if (live && r) live.innerHTML = repoLiveLabel(r, s);
        // Don't let you fire another voice reply while this repo is working.
        const reply = document.getElementById(`repo-reply-${s.repoId}`);
        if (reply) reply.disabled = (codingReposStatus[s.repoId] === 'thinking' || codingReposStatus[s.repoId] === 'responding');
      }));
      renderCodingActivity();
      if (document.getElementById('diag-dialog')) renderDiag();
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
        const live = document.querySelector(`[data-repo-live="${r.id}"]`);
        const act = codingSessions.find(x => x.repoId === r.id && x.status === 'active');
        if (live) live.innerHTML = repoLiveLabel(r, act);
      }));
      renderCodingActivity();
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

    // Copy a repo's whole conversation as JSON — chat + terminal snapshots + the
    // brain's decisions + outcomes — to paste into another assistant for debugging.
    async function copyCodingConversation(sessionId, btn) {
      if (!currentInstance || !sessionId) { return; }
      const orig = btn ? btn.innerHTML : '';
      if (btn) btn.textContent = '…';
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${sessionId}/timeline?full=1`);
        const events = d.timeline || d.chat || [];
        const sess = codingSessions.find(s => s.id === sessionId);
        const repo = sess && codingRepos.find(r => r.id === sess.repoId);
        const json = JSON.stringify({
          instanceId: currentInstance.id,
          sessionId,
          repo: repo ? { id: repo.id, name: repo.name, githubRepo: repo.githubRepo || null, workdir: repo.workdir || null } : null,
          count: events.length,
          timeline: events,
        }, null, 2);
        await navigator.clipboard.writeText(json);
        if (btn) { btn.textContent = `Copied ${events.length} ✓`; setTimeout(() => { btn.innerHTML = orig || '⧉'; }, 1800); }
      } catch (e) {
        if (btn) { btn.textContent = 'Failed'; setTimeout(() => { btn.innerHTML = orig || '⧉'; }, 1800); }
        else alert('Copy failed: ' + (e && e.message));
      }
    }

    // ── CLI engine presets (which command launches each engine) ──────────────
    function toggleEnginesPanel() {
      let bg = document.getElementById('engines-dialog');
      if (bg) { bg.remove(); return; }
      bg = document.createElement('div');
      bg.id = 'engines-dialog';
      bg.className = 'coding-dialog-backdrop';
      bg.innerHTML = `<div class="coding-dialog" style="max-width:520px">
        <div class="coding-dialog-title">CLI engines<button onclick="document.getElementById('engines-dialog').remove()" aria-label="Close">&times;</button></div>
        <div style="padding:0 0.55rem">
          <p style="font-size:0.72rem;color:var(--muted-soft);margin:0 0 0.5rem">The exact command each engine launches. When you start a session you pick one.</p>
          <div id="inst-engines-rows" style="display:flex;flex-direction:column;gap:0.4rem"></div>
          <div style="display:flex;gap:0.35rem;align-items:center;margin-top:0.5rem;flex-wrap:wrap">
            <button type="button" class="btn btn-outline btn-sm" onclick="addEngineRow()">+ Engine</button>
            <button type="button" class="btn btn-primary btn-sm" onclick="saveEngines()">Save</button>
            <span id="inst-engines-status" style="font-size:0.78rem;color:var(--muted)"></span>
          </div>
        </div>
      </div>`;
      bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
      document.body.appendChild(bg);
      renderEnginesEditor();
    }
    function renderEnginesEditor() {
      const rows = document.getElementById('inst-engines-rows');
      if (!rows) return;
      const list = (codingEngines && codingEngines.length) ? codingEngines : [{ id: 'claude', label: 'Claude Code', command: 'claude --dangerously-skip-permissions' }];
      rows.innerHTML = list.map((e, i) => engineRowHtml(e, i)).join('');
    }
    function engineRowHtml(e, i) {
      const isDefault = (e.id || '') === codingDefaultEngineId || (i === 0 && !codingEngines.some(x => x.id === codingDefaultEngineId));
      return `<div class="engine-row" data-engine-id="${esc(e.id || '')}" style="display:flex;gap:0.35rem;align-items:center;flex-wrap:wrap">
        <input class="engine-label" placeholder="Label (e.g. Claude)" value="${esc(e.label || '')}" style="font-size:0.82rem;width:9rem;flex-shrink:0">
        <input class="engine-command" placeholder="claude --dangerously-skip-permissions" value="${esc(e.command || '')}" style="font-size:0.82rem;flex:1;min-width:140px;font-family:'SF Mono',monospace">
        <label style="display:flex;align-items:center;gap:0.25rem;font-size:0.72rem;color:var(--muted)" title="Default engine"><input type="radio" name="engine-default" ${isDefault ? 'checked' : ''} style="width:auto;margin:0"> default</label>
        <button type="button" class="btn btn-outline btn-sm" onclick="this.closest('.engine-row').remove()" title="Remove" style="padding:0.2rem 0.45rem">✕</button>
      </div>`;
    }
    function addEngineRow() {
      const rows = document.getElementById('inst-engines-rows');
      if (!rows) return;
      rows.insertAdjacentHTML('beforeend', engineRowHtml({ id: '', label: '', command: '' }, rows.children.length));
    }
    async function saveEngines() {
      if (!currentInstance) return;
      const status = document.getElementById('inst-engines-status');
      const rowEls = [...document.querySelectorAll('#inst-engines-rows .engine-row')];
      const engines = [];
      let defaultEngineId = '';
      rowEls.forEach(row => {
        const label = (row.querySelector('.engine-label').value || '').trim();
        const command = (row.querySelector('.engine-command').value || '').trim();
        if (!label || !command) return;
        const id = (row.getAttribute('data-engine-id') || label.toLowerCase().replace(/[^a-z0-9-]+/g, '-')).replace(/^-+|-+$/g, '') || 'engine';
        engines.push({ id, label, command });
        if (row.querySelector('input[name="engine-default"]').checked) defaultEngineId = id;
      });
      if (!engines.length) { if (status) status.textContent = 'Add at least one engine.'; return; }
      if (status) status.textContent = 'Saving…';
      try {
        const res = await api(`/v1/instances/${currentInstance.id}/coding/engines`, { method: 'PUT', body: JSON.stringify({ engines, defaultEngineId: defaultEngineId || engines[0].id }) });
        codingEngines = res.engines || engines;
        codingDefaultEngineId = res.defaultEngineId || codingEngines[0].id;
        if (status) status.textContent = 'Saved ✓';
        setTimeout(() => { if (status) status.textContent = ''; }, 1600);
      } catch (e) { if (status) status.textContent = 'Save failed: ' + e.message; }
    }

    // ── Hands-off voice mode ─────────────────────────────────────────────────
    // Two modes, both driven by ONE continuous recognizer over the repos list:
    //   • commands — say "next/back/play/stop"; any other phrase is sent to the
    //     focused repo's agent (which routes: answer vs. drive Claude).
    //   • smart    — every phrase goes to the cross-repo Overseer, which decides
    //     what to do and where; its reply is spoken back. A nonstop conversation
    //     on top of all your repos.
    // Scope is all eligible repos, or just the focused one. Per-repo include/
    // exclude toggles appear in the list only while hands-off is running.
    function toggleHandsOffPanel() {
      let bg = document.getElementById('handsoff-dialog');
      if (bg) { bg.remove(); return; }
      bg = document.createElement('div');
      bg.id = 'handsoff-dialog';
      bg.className = 'coding-dialog-backdrop';
      bg.innerHTML = `<div class="coding-dialog" style="max-width:420px">
        <div class="coding-dialog-title">Hands-off mode<button onclick="document.getElementById('handsoff-dialog').remove()" aria-label="Close">&times;</button></div>
        <div style="padding:0 0.55rem">
          <div style="display:grid;grid-template-columns:auto 1fr;gap:0.4rem 0.5rem;align-items:center;font-size:0.82rem">
            <label style="margin:0">Mode</label>
            <select id="handsoff-mode" style="font-size:0.82rem">
              <option value="smart">Smart — converse with the Overseer</option>
              <option value="commands">Commands — say "next / play / record"</option>
            </select>
            <label style="margin:0">Scope</label>
            <select id="handsoff-scope" style="font-size:0.82rem">
              <option value="all">All repos</option>
              <option value="focused">Just the focused repo</option>
            </select>
          </div>
          <div style="display:flex;gap:0.35rem;align-items:center;margin-top:0.5rem;flex-wrap:wrap">
            <button type="button" id="handsoff-start" class="btn btn-primary btn-sm" onclick="startHandsOff()">Start</button>
            <button type="button" id="handsoff-pause" class="btn btn-outline btn-sm hidden" onclick="toggleHandsOffPause()">Pause</button>
            <button type="button" id="handsoff-stop" class="btn btn-outline btn-sm hidden" onclick="stopHandsOff()" style="color:var(--red)">Stop</button>
            <span id="handsoff-status" style="font-size:0.78rem;color:var(--muted)"></span>
          </div>
          <p style="font-size:0.72rem;color:var(--muted-soft);margin:0.4rem 0 0">Say "next" to move between repos, "play" to hear, "record" to reply. Toggle repos in/out from the list below.</p>
        </div>
      </div>`;
      bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
      document.body.appendChild(bg);
    }
    function handsOffStatus(t) {
      const el = document.getElementById('handsoff-status');
      if (el) el.textContent = t || '';
    }
    // Repos that take part in hands-off: a live session + not opted out. Scope
    // 'focused' narrows to the single focused repo.
    function handsOffEligibleRepos() {
      const scope = (document.getElementById('handsoff-scope') || {}).value || 'all';
      const list = codingRepos.filter(r =>
        codingSessions.some(s => s.repoId === r.id && s.status === 'active') && !handsOffExcluded[r.id]);
      if (scope === 'focused' && list.length) {
        const f = list[((handsOffFocusIdx % list.length) + list.length) % list.length];
        return f ? [f] : list;
      }
      return list;
    }
    function handsOffFocusRepo() {
      const list = handsOffEligibleRepos();
      if (!list.length) return null;
      return list[((handsOffFocusIdx % list.length) + list.length) % list.length];
    }
    function startHandsOff() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { alert('Hands-off voice isn\'t supported here. Try Chrome on desktop or Android.'); return; }
      if (!handsOffEligibleRepos().length) { alert('Start a coding session on at least one repo first.'); return; }
      handsOffOn = true; handsOffPaused = false; handsOffFocusIdx = 0;
      document.getElementById('handsoff-start')?.classList.add('hidden');
      document.getElementById('handsoff-pause')?.classList.remove('hidden');
      document.getElementById('handsoff-stop')?.classList.remove('hidden');
      const sel = document.getElementById('handsoff-mode');
      if (sel) sel.disabled = true;
      const sc = document.getElementById('handsoff-scope');
      if (sc) sc.disabled = true;
      renderCodingRepos(); // re-render to show per-repo include toggles
      const r = handsOffFocusRepo();
      speakText(`Hands-off on. Focused on ${r ? r.name : 'your repos'}.`);
      handsOffStatus('listening…');
      handsOffListen();
    }
    function stopHandsOff() {
      handsOffOn = false; handsOffPaused = false;
      if (handsOffRec) { try { handsOffRec.stop(); } catch (e) {} handsOffRec = null; }
      if (window.speechSynthesis) speechSynthesis.cancel();
      document.getElementById('handsoff-start')?.classList.remove('hidden');
      document.getElementById('handsoff-pause')?.classList.add('hidden');
      document.getElementById('handsoff-stop')?.classList.add('hidden');
      const pb = document.getElementById('handsoff-pause');
      if (pb) pb.textContent = '⏸ Pause';
      const sel = document.getElementById('handsoff-mode'); if (sel) sel.disabled = false;
      const sc = document.getElementById('handsoff-scope'); if (sc) sc.disabled = false;
      handsOffStatus('');
      renderCodingRepos(); // re-render to hide per-repo include toggles
    }
    function toggleHandsOffPause() {
      handsOffPaused = !handsOffPaused;
      const b = document.getElementById('handsoff-pause');
      if (b) b.textContent = handsOffPaused ? '▶ Resume' : '⏸ Pause';
      if (handsOffPaused) {
        if (handsOffRec) { try { handsOffRec.stop(); } catch (e) {} }
        if (window.speechSynthesis) speechSynthesis.cancel();
        handsOffStatus('paused');
      } else {
        handsOffStatus('listening…');
        handsOffListen();
      }
    }
    // The continuous recognizer. It self-restarts on end (Chrome ends a continuous
    // session periodically) for as long as hands-off is on and not paused.
    function handsOffListen() {
      if (!handsOffOn || handsOffPaused) return;
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return;
      const rec = new SR();
      rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = false;
      handsOffRec = rec;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            const t = (e.results[i][0].transcript || '').trim();
            if (t) onHandsOffPhrase(t);
          }
        }
      };
      rec.onend = () => {
        if (handsOffOn && !handsOffPaused) {
          try { rec.start(); } catch (e) { setTimeout(() => { if (handsOffOn && !handsOffPaused) handsOffListen(); }, 600); }
        }
      };
      rec.onerror = () => { /* 'no-speech' etc — onend restarts */ };
      try { rec.start(); } catch (e) { /* already running */ }
    }
    async function onHandsOffPhrase(text) {
      const low = text.toLowerCase().trim();
      if (/^(stop|pause|hold on)\b/.test(low)) { toggleHandsOffPause(); return; }
      const mode = (document.getElementById('handsoff-mode') || {}).value || 'smart';
      if (mode === 'commands') {
        if (/^(next|skip|go on|forward)\b/.test(low)) return handsOffNext(1);
        if (/^(previous|back|prev|go back)\b/.test(low)) return handsOffNext(-1);
        if (/^(play|read|repeat|say again)\b/.test(low)) return handsOffPlayFocused();
        if (/^(record|reply|note)\b/.test(low)) { speakText('Go ahead.'); handsOffStatus('say your instruction…'); return; }
        return handsOffSendToFocused(text); // any other phrase → the focused repo's agent
      }
      // smart mode → the Overseer across all repos, then speak its reply
      handsOffStatus('thinking…');
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/overseer`, { method: 'POST', body: JSON.stringify({ message: text }) });
        speakText(d && d.reply ? d.reply : 'Done.');
      } catch (e) { speakText('Sorry, I had trouble with that.'); }
      handsOffStatus('listening…');
    }
    function handsOffNext(dir) {
      const list = handsOffEligibleRepos();
      if (!list.length) { speakText('No repos in hands-off.'); return; }
      handsOffFocusIdx = (handsOffFocusIdx + dir + list.length) % list.length;
      const r = list[handsOffFocusIdx];
      speakText(`Now on ${r.name}.`);
      handsOffPlayFocused();
    }
    async function handsOffPlayFocused() {
      const r = handsOffFocusRepo();
      if (!r) { speakText('No repo focused.'); return; }
      const active = codingSessions.find(s => s.repoId === r.id && s.status === 'active');
      if (!active) { speakText(`${r.name} has no live session.`); return; }
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${active.id}/timeline`);
        const last = (d.chat || []).slice().reverse().find(m => m.type === 'chat_assistant');
        speakText(`${r.name}: ${last ? last.content : 'no update yet'}`);
      } catch (e) { speakText(`${r.name}: couldn't read it.`); }
    }
    async function handsOffSendToFocused(text) {
      const r = handsOffFocusRepo();
      if (!r) { speakText('No repo focused.'); return; }
      const active = codingSessions.find(s => s.repoId === r.id && s.status === 'active');
      if (!active) { speakText(`${r.name} has no live session.`); return; }
      handsOffStatus('sending…');
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${active.id}/agent`, { method: 'POST', body: JSON.stringify({ message: text }) });
        if (d && d.delegated) { speakText(`On it, ${r.name}.`); codingReposStatus[r.id] = 'thinking'; }
        else speakText((d && d.reply) ? d.reply : `Sent to ${r.name}.`);
      } catch (e) { speakText('Send failed.'); }
      handsOffStatus('listening…');
    }
    function toggleHandsOffRepo(repoId, included) {
      if (included) delete handsOffExcluded[repoId]; else handsOffExcluded[repoId] = true;
    }

    // ── Diagnostics: list every session + restart / kill / view (cleanup) ────
    function toggleDiagPanel() {
      let bg = document.getElementById('diag-dialog');
      if (bg) { bg.remove(); return; }
      bg = document.createElement('div');
      bg.id = 'diag-dialog';
      bg.className = 'coding-dialog-backdrop';
      bg.innerHTML = `<div class="coding-dialog" style="max-width:520px">
        <div class="coding-dialog-title">Sessions<button onclick="document.getElementById('diag-dialog').remove()" aria-label="Close">&times;</button></div>
        <div style="padding:0 0.55rem">
          <p style="font-size:0.72rem;color:var(--muted-soft);margin:0 0 0.4rem">Every coding session on this agent. <b>Restart</b> kills + relaunches the CLI; <b>Kill</b> ends the session.</p>
          <div id="inst-coding-diag-body"></div>
        </div>
      </div>`;
      bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
      document.body.appendChild(bg);
      loadDiag();
    }
    async function loadDiag() {
      if (!currentInstance) return;
      try {
        const s = await api(`/v1/instances/${currentInstance.id}/coding/sessions`);
        codingSessions = s.sessions || codingSessions;
      } catch (e) { /* keep prior */ }
      renderDiag();
    }
    function renderDiag() {
      const el = document.getElementById('inst-coding-diag-body');
      if (!el) return;
      const sessions = codingSessions.slice().sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1));
      if (!sessions.length) { el.innerHTML = '<div class="empty" style="padding:0.5rem;font-size:0.8rem">No sessions yet.</div>'; return; }
      el.innerHTML = sessions.map(s => {
        const repo = codingRepos.find(r => r.id === s.repoId);
        const name = repo ? repo.name : s.repoId;
        const active = s.status === 'active';
        let state, color;
        if (!active) { state = s.status || 'ended'; color = 'var(--muted)'; }
        else {
          const st = codingReposStatus[s.repoId];
          if (st === 'thinking' || st === 'responding') { state = 'working'; color = 'var(--accent,#7c3aed)'; }
          else if (st === 'offline') { state = 'offline'; color = 'var(--muted)'; }
          else { state = 'idle'; color = 'var(--green)'; }
        }
        return `<div style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap;padding:0.35rem 0;border-bottom:1px solid var(--line)">
          <span style="color:${color};font-weight:600;font-size:0.76rem;min-width:4.5rem">● ${esc(state)}</span>
          <b style="font-size:0.82rem;overflow-wrap:anywhere">${esc(name)}</b>
          <span style="font-size:0.7rem;color:var(--muted)">${esc(engineLabel(s))} · …${esc((s.id || '').slice(-6))}</span>
          <span style="display:flex;gap:0.3rem;margin-left:auto">
            ${active ? `<button type="button" class="btn btn-outline btn-sm" onclick="openCodingTerminal('${s.id}')" title="See the live screen">View</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="restartSession('${s.id}', this)" title="Kill + relaunch the CLI (keeps the session)">Restart</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="killSession('${s.id}', this)" title="End the session + stop the CLI" style="color:var(--red)">Kill</button>` : ''}
          </span>
        </div>`;
      }).join('');
    }
    async function restartSession(sessionId, btn) {
      if (!currentInstance) return;
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${sessionId}/restart`, { method: 'POST', body: '{}' });
        if (d && d.runnerConnected === false) alert('No runner connected — run `pags up`.');
      } catch (e) { alert('Restart failed: ' + e.message); }
      await loadDiag();
    }
    async function killSession(sessionId, btn) {
      if (!currentInstance || !confirm('Kill this session and stop its CLI?')) return;
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/sessions/${sessionId}/end`, { method: 'POST', body: '{}' });
      } catch (e) { alert('Kill failed: ' + e.message); }
      await loadCoding();
      renderDiag();
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
          `<button type="button" class="btn btn-outline btn-sm" onclick='importGitHubRepo(${esc(JSON.stringify({ fullName: r.fullName, cloneUrl: r.cloneUrl, branch: r.defaultBranch }))})'>
            ${esc(r.fullName)}${r.private ? ' 🔒' : ''}
          </button>`).join('');
      } catch (e) { list.innerHTML = `<span style="color:var(--red);font-size:0.8rem">${esc(e.message)}</span>`; }
    }

    async function importGitHubRepo(json) {
      const r = typeof json === 'string' ? JSON.parse(json) : json;
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/repos`, {
          method: 'POST', body: JSON.stringify({ name: r.fullName.split('/').pop(), githubRepo: r.fullName, cloneUrl: r.cloneUrl, branch: r.branch || r.defaultBranch }),
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
        const res = await api(`/v1/instances/${currentInstance.id}/coding/repos`, { method: 'POST', body: JSON.stringify(body) });
        input.value = '';
        await loadCoding();
        setAddRepoOpen(false); // collapse the form once a repo is added
        // Onboarding: adding a repo immediately offers to start a session — pick the
        // engine and go, instead of leaving a dead repo with no session.
        const newId = res && res.repo && res.repo.id;
        if (newId) chooseEngineThenStart(newId);
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

    // Ask which engine (Claude / Codex / Grok / custom) to launch, then start.
    // With one preset it just starts; multiple opens a dialog.
    function chooseEngineThenStart(repoId) {
      if (!Array.isArray(codingEngines) || codingEngines.length <= 1) { startCodingSession(repoId); return; }
      let bg = document.getElementById('engine-pick-dialog');
      if (bg) bg.remove();
      bg = document.createElement('div');
      bg.id = 'engine-pick-dialog';
      bg.className = 'coding-dialog-backdrop';
      const buttons = codingEngines.map(e =>
        `<button class="coding-action" onclick="document.getElementById('engine-pick-dialog').remove();startCodingSession('${repoId}','${esc(e.id)}')">
          ${esc(e.label)}${e.id === codingDefaultEngineId ? ' <small>default</small>' : ''}
          <small>${esc(e.command)}</small>
        </button>`).join('');
      bg.innerHTML = `<div class="coding-dialog">
        <div class="coding-dialog-title">Start with<button onclick="document.getElementById('engine-pick-dialog').remove()" aria-label="Close">&times;</button></div>
        ${buttons}
      </div>`;
      bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
      document.body.appendChild(bg);
    }

    async function startCodingSession(repoId, engineId) {
      if (!currentInstance) return;
      try {
        const res = await api(`/v1/instances/${currentInstance.id}/coding/sessions`, {
          method: 'POST', body: JSON.stringify({ repoId, engineId: engineId || codingDefaultEngineId }),
        });
        await loadCoding();
        openCodingTerminal(res.session.id); // the session view shows the "run pags up" CTA if no runner
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
