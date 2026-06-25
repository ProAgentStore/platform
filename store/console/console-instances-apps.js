// biome-ignore-all lint/correctness/noUnusedVariables: Console functions are called from inline HTML handlers.
// ── Instances: KB page + Applications kanban ─────────────────
// Split out of console-instances.js (shared global scope; loaded as a sibling
// classic script after it). Keep here: knowledge-base view + applications board.

    // ── KB page ──────────────────────────────────────────────
    async function loadKnowledgeBase() {
      loadInstanceKnowledge(); // docs
      loadKbMemory();
      loadKbFiles();
      loadCredentials();
      loadInstructionsTips();
      loadKbChatHistory();
    }

    // ── Special Instructions + learned per-ATS tips (transparency) ──
    async function loadInstructionsTips() {
      const ta = document.getElementById('inst-special-instructions');
      if (ta) { try { const d = await api(`/v1/instances/${currentInstance.id}/instructions`); ta.value = d.instructions || ''; } catch (e) {} }
      const list = document.getElementById('inst-tips-list');
      const empty = document.getElementById('inst-tips-empty');
      if (!list) return;
      try {
        const d = await api(`/v1/instances/${currentInstance.id}/apply-tips`);
        const tips = d.tips || [];
        if (empty) empty.classList.toggle('hidden', tips.length > 0);
        list.innerHTML = tips.map(t => {
          const n = (t.notes || '').split('\n').length;
          const failed = (t.notes || '').match(/FAILED/g);
          return `<div class="memory-item">
            <div class="key">${esc(t.host)} <span class="type">${esc(t.outcome || '?')}</span> <span class="type">${t.steps || 0} steps</span>${failed ? ` <span class="type" style="color:#c0392b">${failed.length} failed</span>` : ''}</div>
            <div class="content"><details><summary style="cursor:pointer;color:var(--muted)">show the ${n} steps the agent took</summary><pre style="white-space:pre-wrap;font-size:0.76rem;margin-top:0.4rem;font-family:ui-monospace,monospace">${esc(t.notes || '')}</pre></details></div>
            <div style="font-size:0.7rem;color:var(--muted-soft);margin-top:0.3rem">updated ${esc(String(t.updatedAt || '').slice(0,16))}</div>
          </div>`;
        }).join('');
      } catch (e) { list.innerHTML = '<div class="empty" style="padding:1rem">Could not load tips.</div>'; }
    }

    async function saveInstructions() {
      const ta = document.getElementById('inst-special-instructions');
      const status = document.getElementById('inst-instr-status');
      if (!ta) return;
      try {
        await api(`/v1/instances/${currentInstance.id}/instructions`, { method: 'PUT', body: JSON.stringify({ instructions: ta.value }) });
        if (status) { status.textContent = 'Saved ✓'; setTimeout(() => { status.textContent = ''; }, 2500); }
      } catch (e) { if (status) status.textContent = 'Save failed'; }
    }

    // ── Credentials vault ───────────────────────────────────────
    async function loadCredentials() {
      const list = document.getElementById('inst-cred-list');
      const empty = document.getElementById('inst-cred-empty');
      if (!list) return;
      try {
        const data = await api(`/v1/instances/${currentInstance.id}/credentials`);
        const creds = data.credentials || [];
        if (empty) empty.classList.toggle('hidden', creds.length > 0);
        list.innerHTML = creds.map(cr => {
          const badges = [cr.hasPassword ? 'password' : '', cr.hasPin ? 'PIN' : '', cr.hasRecoveryCodes ? 'recovery' : ''].filter(Boolean)
            .map(b => `<span class="type">${esc(b)}</span>`).join(' ');
          const used = cr.lastUsedAt ? ` · used ${esc(String(cr.lastUsedAt).slice(0,10))}` : '';
          return `<div class="memory-item">
            <div class="key">🔐 ${esc(cr.domain)} ${badges}</div>
            <div class="content">${esc(cr.username || '(no username)')}${cr.loginUrl ? ` · <a href="${esc(cr.loginUrl)}" target="_blank" rel="noopener">login</a>` : ''}${used}${cr.comments ? `<br><span style="color:var(--muted)">${esc(cr.comments)}</span>` : ''}</div>
            <div style="display:flex;gap:0.35rem;margin-top:0.4rem;flex-wrap:wrap">
              <button type="button" class="btn btn-outline btn-sm" onclick="revealCred('${esc(cr.id)}')">Reveal</button>
              <button type="button" class="btn btn-outline btn-sm" onclick="editCred('${esc(cr.id)}')">Edit</button>
              <button type="button" class="btn btn-outline btn-sm" onclick="deleteCred('${esc(cr.id)}', '${esc(cr.domain)}')">Delete</button>
            </div>
            <div id="cred-reveal-${esc(cr.id)}" class="content hidden" style="margin-top:0.4rem;font-family:monospace;white-space:pre-wrap"></div>
          </div>`;
        }).join('');
      } catch (e) { list.innerHTML = `<div class="empty" style="padding:1rem">Could not load credentials.</div>`; }
    }

    function showCredForm() { document.getElementById('inst-cred-form').classList.remove('hidden'); }
    function hideCredForm() {
      const f = document.getElementById('inst-cred-form'); if (f) f.classList.add('hidden');
      ['id','domain','loginurl','username','password','pin','recovery','comments','history'].forEach(k => { const el = document.getElementById('cred-' + k); if (el) el.value = ''; });
    }

    async function saveCredential() {
      const v = (k) => (document.getElementById('cred-' + k) || {}).value || '';
      const domain = v('domain').trim();
      if (!domain) { alert('Site / domain is required'); return; }
      const id = v('id');
      const body = { domain, loginUrl: v('loginurl'), username: v('username'), password: v('password'), pin: v('pin'), recoveryCodes: v('recovery'), comments: v('comments'), recoveryHistory: v('history') };
      try {
        await api(`/v1/instances/${currentInstance.id}/credentials${id ? '/' + encodeURIComponent(id) : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
        hideCredForm(); loadCredentials();
      } catch (e) { alert('Could not save credential: ' + (e && e.message || e)); }
    }

    async function revealCred(id) {
      const box = document.getElementById('cred-reveal-' + id);
      if (!box) return;
      if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
      try {
        const c = await api(`/v1/instances/${currentInstance.id}/credentials/${encodeURIComponent(id)}/reveal`);
        box.textContent = `username: ${c.username || '—'}\npassword: ${c.password || '—'}\npin: ${c.pin || '—'}\nrecovery codes: ${c.recoveryCodes || '—'}${c.recoveryHistory ? `\nrecovery history: ${c.recoveryHistory}` : ''}`;
        box.classList.remove('hidden');
      } catch (e) { box.textContent = 'Could not reveal.'; box.classList.remove('hidden'); }
    }

    async function editCred(id) {
      try {
        const c = await api(`/v1/instances/${currentInstance.id}/credentials/${encodeURIComponent(id)}/reveal`);
        const set = (k, val) => { const el = document.getElementById('cred-' + k); if (el) el.value = val || ''; };
        set('id', c.id); set('domain', c.domain); set('loginurl', c.loginUrl); set('username', c.username);
        set('password', c.password); set('pin', c.pin); set('recovery', c.recoveryCodes); set('comments', c.comments); set('history', c.recoveryHistory);
        showCredForm();
      } catch (e) { alert('Could not load credential for editing.'); }
    }

    async function deleteCred(id, domain) {
      if (!confirm(`Delete the saved credential for ${domain}?`)) return;
      try { await api(`/v1/instances/${currentInstance.id}/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }); loadCredentials(); }
      catch (e) { alert('Could not delete credential.'); }
    }

    async function loadKbChatHistory() {
      if (!currentInstance) return;
      const container = document.getElementById('inst-kb-chat-messages');
      container.innerHTML = '<div class="chat-msg system">Ask the agent about what it knows, or ask it to update its knowledge.</div>';
      try {
        const data = await api(`/v1/instances/${currentInstance.id}/messages?limit=50`);
        for (const m of (data.messages || [])) {
          const clean = (m.content || '').replace(/^\[Context:[\s\S]*?\]\s*\n*/i, '');
          if (clean.trim()) container.innerHTML += chatBubble(m.role, clean);
        }
        container.scrollTop = container.scrollHeight;
      } catch {}
    }

    async function loadKbMemory() {
      if (!currentInstance) return;
      const list = document.getElementById('inst-kb-memory-list');
      const empty = document.getElementById('inst-kb-memory-empty');
      try {
        const data = await api(`/v1/instances/${currentInstance.id}/memory`);
        const items = data.memory || [];
        if (items.length === 0) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
        empty.classList.add('hidden');
        list.innerHTML = items.map(m => `
          <div class="memory-item">
            <div style="flex:1">
              <div class="key">${esc(m.key)} <span class="type">${esc(m.type)}</span></div>
              <div class="content">${esc((m.content || '').slice(0, 200))}${m.content?.length > 200 ? '...' : ''}</div>
            </div>
          </div>
        `).join('');
      } catch { list.innerHTML = ''; empty.classList.remove('hidden'); }
    }

    async function loadKbFiles() {
      if (!currentInstance) return;
      const list = document.getElementById('inst-kb-files-list');
      const empty = document.getElementById('inst-kb-files-empty');
      try {
        const data = await api(`/v1/instances/${currentInstance.id}/files`);
        const files = data.files || [];
        if (files.length === 0) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
        empty.classList.add('hidden');
        list.innerHTML = files.map(f => `
          <div class="memory-item" style="display:flex;align-items:start;gap:0.5rem">
            <div style="flex:1">
              <div class="key">${esc(f.name)} <span class="type">${esc(f.mimeType)}</span></div>
              <div class="content">${esc(f.size)} bytes${f.tags?.length ? ' &middot; ' + f.tags.map(t => esc(t)).join(', ') : ''} &middot; ${esc(f.createdAt?.split('T')[0] || '')}${fileExtractionLabel(f)}</div>
            </div>
            <button type="button" class="btn btn-outline btn-sm" title="Delete file" onclick="deleteKbFile('${esc(f.id)}', '${esc((f.name || '').replace(/'/g, ''))}')">Delete</button>
          </div>
        `).join('');
      } catch { list.innerHTML = ''; empty.classList.remove('hidden'); }
    }

    async function deleteKbFile(fileId, name) {
      if (!currentInstance || !fileId) return;
      if (!confirm(`Delete "${name}" from this agent's files? This also removes its indexed text. This can't be undone.`)) return;
      try {
        await api(`/v1/instances/${currentInstance.id}/files/${fileId}`, { method: 'DELETE' });
        loadKbFiles();
      } catch (e) { alert('Could not delete the file: ' + (e.message || e)); }
    }

    function fileExtractionLabel(file) {
      if (!file?.extractionStatus) return '';
      if (file.extractionStatus === 'extracted') return ` &middot; indexed ${Number(file.extractedTextLength || 0).toLocaleString()} chars`;
      if (file.extractionStatus === 'unsupported') return ' &middot; stored, text extraction unavailable';
      if (file.extractionStatus === 'failed') return ' &middot; stored, text extraction failed';
      return ' &middot; stored';
    }

    async function sendKbChatMessage() {
      const input = document.getElementById('inst-kb-chat-input');
      const message = input.value.trim();
      if (!message || !currentInstance) return;
      input.value = '';

      const container = document.getElementById('inst-kb-chat-messages');
      container.innerHTML += chatBubble("user", message);
      container.scrollTop = container.scrollHeight;
      document.getElementById('inst-kb-chat-thinking').classList.remove('hidden');

      const context = `[Context: The user is browsing the knowledge base and asking about what you know. Use search_knowledge and read_memory tools to answer. If they ask you to update or correct something, use write_memory or the appropriate tool.]\n\n${message}`;

      try {
        const data = await api(`/v1/instances/${currentInstance.id}/chat`, {
          method: 'POST',
          body: JSON.stringify({ message: context }),
        });
        if (data.message) container.innerHTML += chatBubble("assistant", data.message.content);
        if (data.error) container.innerHTML += renderInstanceChatError(data.error);
        // Reload KB after chat (agent may have updated it)
        loadKbMemory();
      } catch (e) {
        container.innerHTML += renderInstanceChatError(e.message);
      }
      document.getElementById('inst-kb-chat-thinking').classList.add('hidden');
      container.scrollTop = container.scrollHeight;
    }

    // ── Applications kanban ─────────────────────────────────────
    const APP_STATUSES = [
      { key: 'queued', label: 'Queued', dot: 'dot-queued' },
      { key: 'pending', label: 'Pending', dot: 'dot-needs_approval' },
      { key: 'submitted', label: 'Submitted', dot: 'dot-running' },
      { key: 'interview', label: 'Interview', dot: 'dot-running' },
      { key: 'rejected', label: 'Rejected', dot: 'dot-failed' },
      { key: 'accepted', label: 'Accepted', dot: 'dot-completed' },
    ];

    async function loadInstanceApplications() {
      const boardEl = document.getElementById('inst-unified-board');
      if (!boardEl || !currentInstance) return;
      // Append application columns to the existing runtime board
      const board = boardEl;
      try {
        const data = await api(`/v1/instances/${currentInstance.id}/collections/applications/records?limit=100`).catch(() => ({ records: [] }));
        const records = data.records || [];
        if (records.length === 0) return;

        // Update the board summary
        const summary = document.getElementById('inst-board-summary');
        if (summary) {
          const applicationText = `${records.length} application${records.length === 1 ? '' : 's'}`;
          const runtimeText = summary.textContent && !summary.textContent.startsWith('Loading')
            ? summary.textContent
            : '';
          summary.textContent = runtimeText ? `${runtimeText} · ${applicationText}` : applicationText;
        }

        // Group by status
        const grouped = {};
        for (const s of APP_STATUSES) grouped[s.key] = [];
        for (const r of records) {
          const status = r.data.status || 'queued';
          if (!grouped[status]) grouped[status] = [];
          grouped[status].push(r);
        }

        // Add application columns after the runtime columns without rewriting the
        // existing runtime task cards; those cards own their click listeners.
        for (const s of APP_STATUSES) {
          const items = grouped[s.key] || [];
          const column = document.createElement('section');
          column.className = 'kanban-column';
          column.setAttribute('aria-label', `${s.label} applications column`);
          column.innerHTML = `
            <div class="kanban-header">
              <div class="kanban-title"><span class="kanban-dot ${s.dot}"></span>${esc(s.label)}</div>
              <span class="kanban-count">${items.length}</span>
            </div>
            <div class="kanban-items"></div>`;
          const list = column.querySelector('.kanban-items');
          if (items.length === 0) {
            list.innerHTML = '<div class="kanban-empty">No applications</div>';
          }
          for (const r of items) {
            const d = r.data;
            const company = d.company || d.Company || '?';
            const role = d.role || d.job_title || d.Role || '?';
            const url = d.url || '';
            const date = r.createdAt ? r.createdAt.split('T')[0] : '';
            const card = document.createElement('article');
            card.className = 'kanban-card';
            card.tabIndex = 0;
            card.setAttribute('role', 'button');
            card.setAttribute('aria-label', `Open application ${company} ${role}`);
            card.innerHTML = `
              <h3>${esc(company)}</h3>
              <p>${esc(role)}</p>
              <div class="kanban-card-meta">
                ${date ? `<span class="tag tag-cat">${esc(date)}</span>` : ''}
                ${url ? `<a href="${escAttr(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="tag tag-cat" style="text-decoration:underline">Link</a>` : ''}
              </div>
            `;
            card.addEventListener('click', () => showApplicationDetail(r.id));
            card.addEventListener('keydown', (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                showApplicationDetail(r.id);
              }
            });
            list.appendChild(card);
          }
          board.appendChild(column);
        }
      } catch (e) {
        board.innerHTML = `<p style="color:var(--red);padding:1rem">Failed to load applications: ${esc(e.message)}</p>`;
      }
    }

    let currentAppRecord = null;

    async function showApplicationDetail(id) {
      if (!currentInstance) return;
      try {
        const data = await api(`/v1/instances/${currentInstance.id}/collections/applications/records/${id}`);
        currentAppRecord = data;
        const d = data.data || {};

        // Set URL
        setConsoleUrl(`/instances/${encodeURIComponent(currentInstance.id)}/applications/${encodeURIComponent(id)}`);

        const company = d.company || d.Company || '?';
        const role = d.role || d.job_title || '?';

        // Inject nav into header bar
        const slot = document.getElementById('inst-nav-slot');
        slot.innerHTML = `
          <a href="#" onclick="showPage('instance-detail');switchInstTab('board');return false" style="color:var(--muted);text-decoration:none;font-size:1rem;padding:0 0.25rem">&larr;</a>
          <span style="font-weight:700;font-size:0.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px">${esc(company)} — ${esc(role)}</span>
          <span class="tag tag-${escAttr(d.status || 'queued')}" style="font-size:0.72rem">${esc(d.status || 'queued')}</span>
        `;

        document.getElementById('app-detail-title').textContent = `${company} — ${role}`;
        document.getElementById('app-detail-status').innerHTML =
          `<span class="tag tag-${escAttr(d.status || 'queued')}">${esc(d.status || 'queued')}</span>` +
          (d.url ? ` <a href="${escAttr(d.url)}" target="_blank" rel="noopener" style="font-size:0.82rem;margin-left:0.5rem">${esc(d.url)}</a>` : '');

        // Back link
        document.getElementById('app-detail-back').onclick = (e) => {
          e.preventDefault();
          showPage('instance-detail');
          switchInstTab('board');
        };

        // Fields
        const fieldsEl = document.getElementById('app-detail-fields');
        fieldsEl.innerHTML = '';
        const fieldOrder = ['company', 'role', 'job_title', 'url', 'cover_note', 'resume_used', 'submitted_at'];
        const shown = new Set(['status']); // status shown in header, not fields
        for (const key of fieldOrder) {
          if (d[key] !== undefined) {
            shown.add(key);
            fieldsEl.innerHTML += renderDetailField(key, d[key]);
          }
        }
        for (const [k, v] of Object.entries(d)) {
          if (!shown.has(k)) fieldsEl.innerHTML += renderDetailField(k, v);
        }
        fieldsEl.innerHTML += renderDetailField('created', data.createdAt);
        fieldsEl.innerHTML += renderDetailField('updated', data.updatedAt);

        // Compact status changer: one dropdown (current status selected) + delete.
        const actionsEl = document.getElementById('app-detail-actions');
        const cur = d.status || 'queued';
        actionsEl.innerHTML =
          `<label class="app-status-label">Status</label>` +
          `<select class="app-status-select" title="Change status" onchange="updateAppStatus('${esc(id)}', this.value)">` +
          APP_STATUSES.map(s => `<option value="${escAttr(s.key)}"${s.key === cur ? ' selected' : ''}>${esc(s.label)}</option>`).join('') +
          `</select>` +
          `<button class="btn-sm btn-danger" onclick="deleteApplication('${esc(id)}')" title="Delete application">&#128465;</button>`;

        // Activity filtered to this specific record
        loadAppDetailActivity(id);

        // Chat
        loadAppDetailChat(company, role);

        showPage('application-detail');
      } catch (e) {
        alert('Failed to load application: ' + e.message);
      }
    }

    function renderDetailField(key, value) {
      const val = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value || '');
      const isLong = val.length > 100;
      const isUrl = /^https?:\/\//.test(val);
      let display;
      if (isUrl) {
        display = `<a href="${escAttr(val)}" target="_blank" rel="noopener" style="word-break:break-all">${esc(val)}</a>`;
      } else if (isLong) {
        display = `<div class="runtime-detail-pre">${esc(val)}</div>`;
      } else {
        display = esc(val);
      }
      return `<div class="runtime-detail-field" ${isLong ? 'style="grid-column:1/-1"' : ''}>
        <div class="runtime-detail-label">${esc(key.replace(/_/g, ' '))}</div>
        <div class="runtime-detail-value">${display}</div>
      </div>`;
    }

    async function updateAppStatus(recordId, newStatus) {
      if (!currentInstance) return;
      try {
        await api(`/v1/instances/${currentInstance.id}/collections/applications/records/${recordId}`, {
          method: 'PUT',
          body: JSON.stringify({ data: { status: newStatus } }),
        });
        // Reload the detail
        await showApplicationDetail(recordId);
      } catch (e) {
        alert('Failed to update status: ' + e.message);
      }
    }

    async function loadAppDetailActivity(recordId) {
      const el = document.getElementById('app-detail-activity');
      try {
        const data = await api(`/v1/instances/${currentInstance.id}/activity?limit=50`);
        const events = (data.events || []).filter(e => {
          if (!e.data) return false;
          // Match events for this specific record
          if (e.data.recordId === recordId) return true;
          // Match tool calls that mention this record
          if (e.data.tool && e.type === 'tool.called') return false; // skip generic tool calls
          return false;
        });
        if (events.length === 0) {
          el.innerHTML = '<div class="runtime-history-empty">No activity for this application yet.</div>';
          return;
        }
        el.innerHTML = events.map(e => {
          const time = e.createdAt?.split('T')[1]?.slice(0,8) || '';
          const date = e.createdAt?.split('T')[0] || '';
          const typeLabel = e.type.replace('collection.record.', '').replace('tool.', '');
          const dataHtml = e.data ? Object.entries(e.data)
            .filter(([k]) => k !== 'recordId' && k !== 'collection')
            .map(([k, v]) => `<span style="color:var(--muted-soft)">${esc(k)}:</span> ${esc(String(v))}`)
            .join(' &middot; ') : '';
          return `<div class="runtime-history-item">
            <div class="runtime-history-head">
              <span class="runtime-history-type">${esc(typeLabel)}</span>
              <span>${esc(date)} ${esc(time)}</span>
            </div>
            ${dataHtml ? `<div class="runtime-history-message">${dataHtml}</div>` : ''}
          </div>`;
        }).join('');
      } catch {
        el.innerHTML = '<div class="runtime-history-empty">Failed to load activity.</div>';
      }
    }

    async function loadAppDetailChat(company, role) {
      const container = document.getElementById('app-detail-chat-messages');
      container.innerHTML = `<div class="chat-msg system">Discussing: ${esc(company)} — ${esc(role)}</div>`;
      try {
        const data = await api(`/v1/instances/${currentInstance.id}/messages?limit=50`);
        for (const m of (data.messages || [])) {
          const clean = (m.content || '').replace(/^\[Context:[\s\S]*?\]\s*\n*/i, '');
          if (clean.trim()) container.innerHTML += chatBubble(m.role, clean);
        }
        container.scrollTop = container.scrollHeight;
      } catch {}
    }

    async function sendAppDetailMessage() {
      const input = document.getElementById('app-detail-chat-input');
      const message = input.value.trim();
      if (!message || !currentInstance || !currentAppRecord) return;
      input.value = '';

      const container = document.getElementById('app-detail-chat-messages');
      container.innerHTML += chatBubble("user", message);
      container.scrollTop = container.scrollHeight;
      document.getElementById('app-detail-chat-thinking').classList.remove('hidden');

      // Prefix the message with context about this specific application
      const d = currentAppRecord.data || {};
      const context = `[Context: We are discussing the application to ${d.company || '?'} for the ${d.role || d.job_title || '?'} role. Application ID: ${currentAppRecord.id}. Status: ${d.status || '?'}. URL: ${d.url || 'none'}]\n\n${message}`;

      try {
        const data = await api(`/v1/instances/${currentInstance.id}/chat`, {
          method: 'POST',
          body: JSON.stringify({ message: context }),
        });
        if (data.message) {
          container.innerHTML += chatBubble("assistant", data.message.content);
        }
        if (data.error) {
          container.innerHTML += renderInstanceChatError(data.error);
        }
      } catch (e) {
        container.innerHTML += renderInstanceChatError(e.message);
      }
      document.getElementById('app-detail-chat-thinking').classList.add('hidden');
      container.scrollTop = container.scrollHeight;
    }

