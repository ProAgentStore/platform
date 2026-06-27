    // ── Coding workspace — the open session (terminal + Agent co-pilot) ───────
    // Owns the full-screen session surface: the live terminal poll, the Agent
    // co-pilot thread (summaries + voice), driving Claude, run-state, and the
    // autonomous brain handoff. All shared state is declared in
    // console-coding-repos.js (classic scripts share top-level `let`), so this
    // file declares NO module state — only functions.

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
      // Full-screen the session: the repo list + Overseer move out of the way.
      document.getElementById('inst-coding-repos-section')?.classList.add('hidden');
      document.getElementById('inst-coding-overseer')?.classList.add('hidden');
      stopReposStatusPolling();
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
      // Only auto-summarize once we have a live runner + terminal — otherwise the
      // co-pilot answers from an empty terminal ("I don't have any context…"),
      // which is the confusing experience we're fixing. The offline banner guides
      // the user to `pags up` instead.
      if (!codingSummaryHistory.length) setTimeout(() => { if (codingRunnerOnline !== false) refreshCodingSummary(); }, 1400);
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
      if (window.speechSynthesis) speechSynthesis.cancel(); // recording stops any playback
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

    // The Agent chat (one smart input): the server decides per message — answer from
    // the terminal + history, OR delegate to Claude Code (it types the instruction
    // into the CLI for you). Prefix with `@claude` to force delegation. When it
    // delegates, the durable watcher summarizes + notifies on finish (chat poll shows
    // that reply later). This calls the tool-loop endpoint that the Overseer reuses.
    async function sendCodingInstruction() {
      if (!currentInstance || !currentCodingSession) return;
      const input = document.getElementById('inst-coding-ask');
      const text = (input.value || '').trim();
      if (!text) return;
      input.value = '';
      codingSummaryHistory.push({ role: 'user', content: text });
      codingSummaryBusy = true;
      renderCodingSummary();
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/agent`, {
          method: 'POST', body: JSON.stringify({ message: text }),
        });
        codingSummaryHistory.push({ role: 'assistant', content: d.reply || '(no response)' });
        speakCoding(d.reply);
        if (d.delegated) { setCodingRunState('thinking'); setTimeout(pollCodingTerminal, 300); } // Claude is now working
      } catch (e) {
        codingSummaryHistory.push({ role: 'assistant', content: 'Could not reach the agent: ' + e.message });
      } finally {
        codingSummaryBusy = false;
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

    function closeCodingTerminal() {
      const hadSession = !!currentCodingSession;
      stopCodingPolling();
      if (window.speechSynthesis) speechSynthesis.cancel();
      setCodingReposCollapsed(false); // bring the repo list back
      document.getElementById('inst-coding-repos-section')?.classList.remove('hidden');
      document.getElementById('inst-coding-overseer')?.classList.remove('hidden');
      startReposStatusPolling(); // resume live status on the list
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

    // ⚙ session-actions dialog (bottom-sheet on mobile, centred on desktop).
    function toggleCodingMenu(ev) {
      if (ev) ev.stopPropagation();
      let bg = document.getElementById('coding-menu-dialog');
      if (bg) { bg.remove(); return; }
      bg = document.createElement('div');
      bg.id = 'coding-menu-dialog';
      bg.className = 'coding-dialog-backdrop';
      const online = codingRunnerOnline !== false;
      bg.innerHTML = `<div class="coding-dialog">
        <div class="coding-dialog-title">Session<button onclick="closeCodingMenu()" aria-label="Close">&times;</button></div>
        ${!online ? '<div style="color:var(--red);font-size:0.8rem;padding:0.4rem 0.6rem;background:rgba(239,68,68,0.08);border-radius:6px;margin-bottom:0.4rem">Runner offline — run <code>pags up</code> to reconnect</div>' : ''}
        <button class="coding-action" onclick="renameCurrentCodingRepo();closeCodingMenu()">✎ Rename project</button>
        <button class="coding-action" onclick="toggleCodingLinksEditor();closeCodingMenu()">🔗 Launch links…</button>
        <div class="coding-dialog-sep"></div>
        <button class="coding-action${online ? '' : ' disabled'}" ${online ? '' : 'disabled'} onclick="runCodingBrain();closeCodingMenu()">🤖 Run with AI<small>give it a goal — it works autonomously</small></button>
        <button class="coding-action${online ? '' : ' disabled'}" ${online ? '' : 'disabled'} onclick="resumeCodingBrain();closeCodingMenu()">▶ Resume AI<small>continue after it paused for you</small></button>
        <button class="coding-action coding-term-only${online ? '' : ' disabled'}" ${online ? '' : 'disabled'} onclick="sendCodingKey('Escape');closeCodingMenu()">⎋ Esc<small>send Escape to the CLI</small></button>
        <button class="coding-action coding-term-only${online ? '' : ' disabled'}" ${online ? '' : 'disabled'} onclick="sendCodingKey('C-c');closeCodingMenu()">Ctrl-C<small>interrupt the CLI</small></button>
        <div class="coding-dialog-sep"></div>
        <button class="coding-action${online ? '' : ' disabled'}" ${online ? '' : 'disabled'} onclick="restartCodingSession();closeCodingMenu()">🔄 Restart session<small>${online ? 'kill + relaunch the CLI (same repo)' : 'runner offline'}</small></button>
        <button class="coding-action coding-action-danger" onclick="endCodingSession();closeCodingMenu()">⏹ End session<small>stop the CLI on your machine</small></button>
        <button class="coding-action coding-action-danger" onclick="deleteCurrentCodingRepo();closeCodingMenu()">🗑 Delete project</button>
      </div>`;
      bg.addEventListener('click', (e) => { if (e.target === bg) closeCodingMenu(); });
      document.body.appendChild(bg);
    }
    function closeCodingMenu() {
      const bg = document.getElementById('coding-menu-dialog');
      if (bg) bg.remove();
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
      const busy = state === 'thinking' || state === 'responding';
      if (busy) {
        badge.innerHTML = '<span class="coding-spin" aria-label="working"></span>';
      } else if (state === 'idle') {
        badge.textContent = '●';
        badge.style.color = 'var(--green)';
      } else if (state === 'stopped') {
        badge.textContent = '●';
        badge.style.color = 'var(--amber,#f59e0b)';
      } else {
        badge.textContent = '○';
        badge.style.color = 'var(--muted)';
      }
      // While the agent is working, don't let you fire another instruction at it —
      // disable Send + mic (the read-only Status/Play stay usable).
      ['inst-coding-send', 'inst-coding-mic'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.disabled = busy;
      });
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
        if (/^\[(error|cannot)/i.test(line) || /exited with code/.test(line) || /^\[[\w.-]+\]\s/.test(line)) return `<span style="color:#f87171">${e}</span>`;
        return `<span style="color:#86efac">${mdLite(line)}</span>`; // reply: render light markdown
      }).join('\n');
    }

    async function pollCodingTerminal() {
      if (!currentInstance || !currentCodingSession) return;
      try {
        const snap = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/capture`);
        codingRunnerOnline = snap.runnerConnected !== false;
        const off = document.getElementById('inst-coding-offline');
        if (off) off.classList.toggle('hidden', codingRunnerOnline);
        const pre = document.getElementById('inst-coding-pane');
        const paneActions = document.getElementById('inst-coding-pane-actions');
        if (pre) {
          const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
          if (snap.pane) {
            if (snap.pane !== lastCodingPane) { pre.innerHTML = colorizeCodingPane(snap.pane); lastCodingPane = snap.pane; }
            if (paneActions) { paneActions.classList.add('hidden'); paneActions.innerHTML = ''; }
          } else {
            if (!snap.runnerConnected) {
              const node = currentRuntimeInfo?.runtime?.runnerNode;
              pre.textContent = `(runner offline${node ? ' — was on ' + node : ''}. Run pags up to connect.)`;
              if (paneActions) { paneActions.classList.add('hidden'); paneActions.innerHTML = ''; }
            } else if (snap.alive === false) {
              pre.textContent = '(session stopped — the CLI is not running.)';
              if (paneActions) {
                paneActions.classList.remove('hidden');
                paneActions.innerHTML = '<button type="button" class="btn btn-primary btn-sm" onclick="restartCodingSession()">Restart session</button>';
              }
            } else {
              pre.textContent = '(waiting for the CLI…)';
              if (paneActions) { paneActions.classList.add('hidden'); paneActions.innerHTML = ''; }
            }
            lastCodingPane = '';
          }
          if (atBottom) pre.scrollTop = pre.scrollHeight;
        }
        setCodingRunState(!snap.runnerConnected ? 'offline' : snap.alive ? snap.runState : 'stopped');
        // Disable inputs when runner is unreachable, re-enable when it comes back
        const offline = !snap.runnerConnected;
        const msgEl = document.getElementById('inst-coding-msg');
        if (msgEl) { msgEl.disabled = offline; msgEl.placeholder = offline ? 'Runner offline — run pags up' : 'Type a message to the CLI and press Enter…'; }
        const askEl = document.getElementById('inst-coding-ask');
        if (askEl) { askEl.disabled = offline; askEl.placeholder = offline ? 'Runner offline — run pags up' : 'Ask about it, or tell it to do something — it routes for you (@claude forces)…'; }
        const sendEl = document.getElementById('inst-coding-send');
        if (sendEl) sendEl.disabled = offline;
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

    async function restartCodingSession() {
      if (!currentInstance || !currentCodingSession) return;
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${currentCodingSession}/restart`, { method: 'POST', body: '{}' });
        if (d && d.runnerConnected === false) alert('No runner connected — run `pags up`.');
      } catch (e) { alert('Restart failed: ' + e.message); }
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
