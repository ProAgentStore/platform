
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
