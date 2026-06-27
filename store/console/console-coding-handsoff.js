
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
            <label style="margin:0">Voice</label>
            <select id="handsoff-provider" style="font-size:0.82rem" onchange="onVoiceProviderChange(this.value)">
              <option value="browser"${handsOffVoiceProvider === 'browser' ? ' selected' : ''}>Browser (free, robotic)</option>
              <option value="openai-realtime"${handsOffVoiceProvider === 'openai-realtime' ? ' selected' : ''}>OpenAI Realtime (natural, fast)</option>
              <option value="gemini-live"${handsOffVoiceProvider === 'gemini-live' ? ' selected' : ''}>Gemini Live (natural, cheaper)</option>
            </select>
            <div id="handsoff-provider-opts" style="grid-column:1/-1"></div>
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
            <button type="button" id="handsoff-start" class="btn btn-primary btn-sm${handsOffOn ? ' hidden' : ''}" onclick="startHandsOff()">Start</button>
            <button type="button" id="handsoff-pause" class="btn btn-outline btn-sm${handsOffOn ? '' : ' hidden'}" onclick="toggleHandsOffPause()">${handsOffPaused ? '▶ Resume' : '⏸ Pause'}</button>
            <button type="button" id="handsoff-stop" class="btn btn-outline btn-sm${handsOffOn ? '' : ' hidden'}" onclick="stopHandsOff()" style="color:var(--red)">Stop</button>
            <span id="handsoff-status" style="font-size:0.78rem;color:var(--muted)"></span>
          </div>
          <p style="font-size:0.72rem;color:var(--muted-soft);margin:0.4rem 0 0">Say "next" to move between repos, "play" to hear, "record" to reply. Toggle repos in/out from the list below.</p>
        </div>
      </div>`;
      bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
      document.body.appendChild(bg);
      loadVoiceSettings();
    }
    function handsOffStatus(t) {
      const el = document.getElementById('handsoff-status');
      if (el) el.textContent = t || '';
    }

    // Load voice settings from server on first open
    async function loadVoiceSettings() {
      if (!currentInstance) return;
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/voice-settings`);
        const s = d.voiceSettings || {};
        handsOffVoiceProvider = s.provider || 'browser';
        handsOffVoiceSettings = s;
      } catch { /* keep defaults */ }
      renderVoiceProviderOpts();
    }

    async function saveVoiceSettings() {
      if (!currentInstance) return;
      const settings = {
        provider: handsOffVoiceProvider,
        speed: handsOffVoiceSettings.speed || 100,
        openai: handsOffVoiceSettings.openai || { model: 'gpt-realtime', voice: 'alloy' },
        gemini: handsOffVoiceSettings.gemini || { model: 'gemini-2.0-flash-exp' },
        language: handsOffVoiceSettings.language || 'en-US',
      };
      await api(`/v1/instances/${currentInstance.id}/voice-settings`, {
        method: 'PUT', body: JSON.stringify(settings),
      }).catch(() => {});
    }

    function onVoiceProviderChange(value) {
      handsOffVoiceProvider = value;
      renderVoiceProviderOpts();
      saveVoiceSettings();
    }

    function renderVoiceProviderOpts() {
      const el = document.getElementById('handsoff-provider-opts');
      if (!el) return;
      const s = handsOffVoiceSettings;
      const speed = s.speed || 100;
      // Speed slider — common to all providers
      const speedHtml = `
        <div style="display:flex;align-items:center;gap:0.4rem;font-size:0.78rem;margin-top:0.3rem">
          <label style="margin:0;white-space:nowrap">Speed</label>
          <input type="range" min="50" max="200" step="10" value="${speed}" style="flex:1;accent-color:var(--accent)" oninput="handsOffVoiceSettings.speed=Number(this.value);document.getElementById('handsoff-speed-val').textContent=this.value+'%';saveVoiceSettings()">
          <span id="handsoff-speed-val" style="min-width:2.5rem;text-align:right">${speed}%</span>
        </div>`;

      let providerHtml = '';
      if (handsOffVoiceProvider === 'openai-realtime') {
        const voice = s.openai?.voice || 'alloy';
        const model = s.openai?.model || 'gpt-realtime';
        providerHtml = `
          <div style="display:grid;grid-template-columns:auto 1fr;gap:0.3rem 0.5rem;align-items:center;font-size:0.78rem;margin:0.3rem 0;padding:0.4rem;background:var(--paper);border-radius:6px;border:1px solid var(--line)">
            <label style="margin:0">Model</label>
            <select style="font-size:0.78rem" onchange="handsOffVoiceSettings.openai={...(handsOffVoiceSettings.openai||{}),model:this.value};saveVoiceSettings()">
              <option value="gpt-realtime"${model === 'gpt-realtime' || model === 'gpt-4o-realtime-preview' ? ' selected' : ''}>GPT Realtime</option>
              <option value="gpt-realtime-mini"${model === 'gpt-realtime-mini' || model === 'gpt-4o-mini-realtime-preview' ? ' selected' : ''}>GPT Realtime Mini (faster)</option>
            </select>
            <label style="margin:0">Voice</label>
            <select style="font-size:0.78rem" onchange="handsOffVoiceSettings.openai={...(handsOffVoiceSettings.openai||{}),voice:this.value};saveVoiceSettings()">
              ${['alloy','ash','ballad','coral','echo','sage','shimmer','verse'].map(v =>
                `<option value="${v}"${v === voice ? ' selected' : ''}>${v}</option>`
              ).join('')}
            </select>
          </div>
          <div style="font-size:0.7rem;color:var(--muted-soft)">Requires OpenAI API key in <a href="#" onclick="if(window.showProfile)showProfile();return false" style="color:var(--accent)">Profile → API Keys</a></div>`;
      } else if (handsOffVoiceProvider === 'gemini-live') {
        const model = s.gemini?.model || 'gemini-2.0-flash-exp';
        providerHtml = `
          <div style="display:grid;grid-template-columns:auto 1fr;gap:0.3rem 0.5rem;align-items:center;font-size:0.78rem;margin:0.3rem 0;padding:0.4rem;background:var(--paper);border-radius:6px;border:1px solid var(--line)">
            <label style="margin:0">Model</label>
            <select style="font-size:0.78rem" onchange="handsOffVoiceSettings.gemini={...(handsOffVoiceSettings.gemini||{}),model:this.value};saveVoiceSettings()">
              <option value="gemini-2.0-flash-exp"${model === 'gemini-2.0-flash-exp' ? ' selected' : ''}>Gemini 2.0 Flash</option>
            </select>
          </div>
          <div style="font-size:0.7rem;color:var(--muted-soft)">Requires Google AI API key in <a href="#" onclick="if(window.showProfile)showProfile();return false" style="color:var(--accent)">Profile → API Keys</a></div>`;
      } else {
        providerHtml = `<div style="font-size:0.7rem;color:var(--muted-soft);margin:0.2rem 0">Free browser speech — no API key needed. Quality varies by browser.</div>`;
      }
      el.innerHTML = providerHtml + speedHtml;
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
    async function startHandsOff() {
      if (!handsOffEligibleRepos().length) { alert('Start a coding session on at least one repo first.'); return; }

      // For realtime providers, fetch the API key first
      if (handsOffVoiceProvider !== 'browser') {
        const keyProvider = handsOffVoiceProvider === 'openai-realtime' ? 'openai' : 'google';
        const providerLabel = keyProvider === 'openai' ? 'OpenAI' : 'Google AI';
        try {
          const keyRes = await api(`/v1/keys/${keyProvider}/reveal`);
          if (!keyRes.key) { alert(`No ${providerLabel} API key found. Add one in Profile → API Keys.`); return; }
          handsOffApiKey = keyRes.key;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('404')) {
            alert(`No ${providerLabel} API key stored. Add one in Profile → API Keys first.`);
          } else {
            alert(`Could not retrieve ${providerLabel} key: ${msg}`);
          }
          return;
        }
      }

      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (handsOffVoiceProvider === 'browser' && !SR) { alert('Browser speech isn\'t supported here. Try Chrome, or switch to OpenAI/Gemini voice.'); return; }

      handsOffOn = true; handsOffPaused = false; handsOffFocusIdx = 0;
      document.getElementById('handsoff-start')?.classList.add('hidden');
      document.getElementById('handsoff-pause')?.classList.remove('hidden');
      document.getElementById('handsoff-stop')?.classList.remove('hidden');
      const sel = document.getElementById('handsoff-mode'); if (sel) sel.disabled = true;
      const sc = document.getElementById('handsoff-scope'); if (sc) sc.disabled = true;
      const pv = document.getElementById('handsoff-provider'); if (pv) pv.disabled = true;
      renderCodingRepos();
      const r = handsOffFocusRepo();

      if (handsOffVoiceProvider === 'openai-realtime') {
        const opts = handsOffVoiceSettings.openai || {};
        const systemPrompt = buildHandsOffSystemPrompt();
        handsOffRealtimeEngine = new OpenAIRealtimeVoice(handsOffApiKey, {
          model: opts.model || 'gpt-realtime',
          voice: opts.voice || 'alloy',
          systemPrompt,
          onTranscript: (text, role) => {
            if (role === 'user') onHandsOffRealtimePhrase(text);
          },
          onStatusChange: (status) => handsOffStatus(status),
        });
        await handsOffRealtimeEngine.connect();
      } else if (handsOffVoiceProvider === 'gemini-live') {
        const opts = handsOffVoiceSettings.gemini || {};
        const systemPrompt = buildHandsOffSystemPrompt();
        handsOffRealtimeEngine = new GeminiLiveVoice(handsOffApiKey, {
          model: opts.model || 'gemini-2.0-flash-exp',
          systemPrompt,
          onTranscript: (text, role) => {
            if (role === 'user') onHandsOffRealtimePhrase(text);
          },
          onStatusChange: (status) => handsOffStatus(status),
        });
        await handsOffRealtimeEngine.connect();
      } else {
        speakText(`Hands-off on. Focused on ${r ? r.name : 'your repos'}.`);
        handsOffStatus('listening…');
        handsOffListen();
      }
    }

    let handsOffApiKey = '';

    function buildHandsOffSystemPrompt() {
      const repos = handsOffEligibleRepos();
      const repoList = repos.map(r => r.name).join(', ');
      const speed = handsOffVoiceSettings?.speed || 100;
      const speedNote = speed !== 100 ? ` Speak at ${speed}% speed — ${speed > 100 ? 'faster than normal' : 'slower than normal'}.` : '';
      return `You are the Overseer for a multi-repo coding workspace. The user is in hands-off voice mode — they speak, you respond. Active repos: ${repoList}. Keep responses short and actionable.${speedNote}`;
    }

    // For realtime providers: the LLM IS the voice — phrases from the user
    // are already handled by the realtime model. But we still route commands.
    function onHandsOffRealtimePhrase(text) {
      const lower = text.toLowerCase().trim();
      if (lower === 'stop' || lower === 'stop mode') { stopHandsOff(); return; }
      if (lower === 'next') { handsOffFocusIdx++; const r = handsOffFocusRepo(); if (r && handsOffRealtimeEngine) handsOffRealtimeEngine.sendText(`Now focusing on repo: ${r.name}`); return; }
      if (lower === 'back') { handsOffFocusIdx--; const r = handsOffFocusRepo(); if (r && handsOffRealtimeEngine) handsOffRealtimeEngine.sendText(`Now focusing on repo: ${r.name}`); return; }
      // For smart mode, the realtime LLM already responds — no additional routing needed
    }

    function stopHandsOff() {
      handsOffOn = false; handsOffPaused = false;
      // Stop realtime engine if active
      if (handsOffRealtimeEngine) { handsOffRealtimeEngine.disconnect(); handsOffRealtimeEngine = null; }
      // Stop browser speech
      if (handsOffRec) { try { handsOffRec.stop(); } catch (e) {} handsOffRec = null; }
      if (window.speechSynthesis) speechSynthesis.cancel();
      document.getElementById('handsoff-start')?.classList.remove('hidden');
      document.getElementById('handsoff-pause')?.classList.add('hidden');
      document.getElementById('handsoff-stop')?.classList.add('hidden');
      const pb = document.getElementById('handsoff-pause');
      if (pb) pb.textContent = '⏸ Pause';
      const sel = document.getElementById('handsoff-mode'); if (sel) sel.disabled = false;
      const sc = document.getElementById('handsoff-scope'); if (sc) sc.disabled = false;
      const pv = document.getElementById('handsoff-provider'); if (pv) pv.disabled = false;
      handsOffStatus('');
      renderCodingRepos();
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
