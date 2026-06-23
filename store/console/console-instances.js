// biome-ignore-all lint/correctness/noUnusedVariables: Console functions are called from inline HTML handlers.
// ── Instances (client view) ──────────────────────────────

    let currentInstance = null;
    let currentRuntimeTasks = [];
    let currentRuntimeEvents = [];
    let currentRuntimeTaskId = null;
    // Board shows only active tasks (waiting/running/needs you) by default so the
    // task that needs your attention isn't buried under old runs.
    let showAllRuntimeTasks = false;
    const INSTANCE_RUNTIME_COLUMNS = [
      {
        id: 'waiting',
        title: 'Waiting',
        color: 'var(--yellow)',
        statuses: ['queued', 'needs_approval'],
        empty: 'No queued or approval-gated tasks.',
      },
      {
        id: 'running',
        title: 'Running',
        color: 'var(--blue)',
        statuses: ['running'],
        empty: 'No task is running right now.',
      },
      {
        id: 'needs_human',
        title: 'Needs you',
        color: '#f59e0b',
        statuses: ['needs_human'],
        empty: 'No tasks waiting on you.',
      },
      {
        id: 'blocked',
        title: 'Blocked',
        color: 'var(--red)',
        statuses: ['blocked', 'failed'],
        empty: 'No blocked or failed runtime tasks.',
      },
      {
        id: 'done',
        title: 'Done',
        color: 'var(--green)',
        statuses: ['completed'],
        empty: 'Completed tasks appear here.',
      },
      {
        id: 'cancelled',
        title: 'Cancelled',
        color: 'var(--muted)',
        statuses: ['cancelled'],
        empty: 'Cancelled tasks appear here.',
      },
    ];

    async function loadInstances() {
      document.getElementById('instances-loading').classList.remove('hidden');
      try {
        const data = await api('/v1/instances/my/instances');
        const list = document.getElementById('instances-list');
        const empty = document.getElementById('instances-empty');
        list.innerHTML = '';
        const items = data.instances || [];
        empty.classList.toggle('hidden', items.length > 0);
        for (const inst of items) {
          const card = document.createElement('div');
          card.className = 'agent-card';
          card.style.cursor = 'pointer';
          card.innerHTML = `
            <div class="agent-icon" style="background:${esc(inst.icon_bg || '#7c3aed')}">${inst.icon || '&#9889;'}</div>
            <div class="agent-body">
              <div class="agent-name">${esc(inst.name)}</div>
              <div class="agent-desc">${esc(inst.description || '')}</div>
              <div class="agent-meta"><span class="tag">${esc(inst.category || 'general')}</span></div>
            </div>`;
          card.addEventListener('click', () => openInstance(inst.id, inst));
          list.appendChild(card);
        }
      } catch (e) { console.error(e); }
      document.getElementById('instances-loading').classList.add('hidden');
    }

    async function resolveInstanceMeta(instanceId, meta) {
      if (meta?.name) return meta;
      const data = await api('/v1/instances/my/instances');
      return (data.instances || []).find(inst => inst.id === instanceId) || { id: instanceId, name: 'Agent' };
    }

    async function openInstance(instanceId, meta, tab = 'chat', updateUrl = true, runtimeTaskId = null) {
      if (tab === 'runtime' || tab === 'applications') tab = 'board';
      meta = await resolveInstanceMeta(instanceId, meta);
      currentInstance = { id: instanceId, ...meta };
      currentRuntimeTaskId = runtimeTaskId;
      showPage('instance-detail');
      // Inject instance nav into the single header bar
      const slot = document.getElementById('inst-nav-slot');
      slot.innerHTML = `
        <a href="/console/instances" onclick="showDashboard('instances');return false" style="color:var(--muted);text-decoration:none;font-size:1rem;padding:0 0.25rem">&larr;</a>
        <span style="font-weight:700;font-size:0.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px">${esc(meta.name || 'Agent')}</span>
        <span id="runtime-status-badge" style="font-size:0.65rem;padding:0.15rem 0.4rem;border-radius:999px;font-weight:700;background:var(--line);color:var(--muted)">...</span>
        <div class="inst-nav-tabs">
          <button type="button" class="tab${tab==='chat'?' active':''}" data-inst-tab="chat" onclick="switchInstTab('chat')">Chat</button>
          <button type="button" class="tab${tab==='board'?' active':''}" data-inst-tab="board" onclick="switchInstTab('board')">Board</button>
          <button type="button" class="tab${tab==='knowledge'?' active':''}" data-inst-tab="knowledge" onclick="switchInstTab('knowledge')">Knowledge</button>
        </div>
      `;
      switchInstTab(tab, false);
      loadInstanceMessages();
      checkRuntimeStatus();
      if (updateUrl) {
        const detailPath = tab === 'board' && runtimeTaskId
          ? `/instances/${encodeURIComponent(instanceId)}/board/tasks/${encodeURIComponent(runtimeTaskId)}`
          : `/instances/${encodeURIComponent(instanceId)}/${tab}`;
        setConsoleUrl(detailPath);
      }
    }

    function switchInstTab(name, updateUrl = true) {
      // Update tab active state in both header slot and instance-detail
      document.querySelectorAll('[data-inst-tab]').forEach(t => {
        t.classList.toggle('active', t.dataset.instTab === name);
      });
      document.getElementById('instance-detail').querySelectorAll('.tab-panel').forEach(p => {
        p.classList.toggle('active', p.id === `inst-tab-${name}`);
      });
      // Single scroll: lock body when chat is active
      document.body.classList.toggle('chat-active', name === 'chat');
      currentInstanceTab = name;
      if (name === 'board') loadUnifiedBoard();
      if (name === 'knowledge') loadKnowledgeBase();
      if (name !== 'board') {
        currentRuntimeTaskId = null;
        hideRuntimeTaskDetail();
      }
      if (name === 'runtime' && updateUrl) {
        currentRuntimeTaskId = null;
        hideRuntimeTaskDetail();
      }
      if (name === 'runtime') loadInstanceRuntime();
      if (updateUrl && currentInstance) setConsoleUrl(`/instances/${encodeURIComponent(currentInstance.id)}/${name}`);
    }

    async function loadInstanceRuntime() {
      if (!currentInstance) return;
      const summary = document.getElementById('inst-board-summary');
      const board = document.getElementById('inst-unified-board');
      const eventList = document.getElementById('inst-runtime-event-list');
      summary.textContent = 'Loading runtime tasks...';
      board.innerHTML = '';
      eventList.innerHTML = '';
      currentRuntimeTasks = [];
      currentRuntimeEvents = [];
      try {
        const [runtimeRes, tasksRes, eventsRes] = await Promise.allSettled([
          api(`/v1/instances/${currentInstance.id}/runtime`),
          api(`/v1/instances/${currentInstance.id}/tasks`),
          api(`/v1/instances/${currentInstance.id}/task-events?limit=500`),
        ]);
        const runtime = runtimeRes.status === 'fulfilled' ? runtimeRes.value.runtime : null;
        const tasksPayload = tasksRes.status === 'fulfilled' ? tasksRes.value : {};
        const eventsPayload = eventsRes.status === 'fulfilled' ? eventsRes.value : {};
        const tasks = tasksPayload.tasks || [];
        const events = eventsPayload.events || [];
        currentRuntimeTasks = tasks;
        currentRuntimeEvents = events;
        if (!runtime) {
          const taskWord = tasks.length === 1 ? 'task' : 'tasks';
          summary.textContent = `${tasks.length} setup/runtime ${taskWord} · runtime not registered · local`;
          renderInstanceTaskBoard(tasks);
          renderCurrentRuntimeTaskDetail(false);
          renderInstanceRuntimeEvents(events.slice(0, 25));
          return;
        }
        const taskWord = tasks.length === 1 ? 'task' : 'tasks';
        const stale = tasksPayload.runtimeUnavailable || eventsPayload.runtimeUnavailable;
        const status = stale ? 'offline; showing PAGS history' : (runtime.status || 'registered');
        summary.textContent = `${tasks.length} runtime ${taskWord} · ${status} · ${runtime.placement || 'local'}`;
        renderInstanceTaskBoard(tasks);
        renderCurrentRuntimeTaskDetail(false);
        renderInstanceRuntimeEvents(events.slice(0, 25));
      } catch (e) {
        summary.textContent = `Runtime unavailable: ${e.message}`;
        renderInstanceTaskBoard([]);
        renderCurrentRuntimeTaskDetail(false);
      }
    }

    function renderInstanceTaskBoard(tasks) {
      const activeIds = ['waiting', 'running', 'needs_human'];
      const cols = showAllRuntimeTasks
        ? INSTANCE_RUNTIME_COLUMNS
        : INSTANCE_RUNTIME_COLUMNS.filter(c => activeIds.includes(c.id));
      const allowed = new Set(cols.flatMap(c => c.statuses));
      const all = tasks || [];
      const shown = showAllRuntimeTasks ? all : all.filter(t => allowed.has(t.status));
      renderKanbanBoard({
        boardId: 'inst-unified-board',
        items: shown,
        columns: cols,
        renderCard: runtimeTaskCard,
        columnForItem: task => cols.find(col => col.statuses.includes(task.status)) || cols[0],
      });
      const summary = document.getElementById('inst-board-summary');
      if (summary) {
        const prev = summary.querySelector('.rt-history-toggle');
        if (prev) prev.remove();
        const hidden = all.length - shown.length;
        const label = showAllRuntimeTasks ? 'show only active' : (hidden > 0 ? `show history (${hidden})` : '');
        if (label) {
          const btn = document.createElement('button');
          btn.className = 'rt-history-toggle';
          btn.style.cssText = 'margin-left:8px;background:none;border:none;color:#7c3aed;cursor:pointer;font-size:0.78rem;text-decoration:underline';
          btn.textContent = label;
          btn.addEventListener('click', () => { showAllRuntimeTasks = !showAllRuntimeTasks; renderInstanceTaskBoard(currentRuntimeTasks); });
          summary.appendChild(btn);
        }
      }
    }

    // Live Browser: remote view + control of a paused (needs_human) task, so the
    // user can solve a CAPTCHA / human challenge the agent can't.
    function openTakeover(taskId) {
      const inst = currentInstance && currentInstance.id;
      if (!inst) return;
      const overlay = document.createElement('div');
      overlay.id = 'takeover-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.86);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px';
      overlay.innerHTML = `
        <div style="color:#fff;font-size:0.9rem;display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:center">
          <span>🖥 Live browser — solve the challenge, then click <b>Done</b></span>
          <span id="takeover-status" style="color:#9ca3af;font-size:0.78rem">connecting…</span>
        </div>
        <img id="takeover-frame" alt="live browser" style="max-width:96vw;max-height:78vh;border:2px solid #f59e0b;border-radius:8px;cursor:crosshair;background:#111" />
        <div style="display:flex;gap:8px">
          <button id="takeover-done" class="btn btn-primary btn-sm">Done — finish</button>
          <button id="takeover-close" class="btn btn-outline btn-sm" style="color:#fff;border-color:#555">Close</button>
        </div>`;
      document.body.appendChild(overlay);
      const img = overlay.querySelector('#takeover-frame');
      const statusEl = overlay.querySelector('#takeover-status');
      let alive = true;
      // CSS viewport of the real page (reported by the runner) — clicks map to
      // these coordinates, which is what CDP Input expects regardless of DPR.
      let pageW = 0, pageH = 0;

      async function poll() {
        while (alive) {
          try {
            const data = await api(`/v1/instances/${inst}/takeover/${encodeURIComponent(taskId)}/frame`);
            if (data && data.frame) {
              img.src = data.frame;
              if (data.width) pageW = data.width;
              if (data.height) pageH = data.height;
              statusEl.textContent = 'live';
            }
          } catch (e) { statusEl.textContent = 'frame error'; }
          await new Promise(r => setTimeout(r, 600));
        }
      }
      function sendInput(payload) {
        api(`/v1/instances/${inst}/takeover/${encodeURIComponent(taskId)}/input`, { method: 'POST', body: JSON.stringify(payload) }).catch(() => {});
      }
      function toPageCoords(ev) {
        const rect = img.getBoundingClientRect();
        const w = pageW || img.naturalWidth || rect.width;
        const h = pageH || img.naturalHeight || rect.height;
        return { x: Math.round((ev.clientX - rect.left) / rect.width * w), y: Math.round((ev.clientY - rect.top) / rect.height * h) };
      }
      img.addEventListener('click', (ev) => { const c = toPageCoords(ev); sendInput({ type: 'click', x: c.x, y: c.y }); });
      function onKey(ev) {
        if (!alive) return;
        if (ev.key && ev.key.length === 1) sendInput({ type: 'text', text: ev.key });
        else if (ev.key) sendInput({ type: 'key', key: ev.key });
        ev.preventDefault();
      }
      document.addEventListener('keydown', onKey);
      function teardown() { alive = false; document.removeEventListener('keydown', onKey); overlay.remove(); }
      overlay.querySelector('#takeover-close').addEventListener('click', teardown);
      overlay.querySelector('#takeover-done').addEventListener('click', async () => {
        await api(`/v1/instances/${inst}/takeover/${encodeURIComponent(taskId)}/end`, { method: 'POST' }).catch(() => {});
        teardown();
        loadUnifiedBoard();
      });
      poll();
    }

    function runtimeTaskCard(task) {
      const card = document.createElement('article');
      card.className = 'kanban-card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Open runtime task ${task.id || task.type || 'task'}`);
      const output = typeof task.output === 'object' && task.output ? JSON.stringify(task.output).slice(0, 180) : String(task.output || '');
      const error = task.error ? `<div style="font-size:0.72rem;color:var(--red);line-height:1.45;margin-top:0.45rem">${esc(task.error)}</div>` : '';
      const approval = task.status === 'needs_approval'
        ? `<button type="button" class="btn btn-primary btn-sm" data-task-action="approve" data-task-id="${esc(task.id)}">Approve</button>`
        : '';
      const cancellable = ['queued', 'running', 'needs_approval'].includes(task.status)
        ? `<button type="button" class="btn btn-outline btn-sm" data-task-action="cancel" data-task-id="${esc(task.id)}">Cancel</button>`
        : '';
      const takeover = task.status === 'needs_human'
        ? `<button type="button" class="btn btn-primary btn-sm" data-task-action="takeover" data-task-id="${esc(task.id)}">🖥 Take over</button>`
        : '';
      card.innerHTML = `
        <h3>${esc(task.type || 'task')}</h3>
        <p>${esc(task.approval?.prompt || task.id)}</p>
        <div style="font-size:0.7rem;color:var(--muted-soft);margin-bottom:0.45rem">Updated ${esc(formatTime(task.updatedAt || task.createdAt))}</div>
        <div class="kanban-card-meta">
          <span class="tag tag-${esc(task.status || 'queued')}">${esc(String(task.status || 'queued').replace('_', ' '))}</span>
          ${task.requiresApproval ? '<span class="tag">approval</span>' : ''}
        </div>
        ${error}
        ${output ? `<div style="font-size:0.72rem;color:var(--muted);line-height:1.45;margin-top:0.45rem;overflow-wrap:anywhere">${esc(output)}${output.length >= 180 ? '...' : ''}</div>` : ''}
        ${approval || cancellable || takeover ? `<div style="display:flex;gap:0.4rem;margin-top:0.65rem;flex-wrap:wrap">${takeover}${approval}${cancellable}</div>` : ''}`;
      card.querySelectorAll('[data-task-action]').forEach(button => {
        button.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (button.dataset.taskAction === 'takeover') { openTakeover(button.dataset.taskId); return; }
          await handleRuntimeTaskAction(button.dataset.taskId, button.dataset.taskAction, button);
        });
      });
      card.addEventListener('click', () => openRuntimeTaskDetail(task));
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openRuntimeTaskDetail(task);
        }
      });
      return card;
    }

    function safePrettyJson(value) {
      try {
        return JSON.stringify(value ?? {}, null, 2);
      } catch {
        return String(value || '');
      }
    }

    // Pull any data:image base64 values out of a data object so they render as
    // real images instead of dumping thousands of base64 chars into the JSON.
    function extractDataImages(data) {
      const images = [];
      const walk = (v) => {
        if (typeof v === 'string') {
          if (/^data:image\//.test(v)) { images.push(v); return '[screenshot below]'; }
          return v;
        }
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
          const out = {};
          for (const k of Object.keys(v)) out[k] = walk(v[k]);
          return out;
        }
        return v;
      };
      return { images, rest: walk(data) };
    }

    function runtimeDetailField(label, value) {
      return `<div class="runtime-detail-field">
        <div class="runtime-detail-label">${esc(label)}</div>
        <div class="runtime-detail-value">${esc(value)}</div>
      </div>`;
    }

    function runtimeEventTaskId(event) {
      if (!event || typeof event !== 'object') return '';
      if (typeof event.taskId === 'string') return event.taskId;
      if (typeof event.task_id === 'string') return event.task_id;
      if (event.data && typeof event.data === 'object' && typeof event.data.taskId === 'string') return event.data.taskId;
      return '';
    }

    function runtimeTaskEvents(task) {
      const taskId = task?.id || '';
      return (currentRuntimeEvents || [])
        .filter(event => runtimeEventTaskId(event) === taskId)
        .sort((a, b) => String(a.createdAt || a.created_at || '').localeCompare(String(b.createdAt || b.created_at || '')));
    }

    function renderRuntimeHistory(events) {
      if (!events.length) {
        return '<div class="runtime-history-empty">No recorded task history yet.</div>';
      }
      return `<div class="runtime-history">${events.map(event => {
        const createdAt = event.createdAt || event.created_at;
        const data = event.data ?? event.payload ?? event.result;
        let dataBlock = '';
        if (data !== undefined) {
          const { images, rest } = extractDataImages(data);
          const imgBlock = images.map(src =>
            `<img src="${esc(src)}" alt="screenshot" style="display:block;max-width:100%;margin-top:0.55rem;border:1px solid var(--line);border-radius:6px" />`
          ).join('');
          const hasRest = rest && (typeof rest !== 'object' || Object.keys(rest).length > 0);
          const jsonBlock = hasRest
            ? `<pre class="runtime-detail-pre" style="margin-top:0.55rem">${esc(safePrettyJson(rest))}</pre>`
            : '';
          dataBlock = jsonBlock + imgBlock;
        }
        return `<div class="runtime-history-item">
          <div class="runtime-history-head">
            <span class="runtime-history-type">${esc(event.type || 'event')}</span>
            <span>${esc(formatTime(createdAt))}</span>
          </div>
          ${event.message ? `<div class="runtime-history-message">${esc(event.message)}</div>` : ''}
          ${dataBlock}
        </div>`;
      }).join('')}</div>`;
    }

    function runtimeTaskDetailUrl(taskId) {
      return `/instances/${encodeURIComponent(currentInstance.id)}/board/tasks/${encodeURIComponent(taskId)}`;
    }

    function renderCurrentRuntimeTaskDetail(scrollIntoView = false) {
      if (!currentRuntimeTaskId) {
        hideRuntimeTaskDetail();
        return;
      }
      const task = currentRuntimeTasks.find(row => row.id === currentRuntimeTaskId);
      if (!task) {
        const section = document.getElementById('runtime-task-detail');
        document.getElementById('inst-unified-board').classList.add('hidden');
        document.getElementById('runtime-task-detail-status').innerHTML = '<span class="tag tag-failed">not found</span>';
        document.getElementById('runtime-task-detail-title').textContent = 'Runtime task not found';
        document.getElementById('runtime-task-detail-body').innerHTML = `<div class="runtime-detail-field">
          <div class="runtime-detail-label">Task ID</div>
          <div class="runtime-detail-value">${esc(currentRuntimeTaskId)}</div>
        </div>`;
        document.getElementById('runtime-task-detail-actions').innerHTML = '';
        section.classList.remove('hidden');
        if (scrollIntoView) section.scrollIntoView({ block: 'start' });
        return;
      }
      renderRuntimeTaskDetail(task, scrollIntoView);
    }

    function renderRuntimeTaskDetail(task, scrollIntoView = false) {
      const section = document.getElementById('runtime-task-detail');
      const title = document.getElementById('runtime-task-detail-title');
      const status = document.getElementById('runtime-task-detail-status');
      const body = document.getElementById('runtime-task-detail-body');
      const actions = document.getElementById('runtime-task-detail-actions');
      const events = runtimeTaskEvents(task);
      title.textContent = task.type || 'Runtime task';
      status.innerHTML = `
        <span class="tag tag-${esc(task.status || 'queued')}">${esc(String(task.status || 'queued').replace('_', ' '))}</span>
        ${task.requiresApproval ? '<span class="tag">approval</span>' : ''}
        ${task.synthetic ? '<span class="tag">history</span>' : ''}`;
      body.innerHTML = `
        <div class="runtime-detail-grid">
          ${runtimeDetailField('Task ID', task.id || '')}
          ${runtimeDetailField('Status', String(task.status || 'queued').replace('_', ' '))}
          ${runtimeDetailField('Created', formatTime(task.createdAt))}
          ${runtimeDetailField('Updated', formatTime(task.updatedAt || task.completedAt))}
        </div>
        ${task.approval?.prompt ? `<div class="runtime-detail-field"><div class="runtime-detail-label">Approval Prompt</div><div class="runtime-detail-value">${esc(task.approval.prompt)}</div></div>` : ''}
        ${task.error ? `<div class="runtime-detail-field"><div class="runtime-detail-label">Error</div><div class="runtime-detail-value" style="color:var(--red)">${esc(task.error)}</div></div>` : ''}
        <div>
          <div class="runtime-detail-label">Input</div>
          <pre class="runtime-detail-pre">${esc(safePrettyJson(task.input))}</pre>
        </div>
        <div>
          <div class="runtime-detail-label">Output</div>
          <pre class="runtime-detail-pre">${esc(safePrettyJson(task.output))}</pre>
        </div>
        <div>
          <div class="runtime-detail-label">Task History</div>
          ${renderRuntimeHistory(events)}
        </div>`;
      const approval = task.status === 'needs_approval'
        ? `<button type="button" class="btn btn-primary btn-sm" data-detail-task-action="approve" data-task-id="${esc(task.id)}">Approve</button>`
        : '';
      const cancellable = ['queued', 'running', 'needs_approval'].includes(task.status)
        ? `<button type="button" class="btn btn-outline btn-sm" data-detail-task-action="cancel" data-task-id="${esc(task.id)}">Cancel</button>`
        : '';
      const takeover = task.status === 'needs_human'
        ? `<button type="button" class="btn btn-primary btn-sm" data-detail-task-action="takeover" data-task-id="${esc(task.id)}">🖥 Take over (live screen)</button>`
        : '';
      actions.innerHTML = `${takeover}${approval}${cancellable}`;
      actions.querySelectorAll('[data-detail-task-action]').forEach(button => {
        button.addEventListener('click', async () => {
          if (button.dataset.detailTaskAction === 'takeover') { openTakeover(button.dataset.taskId); return; }
          await handleRuntimeTaskAction(button.dataset.taskId, button.dataset.detailTaskAction, button);
          closeRuntimeTaskDetail();
        });
      });
      section.classList.remove('hidden');
      document.getElementById('inst-unified-board').classList.add('hidden');
      if (scrollIntoView) section.scrollIntoView({ block: 'start' });
    }

    function openRuntimeTaskDetail(task, updateUrl = true) {
      if (!task?.id || !currentInstance) return;
      currentRuntimeTaskId = task.id;
      renderRuntimeTaskDetail(task, true);
      if (updateUrl) setConsoleUrl(runtimeTaskDetailUrl(task.id));
    }

    function closeRuntimeTaskDetail() {
      currentRuntimeTaskId = null;
      hideRuntimeTaskDetail();
      if (currentInstance) {
        setConsoleUrl(`/instances/${encodeURIComponent(currentInstance.id)}/board`);
      }
    }

    function hideRuntimeTaskDetail() {
      document.getElementById('runtime-task-detail').classList.add('hidden');
      document.getElementById('runtime-task-detail-actions').innerHTML = '';
      document.getElementById('inst-unified-board').classList.remove('hidden');
    }

    async function handleRuntimeTaskAction(taskId, action, sourceButton = null) {
      if (!currentInstance || !taskId || !action) return;
      if (action === 'cancel' && !confirm('Cancel this runtime task?')) return;
      const suffix = action === 'approve' ? 'approve' : 'cancel';
      const originalText = sourceButton?.textContent;
      if (sourceButton) {
        sourceButton.disabled = true;
        sourceButton.textContent = action === 'approve' ? 'Approving...' : 'Cancelling...';
      }
      try {
        await api(`/v1/instances/${currentInstance.id}/tasks/${encodeURIComponent(taskId)}/${suffix}`, { method: 'POST' });
        await loadInstanceRuntime();
      } catch (e) {
        if (sourceButton) {
          sourceButton.disabled = false;
          sourceButton.textContent = originalText || (action === 'approve' ? 'Approve' : 'Cancel');
        }
        alert(e.message);
      }
    }

    function renderInstanceRuntimeEvents(events) {
      const list = document.getElementById('inst-runtime-event-list');
      list.innerHTML = '';
      if (!events.length) {
        list.innerHTML = '<div style="color:var(--muted-soft);font-size:0.82rem">No runtime events yet.</div>';
        return;
      }
      for (const event of events) {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:130px 1fr auto;gap:0.6rem;align-items:start;border-bottom:1px solid var(--line);padding:0.4rem 0;font-size:0.78rem';
        row.innerHTML = `
          <span style="color:var(--muted);font-family:'SF Mono',monospace">${esc(event.type || 'event')}</span>
          <span>${esc(event.message || '')}</span>
          <span style="color:var(--muted-soft);white-space:nowrap">${esc(formatTime(event.createdAt))}</span>`;
        list.appendChild(row);
      }
    }

    async function loadInstanceMessages() {
      try {
        const data = await api(`/v1/instances/${currentInstance.id}/messages`);
        const container = document.getElementById('inst-chat-messages');
        container.innerHTML = '';
        for (const m of (data.messages || [])) {
          const content = m.role === 'assistant' ? renderMd(m.content) : esc(m.content);
          container.innerHTML += chatBubble(m.role, m.content);
        }
        container.scrollTop = container.scrollHeight;
      } catch {}
    }

    // ── Unified Board ──────────────────────────────────────────
    async function loadUnifiedBoard() {
      await loadInstanceRuntime();
      await loadInstanceApplications();
    }

    // ── KB page ──────────────────────────────────────────────
    async function loadKnowledgeBase() {
      loadInstanceKnowledge(); // docs
      loadKbMemory();
      loadKbFiles();
      loadKbChatHistory();
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
          <div class="memory-item">
            <div style="flex:1">
              <div class="key">${esc(f.name)} <span class="type">${esc(f.mimeType)}</span></div>
              <div class="content">${esc(f.size)} bytes${f.tags?.length ? ' &middot; ' + f.tags.map(t => esc(t)).join(', ') : ''} &middot; ${esc(f.createdAt?.split('T')[0] || '')}${fileExtractionLabel(f)}</div>
            </div>
          </div>
        `).join('');
      } catch { list.innerHTML = ''; empty.classList.remove('hidden'); }
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

        // Status change buttons
        const actionsEl = document.getElementById('app-detail-actions');
        const statuses = ['queued', 'pending', 'submitted', 'interview', 'rejected', 'accepted'];
        actionsEl.innerHTML = statuses.map(s =>
          `<button class="btn-sm ${s === d.status ? 'btn-primary' : 'btn-outline'}" onclick="updateAppStatus('${esc(id)}','${s}')">${esc(s)}</button>`
        ).join('') + `<button class="btn-sm btn-danger" onclick="deleteApplication('${esc(id)}')" title="Delete application">&#128465; Delete</button>`;

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

    function renderInstanceChatError(message) {
      const text = String(message || 'Unknown error');
      const needsCloudflareKey = text.includes('Cloudflare Workers AI account ID and API token');
      const help = needsCloudflareKey
        ? `<div style="margin-top:0.45rem;font-size:0.78rem;line-height:1.45;color:var(--muted)">
            Add it in <a href="${consoleUrlPrefix()}/profile">Profile &rarr; API Keys &rarr; Cloudflare Workers AI</a>.
            Use your Cloudflare Account ID and a Workers AI API token.
          </div>`
        : '';
      return `<div class="chat-msg system">Error: ${esc(text)}${help}</div>`;
    }

    async function checkRuntimeStatus() {
      if (!currentInstance) return;
      const badge = document.getElementById('runtime-status-badge');
      if (!badge) return;
      try {
        const data = await api(`/v1/instances/${currentInstance.id}/runtime`);
        const rt = data.runtime;
        if (rt?.endpointUrl || rt?.endpoint_url) {
          const online = rt.status === 'online';
          badge.textContent = online ? '● Runner online' : '● Runner registered';
          badge.title = rt.endpointUrl || rt.endpoint_url;
          badge.style.background = online ? 'rgba(34,197,94,0.15)' : 'rgba(234,179,8,0.12)';
          badge.style.color = online ? 'var(--green)' : 'var(--yellow)';
        } else {
          badge.textContent = '○ No runner';
          badge.title = '';
          badge.style.background = 'var(--line)';
          badge.style.color = 'var(--muted)';
        }
      } catch {
        badge.textContent = '○ No runner';
        badge.title = '';
        badge.style.background = 'var(--line)';
        badge.style.color = 'var(--muted)';
      }
    }

    async function clearInstanceChat() {
      if (!currentInstance) return;
      if (!confirm('Clear all chat history? This cannot be undone.')) return;
      try {
        await api(`/v1/instances/${currentInstance.id}/messages`, { method: 'DELETE' });
        document.getElementById('inst-chat-messages').innerHTML = '';
      } catch (e) { alert('Failed: ' + e.message); }
    }

    async function deleteApplication(id) {
      if (!currentInstance) return;
      if (!confirm('Delete this application? This cannot be undone.')) return;
      try {
        await api(`/v1/instances/${currentInstance.id}/collections/applications/records/${id}`, { method: 'DELETE' });
        showPage('instance-detail');
        switchInstTab('board');
      } catch (e) { alert('Failed: ' + e.message); }
    }

    async function sendInstanceMessage() {
      const input = document.getElementById('inst-chat-input');
      const message = input.value.trim();
      if (!message) return;
      input.value = '';

      const container = document.getElementById('inst-chat-messages');
      container.innerHTML += chatBubble("user", message);
      container.scrollTop = container.scrollHeight;
      document.getElementById('inst-chat-thinking').classList.remove('hidden');

      try {
        const data = await api(`/v1/instances/${currentInstance.id}/chat`, {
          method: 'POST',
          body: JSON.stringify({ message }),
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
      document.getElementById('inst-chat-thinking').classList.add('hidden');
      container.scrollTop = container.scrollHeight;
    }

    // Instance knowledge
    function showInstKbForm(type) { hideInstKbForms(); document.getElementById(`inst-kb-form-${type}`).classList.remove('hidden'); }
    function hideInstKbForms() { document.getElementById('inst-kb-form-paste').classList.add('hidden'); document.getElementById('inst-kb-form-url').classList.add('hidden'); }

    async function importInstGoogleDoc() {
      const url = prompt('Google Docs URL (must be publicly shared):');
      if (!url) return;
      try {
        // Proxy through instance ingest-url (server-side fetch avoids CORS)
        await api(`/v1/instances/${currentInstance.id}/knowledge/ingest-url`, {
          method: 'POST',
          body: JSON.stringify({ url: url.replace(/\/edit.*$/, '/export?format=txt'), title: 'Google Doc' }),
        });
        loadInstanceKnowledge();
      } catch (e) { alert(e.message); }
    }

    async function loadInstanceKnowledge() {
      try {
        const data = await api(`/v1/instances/${currentInstance.id}/knowledge`);
        const list = document.getElementById('inst-kb-list');
        const empty = document.getElementById('inst-kb-empty');
        list.innerHTML = '';
        const docs = data.documents || [];
        empty.classList.toggle('hidden', docs.length > 0);
        if (!docs.length) return;
        for (const doc of docs) {
          const item = document.createElement('div');
          item.className = 'memory-item';
          item.innerHTML = `<div style="flex:1;min-width:0"><span class="key">${esc(doc.title)}</span> <span class="type">${esc(doc.source)}</span>
            <div class="content">${esc(doc.content?.slice(0, 120) || '')}${doc.content?.length > 120 ? '...' : ''}</div></div>`;
          const btn = document.createElement('button');
          btn.className = 'btn btn-outline btn-sm';
          btn.textContent = '\u00d7';
          btn.style.flexShrink = '0';
          btn.addEventListener('click', async () => {
            await api(`/v1/instances/${currentInstance.id}/knowledge/${doc.id}`, { method: 'DELETE' });
            loadInstanceKnowledge();
          });
          item.appendChild(btn);
          list.appendChild(item);
        }
      } catch {}
    }

    async function addInstKbPaste() {
      const title = document.getElementById('inst-kb-title').value.trim();
      const content = document.getElementById('inst-kb-content').value.trim();
      if (!title || !content) { alert('Title and content required'); return; }
      await api(`/v1/instances/${currentInstance.id}/knowledge`, { method: 'POST', body: JSON.stringify({ title, content, source: 'paste' }) });
      hideInstKbForms(); document.getElementById('inst-kb-title').value = ''; document.getElementById('inst-kb-content').value = '';
      loadInstanceKnowledge();
    }

    async function addInstKbUrl() {
      const url = document.getElementById('inst-kb-url').value.trim();
      if (!url) { alert('URL required'); return; }
      await api(`/v1/instances/${currentInstance.id}/knowledge/ingest-url`, { method: 'POST', body: JSON.stringify({ url, title: document.getElementById('inst-kb-url-title').value.trim() || undefined }) });
      hideInstKbForms(); document.getElementById('inst-kb-url').value = '';
      loadInstanceKnowledge();
    }

    async function uploadInstKbFile(input) {
      const file = input.files?.[0]; if (!file) return;
      await api(`/v1/instances/${currentInstance.id}/knowledge`, { method: 'POST', body: JSON.stringify({ title: file.name, content: await file.text(), source: 'upload' }) });
      loadInstanceKnowledge(); input.value = '';
    }

    async function uploadInstFile(input) {
      const file = input.files?.[0]; if (!file || !currentInstance) return;
      const status = document.getElementById('inst-file-upload-status');
      status.textContent = `Uploading ${file.name}...`;
      status.classList.remove('hidden');
      try {
        const contentBase64 = await fileToBase64(file);
        const uploaded = await api(`/v1/instances/${currentInstance.id}/files`, {
          method: 'POST',
          body: JSON.stringify({
            name: file.name,
            contentBase64,
            mime_type: file.type || guessFileMimeType(file.name),
            path: `/${file.name}`,
            tags: [],
            extract_text: true,
          }),
        });
        const suffix = uploaded.extractionStatus === 'extracted'
          ? ` Indexed ${Number(uploaded.extractedTextLength || 0).toLocaleString()} characters.`
          : uploaded.extractionStatus === 'unsupported'
            ? ' Stored original. Text extraction is not available for this type.'
            : uploaded.extractionStatus === 'failed'
              ? ' Stored original. Text extraction failed.'
              : ' Stored original.';
        status.textContent = `Uploaded ${file.name}.${suffix}`;
        loadKbFiles();
      } catch (e) {
        status.textContent = `Upload failed: ${e.message}`;
      } finally {
        input.value = '';
        setTimeout(() => status.classList.add('hidden'), 5000);
      }
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.onerror = () => reject(reader.error || new Error('File read failed'));
        reader.readAsDataURL(file);
      });
    }

    function guessFileMimeType(name) {
      const ext = String(name || '').split('.').pop()?.toLowerCase();
      if (ext === 'pdf') return 'application/pdf';
      if (ext === 'json') return 'application/json';
      if (ext === 'csv') return 'text/csv';
      if (ext === 'md') return 'text/markdown';
      if (ext === 'html' || ext === 'htm') return 'text/html';
      if (ext === 'txt') return 'text/plain';
      return 'application/octet-stream';
    }
