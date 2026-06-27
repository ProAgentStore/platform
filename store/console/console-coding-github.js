    // ── GitHub repo import (org → repo selector) ───────────────────────────
    // Two-step picker: choose an org/account, then pick a repo from it. Falls
    // back to a flat list when only one installation. Requires the GitHub App.

    async function checkGitHubApp() {
      const btn = document.getElementById('inst-coding-gh-btn');
      if (!btn) return;
      try {
        const s = await api('/v1/github/status');
        btn.classList.toggle('hidden', !s.configured);
      } catch (e) { btn.classList.add('hidden'); }
    }

    async function importFromGitHub() {
      let bg = document.getElementById('gh-import-dialog');
      if (bg) { bg.remove(); return; }
      bg = document.createElement('div');
      bg.id = 'gh-import-dialog';
      bg.className = 'coding-dialog-backdrop';
      bg.innerHTML = `<div class="coding-dialog" style="max-width:520px">
        <div class="coding-dialog-title">Import from GitHub<button onclick="document.getElementById('gh-import-dialog').remove()" aria-label="Close">&times;</button></div>
        <div id="gh-import-body" style="padding:0 0.55rem 0.5rem"><div style="color:var(--muted);font-size:0.82rem;padding:1rem 0;text-align:center">Loading…</div></div>
      </div>`;
      bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
      document.body.appendChild(bg);
      await loadGitHubInstallations();
    }

    async function loadGitHubInstallations() {
      const body = document.getElementById('gh-import-body');
      if (!body) return;
      try {
        const { installations } = await api('/v1/github/installations');
        if (!installations || !installations.length) {
          const url = (await api('/v1/github/install-url')).installUrl;
          body.innerHTML = `<div style="text-align:center;padding:1rem 0">
            <p style="font-size:0.82rem;color:var(--muted);margin:0 0 0.6rem">No GitHub App installed yet.</p>
            <a href="${esc(url)}" target="_blank" class="btn btn-primary btn-sm">Install the GitHub App &rarr;</a>
            <p style="font-size:0.72rem;color:var(--muted-soft);margin:0.5rem 0 0">After installing, come back and reopen this dialog.</p>
          </div>`;
          return;
        }
        if (installations.length === 1) {
          // Single org — skip the org picker, go straight to repos.
          await loadGitHubRepos(body, installations[0]);
        } else {
          // Multiple orgs — show the org picker first.
          body.innerHTML = `<div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.5rem">Select an organization or account:</div>
            <div style="display:flex;flex-direction:column;gap:2px">
              ${installations.map(i => `<button class="coding-action" onclick="loadGitHubRepos(document.getElementById('gh-import-body'), ${esc(JSON.stringify(i))})">
                <span style="display:flex;align-items:center;gap:0.4rem">
                  <span style="font-size:1.1rem">${i.type === 'Organization' ? '🏢' : '👤'}</span>
                  ${esc(i.account)}
                </span>
                <small>${esc(i.type)}</small>
              </button>`).join('')}
            </div>`;
        }
      } catch (e) {
        body.innerHTML = `<div style="color:var(--red);font-size:0.82rem;padding:0.5rem">${esc(e.message)}</div>`;
      }
    }

    async function loadGitHubRepos(body, installation) {
      if (!body) return;
      body.innerHTML = `<div style="color:var(--muted);font-size:0.82rem;padding:0.5rem 0;text-align:center">Loading repos for ${esc(installation.account)}…</div>`;
      try {
        const { repos } = await api(`/v1/github/installations/${installation.id}/repos`);
        if (!repos || !repos.length) {
          body.innerHTML = `<div style="font-size:0.82rem;color:var(--muted);padding:0.5rem 0;text-align:center">No repos accessible for ${esc(installation.account)}.</div>`;
          return;
        }
        // Search/filter + scrollable list
        body.innerHTML = `<div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.4rem">
            <button class="btn btn-outline btn-sm" onclick="loadGitHubInstallations()" title="Back to orgs" style="padding:0.25rem 0.5rem">&larr;</button>
            <span style="font-size:0.82rem;font-weight:600">${esc(installation.account)}</span>
            <span style="font-size:0.72rem;color:var(--muted)">${repos.length} repo${repos.length === 1 ? '' : 's'}</span>
          </div>
          <input id="gh-repo-filter" placeholder="Filter repos…" oninput="filterGitHubRepos()" style="font-size:0.82rem;margin-bottom:0.4rem;width:100%">
          <div id="gh-repo-list" style="max-height:45vh;overflow-y:auto;display:flex;flex-direction:column;gap:2px"></div>`;
        window._ghRepos = repos;
        filterGitHubRepos();
      } catch (e) {
        body.innerHTML = `<div style="color:var(--red);font-size:0.82rem;padding:0.5rem">${esc(e.message)}</div>`;
      }
    }

    function filterGitHubRepos() {
      const input = document.getElementById('gh-repo-filter');
      const list = document.getElementById('gh-repo-list');
      if (!list || !window._ghRepos) return;
      const q = (input?.value || '').toLowerCase().trim();
      const filtered = q ? window._ghRepos.filter(r => r.fullName.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q)) : window._ghRepos;
      if (!filtered.length) {
        list.innerHTML = `<div style="font-size:0.78rem;color:var(--muted);padding:0.5rem 0;text-align:center">No matches.</div>`;
        return;
      }
      list.innerHTML = filtered.slice(0, 100).map(r =>
        `<button class="coding-action" onclick='selectGitHubRepo(${esc(JSON.stringify({ fullName: r.fullName, cloneUrl: r.cloneUrl, branch: r.defaultBranch, description: r.description }))})' style="padding:0.4rem 0.55rem">
          <span style="display:flex;align-items:center;gap:0.35rem">
            <b>${esc(r.name)}</b>
            ${r.private ? '<span style="font-size:0.68rem;background:var(--line);padding:0.05rem 0.3rem;border-radius:4px">private</span>' : ''}
          </span>
          ${r.description ? `<small style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block">${esc(r.description)}</small>` : ''}
        </button>`).join('');
    }

    async function selectGitHubRepo(json) {
      const r = typeof json === 'string' ? JSON.parse(json) : json;
      if (!currentInstance) return;
      const dialog = document.getElementById('gh-import-dialog');
      const body = document.getElementById('gh-import-body');
      if (body) body.innerHTML = `<div style="color:var(--muted);font-size:0.82rem;padding:0.5rem 0;text-align:center">Importing ${esc(r.fullName)}…</div>`;
      try {
        await api(`/v1/instances/${currentInstance.id}/coding/repos`, {
          method: 'POST', body: JSON.stringify({ name: r.fullName.split('/').pop(), githubRepo: r.fullName, cloneUrl: r.cloneUrl, branch: r.branch || r.defaultBranch }),
        });
        if (dialog) dialog.remove();
        delete window._ghRepos;
        await loadCoding();
      } catch (e) {
        if (body) body.innerHTML = `<div style="color:var(--red);font-size:0.82rem;padding:0.5rem">Import failed: ${esc(e.message)}</div>`;
      }
    }
