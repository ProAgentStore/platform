    // ── Full-transparency diagnostics (System status dialog) ───────────────
    // Everything the user needs to self-diagnose: runner, tmux, sessions, repos,
    // GitHub App, auto-detected issues with suggested fixes. Opened by the 🩺 button.

    function toggleDiagPanel() {
      let bg = document.getElementById('diag-dialog');
      if (bg) { bg.remove(); return; }
      bg = document.createElement('div');
      bg.id = 'diag-dialog';
      bg.className = 'coding-dialog-backdrop';
      bg.innerHTML = `<div class="coding-dialog" style="max-width:600px">
        <div class="coding-dialog-title">System status<button onclick="document.getElementById('diag-dialog').remove()" aria-label="Close">&times;</button></div>
        <div id="diag-body" style="padding:0 0.55rem 0.5rem"><div style="color:var(--muted);font-size:0.82rem;padding:1rem 0;text-align:center">Loading diagnostics…</div></div>
      </div>`;
      bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
      document.body.appendChild(bg);
      loadFullDiag();
    }

    async function loadFullDiag() {
      const el = document.getElementById('diag-body');
      if (!el || !currentInstance) return;
      let diag;
      try {
        diag = await api(`/v1/instances/${currentInstance.id}/coding/diagnostics`);
      } catch (e) {
        el.innerHTML = `<div style="color:var(--red);font-size:0.82rem;padding:0.5rem">Failed to load diagnostics: ${esc(e.message)}</div>`;
        return;
      }
      renderFullDiag(el, diag);
    }

    function renderFullDiag(el, d) {
      const s = d.summary;
      const pill = (ok, label) => `<span style="display:inline-flex;align-items:center;gap:0.25rem;background:${ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'};color:${ok ? 'var(--green)' : 'var(--red)'};padding:0.15rem 0.5rem;border-radius:99px;font-size:0.72rem;font-weight:600">${ok ? '●' : '○'} ${label}</span>`;

      // ── Summary bar ──
      let html = `<div style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.6rem">
        ${pill(s.runnerOnline, 'Runner ' + (s.runnerStatus || 'unknown'))}
        ${s.relayConnected !== undefined ? pill(s.relayConnected, 'Relay ' + (s.relayConnected ? 'connected' : 'off')) : ''}
        ${pill(s.healthySessions > 0, s.healthySessions + '/' + s.activeSessions + ' sessions live')}
        ${pill(s.issueCount === 0, s.issueCount + ' issue' + (s.issueCount === 1 ? '' : 's'))}
      </div>`;

      // ── Issues ──
      if (d.issues.length) {
        html += `<div style="margin-bottom:0.6rem">`;
        d.issues.forEach(i => {
          const bg = i.severity === 'error' ? 'rgba(239,68,68,0.1)' : i.severity === 'warn' ? 'rgba(245,158,11,0.1)' : 'rgba(59,130,246,0.08)';
          const color = i.severity === 'error' ? 'var(--red)' : i.severity === 'warn' ? 'var(--amber,#f59e0b)' : 'var(--muted)';
          const icon = i.severity === 'error' ? '✗' : i.severity === 'warn' ? '⚠' : 'ℹ';
          html += `<div style="background:${bg};border-radius:6px;padding:0.35rem 0.5rem;margin-bottom:0.3rem;font-size:0.78rem">
            <span style="color:${color};font-weight:700">${icon}</span> ${esc(i.message)}
            ${i.fix ? `<div style="font-size:0.7rem;color:var(--muted);margin-top:0.15rem">&rarr; ${esc(i.fix)}</div>` : ''}
          </div>`;
        });
        html += `</div>`;
      }

      // ── Runner ──
      const r = d.runner;
      html += `<details open style="margin-bottom:0.5rem"><summary style="font-size:0.82rem;font-weight:700;cursor:pointer;margin-bottom:0.3rem">Runner</summary>
        <div class="diag-grid">
          <span>Status</span><span style="color:${r.reachable ? 'var(--green)' : 'var(--red)'};font-weight:600">${esc(String(r.status))}${r.reachable ? ' (reachable)' : ' (unreachable)'}</span>
          <span>Node</span><span style="font-weight:600">${r.runnerNode ? esc(r.runnerNode) : '<span style="color:var(--muted)">unknown</span>'}</span>
          <span>Endpoint</span><span style="word-break:break-all">${r.endpointUrl ? esc(r.endpointUrl) : '<span style="color:var(--muted)">none</span>'}</span>
          <span>Placement</span><span>${esc(r.placement || 'unregistered')}</span>
          <span>Version</span><span>${esc(r.runnerVersion || '—')}</span>
          <span>Last seen</span><span>${r.lastSeenAt ? esc(r.lastSeenAt) : '<span style="color:var(--muted)">never</span>'}</span>
          <span>Capabilities</span><span style="font-size:0.7rem">${(r.capabilities || []).map(c => `<code>${esc(c)}</code>`).join(' ')}</span>
        </div>
      </details>`;

      // ── Tmux ──
      if (d.tmux) {
        const t = d.tmux;
        html += `<details open style="margin-bottom:0.5rem"><summary style="font-size:0.82rem;font-weight:700;cursor:pointer;margin-bottom:0.3rem">tmux on ${r.runnerNode ? esc(r.runnerNode) : 'runner'}</summary>
          <div class="diag-grid">
            <span>Total sessions</span><span>${t.tmuxTotal} (${t.pagsTmuxTotal} pags-*)</span>
            <span>Tracked by runner</span><span>${t.trackedSessions}</span>
            <span>Orphaned</span><span style="color:${t.orphanedSessions.length ? 'var(--amber,#f59e0b)' : 'var(--green)'}">${t.orphanedSessions.length ? t.orphanedSessions.join(', ') : 'none'}</span>
          </div>
          <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.4rem">
            ${t.orphanedSessions.length ? `<button type="button" class="btn btn-outline btn-sm" onclick="killOrphanedTmux(this)" style="color:var(--amber,#f59e0b)">Kill ${t.orphanedSessions.length} orphaned</button>` : ''}
            ${t.pagsTmuxTotal > 0 ? `<button type="button" class="btn btn-outline btn-sm" onclick="killAllPagsTmux(this)" style="color:var(--red)">Kill all pags tmux</button>` : ''}
          </div>
        </details>`;
      }

      // ── Sessions ──
      html += `<details open style="margin-bottom:0.5rem"><summary style="font-size:0.82rem;font-weight:700;cursor:pointer;margin-bottom:0.3rem">Sessions (${d.sessions.length})</summary>`;
      if (!d.sessions.length) {
        html += '<div style="font-size:0.78rem;color:var(--muted);padding:0.3rem 0">No sessions.</div>';
      } else {
        d.sessions.forEach(sess => {
          const active = sess.status === 'active';
          const live = sess.live;
          let stColor = 'var(--muted)', stLabel = sess.status;
          if (active && live?.alive) { stColor = live.runState === 'idle' ? 'var(--green)' : 'var(--accent,#7c3aed)'; stLabel = live.runState; }
          else if (active && live && !live.alive) { stColor = 'var(--red)'; stLabel = 'dead'; }
          else if (active && !live) { stColor = 'var(--amber,#f59e0b)'; stLabel = 'orphaned'; }
          html += `<div style="border:1px solid var(--line);border-radius:6px;padding:0.4rem 0.5rem;margin-bottom:0.3rem;font-size:0.78rem">
            <div style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap">
              <span style="color:${stColor};font-weight:700">● ${esc(stLabel)}</span>
              <b>${esc(sess.repoName)}</b>
              <span style="color:var(--muted)">${esc(sess.clientType)} · …${esc((sess.id || '').slice(-6))}</span>
              ${active ? `<span style="display:flex;gap:0.25rem;margin-left:auto">
                <button type="button" class="btn btn-outline btn-sm" onclick="openCodingTerminal('${sess.id}');document.getElementById('diag-dialog')?.remove()">View</button>
                <button type="button" class="btn btn-outline btn-sm" onclick="restartSession('${sess.id}',this)">Restart</button>
                <button type="button" class="btn btn-outline btn-sm" onclick="killSession('${sess.id}',this)" style="color:var(--red)">Kill</button>
              </span>` : ''}
            </div>
            <div class="diag-grid" style="margin-top:0.25rem">
              <span>tmux</span><span style="font-family:monospace;font-size:0.7rem">${esc(sess.tmuxSession || '—')}</span>
              ${sess.launchCommand ? `<span>Command</span><span style="font-family:monospace;font-size:0.7rem">${esc(sess.launchCommand)}</span>` : ''}
              ${live ? `<span>CLI alive</span><span style="color:${live.alive ? 'var(--green)' : 'var(--red)'}">${live.alive ? 'yes' : 'no'}</span>
              <span>Pane</span><span>${live.paneLines} lines</span>
              ${live.underTakeover ? '<span>Takeover</span><span style="color:var(--amber,#f59e0b)">active (human needed)</span>' : ''}
              <span>Work dir</span><span style="font-family:monospace;font-size:0.7rem;word-break:break-all">${esc(live.workDir || '—')}</span>` : ''}
              ${sess.issue ? `<span>Issue</span><span style="color:var(--amber,#f59e0b)">${esc(sess.issue)}</span>` : ''}
              <span>Started</span><span>${esc(sess.startedAt || '—')}</span>
              ${sess.endedAt ? `<span>Ended</span><span>${esc(sess.endedAt)}</span>` : ''}
            </div>
          </div>`;
        });
      }
      html += `</details>`;

      // ── Repos ──
      html += `<details style="margin-bottom:0.5rem"><summary style="font-size:0.82rem;font-weight:700;cursor:pointer;margin-bottom:0.3rem">Repos (${d.repos.length})</summary>`;
      d.repos.forEach(repo => {
        const cloneColor = repo.cloneStatus === 'ready' ? 'var(--green)' : repo.cloneStatus === 'error' ? 'var(--red)' : 'var(--muted)';
        html += `<div style="border:1px solid var(--line);border-radius:6px;padding:0.4rem 0.5rem;margin-bottom:0.3rem;font-size:0.78rem">
          <div style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap">
            <span style="color:${cloneColor};font-weight:700">● ${esc(repo.cloneStatus)}</span>
            <b>${esc(repo.name)}</b>
            <span style="color:var(--muted)">${repo.activeSessions} active session${repo.activeSessions === 1 ? '' : 's'}</span>
          </div>
          <div class="diag-grid" style="margin-top:0.25rem">
            ${repo.githubRepo ? `<span>GitHub</span><span>${esc(repo.githubRepo)}</span>` : ''}
            ${repo.cloneUrl ? `<span>Clone URL</span><span style="font-size:0.7rem;word-break:break-all">${esc(repo.cloneUrl)}</span>` : ''}
            ${repo.workdir ? `<span>Local path</span><span style="font-family:monospace;font-size:0.7rem;word-break:break-all">${esc(repo.workdir)}</span>` : ''}
            ${repo.branch ? `<span>Branch</span><span>${esc(repo.branch)}</span>` : ''}
            <span>Engine</span><span>${esc(repo.defaultClient)}</span>
            ${repo.cloneError ? `<span>Error</span><span style="color:var(--red);word-break:break-all">${esc(repo.cloneError)}</span>` : ''}
          </div>
        </div>`;
      });
      html += `</details>`;

      // ── Browse files ──
      if (r.reachable) {
        html += `<details style="margin-bottom:0.5rem"><summary style="font-size:0.82rem;font-weight:700;cursor:pointer;margin-bottom:0.3rem">Browse files on ${r.runnerNode ? esc(r.runnerNode) : 'runner'}</summary>
          <div id="diag-browse-body" style="font-size:0.78rem;max-height:250px;overflow-y:auto;border:1px solid var(--line);border-radius:6px;padding:0.4rem 0.5rem">
            <div style="color:var(--muted)">Click to browse…</div>
          </div>
          <div style="margin-top:0.3rem"><button type="button" class="btn btn-outline btn-sm" onclick="browseDiagDir('~')">Browse home</button></div>
        </details>`;
      }

      // ── GitHub App ──
      html += `<details style="margin-bottom:0.3rem"><summary style="font-size:0.82rem;font-weight:700;cursor:pointer;margin-bottom:0.3rem">GitHub App</summary>
        <div class="diag-grid">
          <span>Configured</span><span style="color:${d.githubApp.configured ? 'var(--green)' : 'var(--muted)'}">${d.githubApp.configured ? 'yes (private repo import available)' : 'no (public repos only)'}</span>
        </div>
      </details>`;

      // ── Refresh + Copy ──
      html += `<div style="display:flex;justify-content:flex-end;gap:0.4rem;margin-top:0.3rem">
        <button type="button" class="btn btn-outline btn-sm" id="diag-copy-btn" onclick="copyDiagJson(this)">Copy JSON</button>
        <button type="button" class="btn btn-outline btn-sm" onclick="loadFullDiag()">↻ Refresh</button>
      </div>`;

      el.innerHTML = html;
      // Stash the raw JSON so Copy can grab it
      el.dataset.diagJson = JSON.stringify(d, null, 2);
    }

    async function restartSession(sessionId, btn) {
      if (!currentInstance) return;
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/coding/sessions/${sessionId}/restart`, { method: 'POST', body: '{}' });
        if (d && d.runnerConnected === false) alert('No runner connected — run `pags up`.');
      } catch (e) { alert('Restart failed: ' + e.message); }
      await loadFullDiag();
    }

    async function killSession(sessionId, btn) {
      if (!currentInstance || !confirm('Kill this session and stop its CLI?')) return;
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/sessions/${sessionId}/end`, { method: 'POST', body: '{}' });
      } catch (e) { alert('Kill failed: ' + e.message); }
      await loadCoding();
      loadFullDiag();
    }

    async function killOrphanedTmux(btn) {
      if (!currentInstance || !confirm('Kill all orphaned pags-* tmux sessions on the runner machine?')) return;
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        const r = await api(`/v1/instances/${currentInstance.id}/coding/kill-tmux`, { method: 'POST', body: JSON.stringify({ orphansOnly: true }) });
        alert(`Killed ${r.killed || 0} orphaned tmux session(s).`);
      } catch (e) { alert('Kill failed: ' + e.message); }
      loadFullDiag();
    }

    async function killAllPagsTmux(btn) {
      if (!currentInstance || !confirm('Kill ALL pags-* tmux sessions on the runner machine? This stops every coding session.')) return;
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      try {
        const r = await api(`/v1/instances/${currentInstance.id}/coding/kill-tmux`, { method: 'POST', body: JSON.stringify({}) });
        alert(`Killed ${r.killed || 0} tmux session(s).`);
      } catch (e) { alert('Kill failed: ' + e.message); }
      await loadCoding();
      loadFullDiag();
    }

    async function copyDiagJson(btn) {
      const el = document.getElementById('diag-body');
      const json = el?.dataset?.diagJson;
      if (!json) { alert('No diagnostics data — refresh first.'); return; }
      try {
        await navigator.clipboard.writeText(json);
        if (btn) { const o = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = o; }, 1500); }
      } catch (e) { alert('Copy failed: ' + e.message); }
    }

    async function browseDiagDir(dir) {
      if (!currentInstance) return;
      const el = document.getElementById('diag-browse-body');
      if (!el) return;
      el.innerHTML = '<div style="color:var(--muted);font-size:0.78rem;padding:0.3rem 0">Loading…</div>';
      try {
        const r = await api(`/v1/instances/${currentInstance.id}/coding/browse?dir=${encodeURIComponent(dir || '~')}`);
        let html = `<div style="font-family:monospace;font-size:0.72rem;color:var(--muted);margin-bottom:0.3rem;word-break:break-all">${esc(r.dir)}</div>`;
        if (r.dir !== '/') {
          const parent = r.dir.replace(/\/[^/]+$/, '') || '/';
          html += `<div style="cursor:pointer;padding:0.15rem 0" onclick="browseDiagDir('${esc(parent)}')">&larr; ..</div>`;
        }
        for (const e of (r.entries || [])) {
          if (e.type === 'dir') {
            html += `<div style="cursor:pointer;padding:0.15rem 0" onclick="browseDiagDir('${esc(r.dir + '/' + e.name)}')">📁 ${esc(e.name)}/</div>`;
          } else {
            const size = typeof e.size === 'number' ? ` <span style="color:var(--muted)">(${(e.size / 1024).toFixed(1)}K)</span>` : '';
            html += `<div style="padding:0.15rem 0">📄 ${esc(e.name)}${size}</div>`;
          }
        }
        el.innerHTML = html;
      } catch (e) {
        el.innerHTML = `<div style="color:var(--red);font-size:0.78rem">${esc(e.message)}</div>`;
      }
    }
