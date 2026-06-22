// biome-ignore-all lint/correctness/noUnusedVariables: Console functions are called from inline HTML handlers.
// ── Analytics ────────────────────────────────────────────────

    async function loadAnalytics() {
      document.getElementById('analytics-loading').style.display = '';
      document.getElementById('analytics-content').style.display = 'none';
      try {
        const data = await api(`/v1/agents/${currentAgent.id}/analytics`);
        document.getElementById('stat-subs').textContent = String(data.subscribers || 0);
        document.getElementById('stat-chats').textContent = String(data.totalChats || 0);
        document.getElementById('stat-execs').textContent = String(data.totalExecutions || 0);

        // Daily usage chart (simple bar chart)
        const chart = document.getElementById('daily-chart');
        chart.innerHTML = '';
        const daily = data.dailyUsage || [];
        const maxCount = Math.max(1, ...daily.map(d => d.count));
        for (const d of daily) {
          const bar = document.createElement('div');
          const pct = Math.max(4, (d.count / maxCount) * 100);
          bar.style.cssText = `flex:1;min-width:4px;background:var(--accent);border-radius:2px 2px 0 0;height:${pct}%`;
          bar.title = `${d.day}: ${d.count} events`;
          chart.appendChild(bar);
        }
        if (!daily.length) chart.innerHTML = '<span style="color:var(--muted-soft);font-size:0.82rem">No usage data yet</span>';

        // Funnel
        const funnel = document.getElementById('funnel');
        funnel.innerHTML = '';
        const f = data.funnel || { views: 0, trials: 0, subscribes: 0 };
        const maxF = Math.max(1, f.views, f.trials, f.subscribes);
        for (const [label, count, color] of [['Views', f.views, '#3b82f6'], ['Trials', f.trials, '#eab308'], ['Subscribes', f.subscribes, '#22c55e']]) {
          const col = document.createElement('div');
          col.style.cssText = 'flex:1;text-align:center';
          const h = Math.max(8, (count / maxF) * 80);
          col.innerHTML = `<div style="height:${h}px;background:${color};border-radius:4px 4px 0 0;margin:0 auto;width:60%"></div>
            <div style="font-size:1.1rem;font-weight:700;margin-top:0.3rem">${count}</div>
            <div style="font-size:0.72rem;color:var(--muted)">${label}</div>`;
          funnel.appendChild(col);
        }

        // Recent executions
        const execs = document.getElementById('recent-execs');
        execs.innerHTML = '';
        for (const e of (data.recentExecutions || [])) {
          execs.innerHTML += `<div style="display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid var(--line);font-size:0.82rem">
            <span style="color:var(--muted)">${esc(e.model)}</span>
            <span>${e.duration_ms}ms</span>
            <span style="color:var(--muted-soft)">${new Date(e.created_at).toLocaleString()}</span>
          </div>`;
        }
        if (!(data.recentExecutions || []).length) execs.innerHTML = '<span style="color:var(--muted-soft);font-size:0.82rem">No executions yet</span>';

        document.getElementById('analytics-loading').style.display = 'none';
        document.getElementById('analytics-content').style.display = '';
      } catch (e) {
        document.getElementById('analytics-loading').textContent = 'Failed to load analytics';
      }
    }

    // ── Knowledge Base ─────────────────────────────────────────

    function showKbForm(type) {
      hideKbForms();
      document.getElementById(`kb-form-${type}`).classList.remove('hidden');
    }
    function hideKbForms() {
      document.getElementById('kb-form-paste').classList.add('hidden');
      document.getElementById('kb-form-url').classList.add('hidden');
      document.getElementById('kb-form-gdoc').classList.add('hidden');
    }

    async function importGoogleDoc() {
      const url = document.getElementById('kb-gdoc-url').value.trim();
      if (!url) { alert('Google Docs URL required'); return; }
      const statusEl = document.getElementById('kb-gdoc-status');
      statusEl.textContent = 'Importing...';
      statusEl.classList.remove('hidden');
      statusEl.style.color = 'var(--muted)';
      try {
        await api(`/v1/public/agents/${currentAgent.id}/import-gdoc`, {
          method: 'POST',
          body: JSON.stringify({ docUrl: url }),
        });
        hideKbForms();
        statusEl.classList.add('hidden');
        document.getElementById('kb-gdoc-url').value = '';
        loadKnowledge();
      } catch (e) {
        statusEl.textContent = e.message;
        statusEl.style.color = '';
      }
    }

    async function loadKnowledge() {
      try {
        const data = await api(`/v1/agents/${currentAgent.id}/knowledge`);
        const list = document.getElementById('kb-list');
        const empty = document.getElementById('kb-empty');
        list.innerHTML = '';
        const docs = data.documents || [];
        empty.classList.toggle('hidden', docs.length > 0);
        if (!docs.length) return;
        for (const doc of docs) {
          const item = document.createElement('div');
          item.className = 'memory-item';
          const preview = doc.content.length > 120 ? `${doc.content.slice(0, 120)}...` : doc.content;
          item.innerHTML = `<div style="flex:1;min-width:0">
            <span class="key">${esc(doc.title)}</span>
            <span class="type">${esc(doc.source)}</span>
            ${doc.sourceUrl ? `<span class="type" style="margin-left:0.25rem">${esc(doc.sourceUrl)}</span>` : ''}
            <div class="content">${esc(preview)}</div>
            <div style="font-size:0.7rem;color:var(--muted-soft);margin-top:0.2rem">${Math.round(doc.content.length / 1024)}KB</div>
          </div>`;
          const btn = document.createElement('button');
          btn.className = 'btn btn-outline btn-sm';
          btn.style.flexShrink = '0';
          btn.textContent = '\u00d7';
          btn.addEventListener('click', () => deleteKbDoc(doc.id));
          item.appendChild(btn);
          list.appendChild(item);
        }
      } catch {}
    }

    async function addKbPaste() {
      const title = document.getElementById('kb-title').value.trim();
      const content = document.getElementById('kb-content').value.trim();
      if (!title || !content) { alert('Title and content required'); return; }
      try {
        await api(`/v1/agents/${currentAgent.id}/knowledge`, {
          method: 'POST',
          body: JSON.stringify({ title, content, source: 'paste' }),
        });
        hideKbForms();
        document.getElementById('kb-title').value = '';
        document.getElementById('kb-content').value = '';
        loadKnowledge();
      } catch (e) { alert(e.message); }
    }

    async function addKbUrl() {
      const url = document.getElementById('kb-url').value.trim();
      if (!url) { alert('URL required'); return; }
      const title = document.getElementById('kb-url-title').value.trim();
      const statusEl = document.getElementById('kb-url-status');
      statusEl.textContent = 'Importing...';
      statusEl.classList.remove('hidden');
      statusEl.style.color = 'var(--muted)';
      try {
        await api(`/v1/agents/${currentAgent.id}/knowledge/ingest-url`, {
          method: 'POST',
          body: JSON.stringify({ url, title: title || undefined }),
        });
        hideKbForms();
        statusEl.classList.add('hidden');
        document.getElementById('kb-url').value = '';
        document.getElementById('kb-url-title').value = '';
        loadKnowledge();
      } catch (e) {
        statusEl.textContent = e.message;
        statusEl.style.color = '';
      }
    }

    async function uploadKbFile(input) {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        await api(`/v1/agents/${currentAgent.id}/knowledge`, {
          method: 'POST',
          body: JSON.stringify({ title: file.name, content: text, source: 'upload' }),
        });
        loadKnowledge();
      } catch (e) { alert(e.message); }
      input.value = '';
    }

    async function deleteKbDoc(id) {
      if (!confirm('Delete this document?')) return;
      try {
        await api(`/v1/agents/${currentAgent.id}/knowledge/${id}`, { method: 'DELETE' });
        loadKnowledge();
      } catch {}
    }

    // ── Memory ──────────────────────────────────────────────────

    async function loadMemory() {
      try {
        const data = await api(`/v1/agents/${currentAgent.id}/memory`);
        const list = document.getElementById('memory-list');
        const empty = document.getElementById('memory-empty');
        list.innerHTML = '';
        const entries = data.memory || [];
        empty.classList.toggle('hidden', entries.length > 0);
        if (!entries.length) return;
        for (const m of entries) {
          const item = document.createElement('div');
          item.className = 'memory-item';
          item.innerHTML = `<div><span class="key">${esc(m.key)}</span> <span class="type">${esc(m.type)}</span>
            <div class="content">${esc(m.content)}</div>
          </div>`;
          const btn = document.createElement('button');
          btn.className = 'btn btn-outline btn-sm';
          btn.style.flexShrink = '0';
          btn.textContent = '\u00d7';
          btn.addEventListener('click', () => deleteMemory(m.key));
          item.appendChild(btn);
          list.appendChild(item);
        }
      } catch {}
    }

    function showMemoryForm() { document.getElementById('memory-form').classList.remove('hidden'); }

    async function saveMemory() {
      try {
        await api(`/v1/agents/${currentAgent.id}/memory`, {
          method: 'PUT',
          body: JSON.stringify({
            key: document.getElementById('m-key').value,
            type: document.getElementById('m-type').value,
            content: document.getElementById('m-content').value,
          }),
        });
        document.getElementById('memory-form').classList.add('hidden');
        ['m-key','m-content'].forEach(id => {
          document.getElementById(id).value = '';
        });
        loadMemory();
      } catch (e) { alert(e.message); }
    }

    async function deleteMemory(key) {
      if (!confirm(`Delete memory "${key}"?`)) return;
      try {
        await fetch(`${API}/v1/agents/${currentAgent.id}/memory/${encodeURIComponent(key)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
        });
        loadMemory();
      } catch {}
    }

    // ── Tasks ───────────────────────────────────────────────────

    async function loadTasks() {
      try {
        const data = await api(`/v1/agents/${currentAgent.id}/tasks`);
        const list = document.getElementById('task-list');
        const empty = document.getElementById('task-empty');
        list.innerHTML = '';
        const items = data.tasks || [];
        empty.classList.toggle('hidden', items.length > 0);
        if (!items.length) return;
        for (const t of items) {
          list.innerHTML += `<div class="task-item">
            <div>
              <span class="title">${esc(t.title)}</span>
              <span class="status-badge status-${t.status}">${t.status.replace('_',' ')}</span>
              ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ''}
            </div>
          </div>`;
        }
      } catch {}
    }

    function showTaskForm() { document.getElementById('task-form').classList.remove('hidden'); }

    async function createTask() {
      try {
        await api(`/v1/agents/${currentAgent.id}/tasks`, {
          method: 'POST',
          body: JSON.stringify({
            title: document.getElementById('t-title').value,
            description: document.getElementById('t-desc').value,
          }),
        });
        document.getElementById('task-form').classList.add('hidden');
        ['t-title','t-desc'].forEach(id => {
          document.getElementById(id).value = '';
        });
        loadTasks();
      } catch (e) { alert(e.message); }
    }

    // ── Settings ────────────────────────────────────────────────

    async function saveSettings() {
      try {
        // Save D1 fields (agent registry)
        await api(`/v1/agents/${currentAgent.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: document.getElementById('s-name').value,
            description: document.getElementById('s-desc').value,
            category: document.getElementById('s-category').value,
            visibility: document.getElementById('s-visibility').value,
            model: document.getElementById('s-model').value,
          }),
        });

        // Save DO state (identity + guardrails)
        const blockedRaw = document.getElementById('s-blocked').value;
        const blockedTerms = blockedRaw ? blockedRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
        await api(`/v1/agents/${currentAgent.id}/state`, {
          method: 'PUT',
          body: JSON.stringify({
            name: document.getElementById('s-name').value,
            personality: document.getElementById('s-personality').value,
            goal: document.getElementById('s-goal').value,
            model: document.getElementById('s-model').value,
            welcomeMessage: document.getElementById('s-welcome').value,
            guardrails: {
              topicRestrictions: document.getElementById('s-topics').value,
              blockedTerms,
              responseStyle: document.getElementById('s-style').value,
              maxResponseLength: parseInt(document.getElementById('s-maxlen').value, 10) || 0,
              requireCitations: document.getElementById('s-citations').checked,
            },
          }),
        });

        alert('Saved!');
        openAgent(currentAgent.id);
      } catch (e) { alert(e.message); }
    }

    async function exportAgent() {
      try {
        const data = await api(`/v1/agents/${currentAgent.id}/export`);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${currentAgent.slug || 'agent'}-backup.json`;
        a.click(); URL.revokeObjectURL(url);
      } catch (e) { alert(e.message); }
    }

    async function importAgent(input) {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const backup = JSON.parse(text);
        if (!confirm(`Import backup? This will overwrite current agent state, knowledge (${(backup.knowledge || []).length} docs), and memory (${(backup.memory || []).length} entries).`)) return;
        const res = await api(`/v1/agents/${currentAgent.id}/import`, { method: 'POST', body: text });
        alert(`Imported! State: ${res.restored?.state ? 'yes' : 'no'}, KB: ${res.restored?.knowledge || 0}, Memory: ${res.restored?.memory || 0}`);
        openAgent(currentAgent.id);
      } catch (e) { alert(e.message); }
      input.value = '';
    }

    async function saveVersion() {
      const desc = prompt('Version description (optional):') || '';
      try {
        const res = await api(`/v1/agents/${currentAgent.id}/versions`, { method: 'POST', body: JSON.stringify({ description: desc }) });
        alert(`Saved version ${res.version}`);
        loadVersions();
      } catch (e) { alert(e.message); }
    }

    async function loadVersions() {
      try {
        const data = await api(`/v1/agents/${currentAgent.id}/versions`);
        const list = document.getElementById('version-list');
        const empty = document.getElementById('version-empty');
        list.innerHTML = '';
        const versions = data.versions || [];
        empty.classList.toggle('hidden', versions.length > 0);
        for (const v of versions) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0.75rem;background:var(--paper);border:1px solid var(--line);border-radius:0.4rem';
          row.innerHTML = `<div>
            <span style="font-weight:600;font-size:0.85rem">v${v.version_num}</span>
            <span style="font-size:0.82rem;color:var(--muted);margin-left:0.5rem">${esc(v.description)}</span>
            <span style="font-size:0.7rem;color:var(--muted-soft);margin-left:0.5rem">${new Date(v.created_at).toLocaleString()}</span>
          </div>`;
          const btn = document.createElement('button');
          btn.className = 'btn btn-outline btn-sm';
          btn.textContent = 'Rollback';
          btn.addEventListener('click', async () => {
            if (!confirm(`Rollback to v${v.version_num}? This overwrites current agent config.`)) return;
            try {
              await api(`/v1/agents/${currentAgent.id}/versions/${v.id}/rollback`, { method: 'POST' });
              alert(`Rolled back to v${v.version_num}`);
              openAgent(currentAgent.id);
            } catch (e) { alert(e.message); }
          });
          row.appendChild(btn);
          list.appendChild(row);
        }
      } catch {}
    }

    async function deleteAgent() {
      if (!confirm(`Delete "${currentAgent.name}"? This cannot be undone.`)) return;
      try {
        await api(`/v1/agents/${currentAgent.id}`, { method: 'DELETE' });
        showDashboard();
      } catch (e) { alert(e.message); }
    }

    // ── Ops ─────────────────────────────────────────────────────

    function opsStatus(text, ok) {
      const color = ok ? 'var(--green)' : 'var(--red)';
      return `<span style="color:${color};font-weight:700">${esc(text)}</span>`;
    }

    function formatTime(value) {
      if (!value) return 'Never';
      try { return new Date(value).toLocaleString(); }
      catch { return value; }
    }

    async function loadOps() {
      if (!currentAgent || !document.getElementById('ops-billing-status')) return;
      const billingStatus = document.getElementById('ops-billing-status');
      const billingDetail = document.getElementById('ops-billing-detail');
      const deployStatus = document.getElementById('ops-deploy-status');
      const deployRuns = document.getElementById('ops-deploy-runs');
      const execs = document.getElementById('ops-execs');
      const verifyBtn = document.getElementById('ops-verify-key');
      try {
        const data = await api(`/v1/agents/${currentAgent.id}/ops`);
        const billing = data.billing || {};
        const agent = data.agent || currentAgent;

        verifyBtn.disabled = !billing.hasCloudflareKey;
        billingStatus.innerHTML = billing.hasCloudflareKey
          ? opsStatus('Ready: user-owned Cloudflare Workers AI', true)
          : opsStatus('Missing: Cloudflare Workers AI key required', false);
        billingDetail.innerHTML = `
          Mode: <strong>${esc(billing.mode || 'user-owned')}</strong><br>
          Model: <strong>${esc(agent.model || '')}</strong><br>
          Key created: ${esc(formatTime(billing.createdAt))}<br>
          Last used: ${esc(formatTime(billing.lastUsedAt))}
        `;

        document.getElementById('ops-mcp-command').textContent =
          'npx mcp-remote https://mcp.proagentstore.online/mcp\n\n# Agent repo: ProAgentStore/' + (data.deploy?.repo || agent.slug || currentAgent.slug);

        const deploy = data.deploy || {};
        if (!deploy.configured) {
          deployStatus.innerHTML = opsStatus(deploy.message || 'Deploy integration is not configured', false);
        } else if (deploy.message) {
          deployStatus.innerHTML = opsStatus(deploy.message, false);
        } else {
          const repoLabel = `${deploy.org || 'ProAgentStore'}/${deploy.repo || agent.slug || currentAgent.slug}`;
          deployStatus.innerHTML = `Repo: <a href="${escAttr(githubRepoUrl(deploy.org || 'ProAgentStore', deploy.repo || agent.slug || currentAgent.slug))}" target="_blank" rel="noreferrer">${esc(repoLabel)}</a>`;
        }

        deployRuns.innerHTML = '';
        const runs = deploy.runs || [];
        if (!runs.length) {
          deployRuns.innerHTML = '<span style="font-size:0.82rem;color:var(--muted-soft)">No deploy runs found.</span>';
        } else {
          for (const run of runs) {
            const state = run.conclusion || run.status || 'queued';
            const ok = state === 'success' || state === 'completed';
            const runUrl = safeExternalUrl(run.url);
            const runLabel = esc(run.name || 'Deploy');
            const runTitle = runUrl
              ? `<a href="${escAttr(runUrl)}" target="_blank" rel="noreferrer">${runLabel}</a>`
              : `<span>${runLabel}</span>`;
            deployRuns.innerHTML += `<div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:center;padding:0.45rem 0;border-top:1px solid var(--line);font-size:0.82rem">
              ${runTitle}
              <span style="color:${ok ? 'var(--green)' : 'var(--muted)'}">${esc(state)}</span>
            </div>`;
          }
        }

        execs.innerHTML = '';
        const executions = data.executions || [];
        if (!executions.length) {
          execs.innerHTML = '<span style="font-size:0.82rem;color:var(--muted-soft)">No executions yet.</span>';
        } else {
          for (const ex of executions) {
            execs.innerHTML += `<div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:center;padding:0.4rem 0;border-top:1px solid var(--line);font-size:0.82rem">
              <span>${esc(ex.model || agent.model || '')}</span>
              <span style="color:${ex.error ? 'var(--red)' : 'var(--muted)'}">${ex.error ? esc(ex.error) : `${Number(ex.duration_ms || 0)}ms`}</span>
            </div>`;
          }
        }

        checkOpsHealth(agent);
      } catch (e) {
        billingStatus.innerHTML = opsStatus('Ops failed to load', false);
        billingDetail.textContent = e.message;
        deployStatus.textContent = e.message;
      }
    }

    async function checkOpsHealth(agent) {
      const set = (id, label, ok, detail = '') => {
        document.getElementById(id).innerHTML = `${esc(label)}: ${ok ? opsStatus('online', true) : opsStatus('check failed', false)}${detail ? ` <span style="color:var(--muted)"> ${esc(detail)}</span>` : ''}`;
      };
      fetch(`${API}/health`).then(r => set('ops-api-status', 'API', r.ok, String(r.status))).catch(() => set('ops-api-status', 'API', false));
      fetch('https://mcp.proagentstore.online/mcp', { method: 'HEAD' })
        .then(r => set('ops-mcp-status', 'MCP', r.status === 401 || r.ok, String(r.status)))
        .catch(() => set('ops-mcp-status', 'MCP', false));
      const workerUrl = agent.workerUrl || `https://${agent.slug}.proagentstore.online/`;
      fetch(workerUrl)
        .then(r => set('ops-worker-status', 'Worker', r.ok, String(r.status)))
        .catch(() => set('ops-worker-status', 'Worker', false, workerUrl));
    }

    async function verifyCloudflareKey() {
      if (!confirm('Verify by making a tiny Cloudflare Workers AI request using your stored key?')) return;
      const status = document.getElementById('ops-billing-status');
      status.textContent = 'Verifying Cloudflare key...';
      try {
        const res = await api('/v1/keys/cloudflare/verify', { method: 'POST' });
        status.innerHTML = res.ok ? opsStatus('Verified: Cloudflare Workers AI key works', true) : opsStatus('Verification failed', false);
        loadOps();
      } catch (e) {
        status.innerHTML = opsStatus(`Verification failed: ${e.message}`, false);
      }
    }

    async function triggerDeploy() {
      if (!currentAgent) return;
      if (!confirm(`Deploy ${currentAgent.slug || currentAgent.name}?`)) return;
      const btn = document.getElementById('ops-deploy-button');
      btn.disabled = true;
      btn.textContent = 'Deploying...';
      try {
        await api(`/v1/agents/${currentAgent.id}/deploy`, { method: 'POST' });
        await loadOps();
      } catch (e) {
        alert(e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Deploy';
      }
    }

    async function copyMcpCommand() {
      const text = document.getElementById('ops-mcp-command').textContent;
      await navigator.clipboard.writeText(text).catch(() => {});
    }

