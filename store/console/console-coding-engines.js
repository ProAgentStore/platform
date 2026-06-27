    // ── CLI engine presets (which command launches each engine) ──────────────
    // The engine editor dialog, engine chooser before session start, and the
    // start-session API call. Each engine is { id, label, command }.

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
        <button type="button" class="btn btn-outline btn-sm" onclick="this.closest('.engine-row').remove()" title="Remove" style="padding:0.2rem 0.45rem">&times;</button>
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
        openCodingTerminal(res.session.id);
      } catch (e) { alert('Start session failed: ' + e.message); }
    }
