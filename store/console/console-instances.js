// biome-ignore-all lint/correctness/noUnusedVariables: Console functions are called from inline HTML handlers.
// ── Instances (client view) ──────────────────────────────

    let currentInstance = null;
    let currentRuntimeTasks = [];
    let currentRuntimeEvents = [];
    let currentRuntimeTaskId = null;
    let runtimeBadgeTimer = null;
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
      // Keep the runner badge live: re-probe every 4s while this instance is open,
      // so it flips online↔offline within seconds of the runner coming up or dying.
      if (runtimeBadgeTimer) clearInterval(runtimeBadgeTimer);
      runtimeBadgeTimer = setInterval(() => {
        const page = document.getElementById('instance-detail');
        if (currentInstance && page && !page.classList.contains('hidden')) checkRuntimeStatus();
      }, 4000);
      if (updateUrl) {
        const detailPath = tab === 'board' && runtimeTaskId
          ? `/instances/${encodeURIComponent(instanceId)}/board/tasks/${encodeURIComponent(runtimeTaskId)}`
          : `/instances/${encodeURIComponent(instanceId)}/${tab}`;
        setConsoleUrl(detailPath);
      }
    }

    function switchKbTab(name) {
      document.querySelectorAll('#inst-tab-knowledge [data-kb-tab]').forEach(t => t.classList.toggle('active', t.dataset.kbTab === name));
      document.querySelectorAll('#inst-tab-knowledge [data-kb-panel]').forEach(p => { p.hidden = p.dataset.kbPanel !== name; });
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
      if (name === 'board') {
        // Clicking the Board tab while viewing a task detail must return to the board.
        if (currentRuntimeTaskId) { currentRuntimeTaskId = null; hideRuntimeTaskDetail(); }
        loadUnifiedBoard();
        startRuntimePolling();
      }
      if (name === 'knowledge') loadKnowledgeBase();
      if (name !== 'board') {
        currentRuntimeTaskId = null;
        hideRuntimeTaskDetail();
        stopRuntimePolling();
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

    // ── Real-time activity polling ──────────────────────────────
    // No websocket needed: poll tasks + events on a short interval and update the
    // view in place (no loading flash). Drives the live activity line on each card
    // and the live Activity list in the open task detail.
    let runtimePollTimer = null;
    const ACTIVE_TASK_STATUSES = ['queued', 'waiting', 'running', 'needs_human'];

    function boardIsVisible() {
      const panel = document.getElementById('inst-tab-board');
      return !!panel && panel.classList.contains('active') && !document.hidden;
    }

    function startRuntimePolling() {
      stopRuntimePolling();
      runtimePollTimer = setInterval(refreshRuntimeSilently, 2500);
    }
    function stopRuntimePolling() {
      if (runtimePollTimer) { clearInterval(runtimePollTimer); runtimePollTimer = null; }
    }

    async function refreshRuntimeSilently() {
      if (!currentInstance || !boardIsVisible()) { stopRuntimePolling(); return; }
      try {
        const [tasksRes, eventsRes, appsRes] = await Promise.allSettled([
          api(`/v1/instances/${currentInstance.id}/tasks`),
          api(`/v1/instances/${currentInstance.id}/task-events?limit=500`),
          api(`/v1/instances/${currentInstance.id}/collections/applications/records?limit=100`),
        ]);
        if (tasksRes.status === 'fulfilled') currentRuntimeTasks = tasksRes.value.tasks || currentRuntimeTasks;
        if (eventsRes.status === 'fulfilled') currentRuntimeEvents = eventsRes.value.events || currentRuntimeEvents;
        if (appsRes.status === 'fulfilled') currentAppRecords = appsRes.value.records || currentAppRecords;
        if (currentRuntimeTaskId) {
          const task = currentRuntimeTasks.find(t => t.id === currentRuntimeTaskId);
          if (task) renderInstanceRuntimeEvents(runtimeTaskEvents(task).slice().reverse()); // live Activity tab
        } else {
          renderInstanceTaskBoard(currentRuntimeTasks); // live cards + running activity line
        }
        // Nothing active → stop (loadUnifiedBoard restarts it on next view).
        if (!currentRuntimeTasks.some(t => ACTIVE_TASK_STATUSES.includes(t.status))) stopRuntimePolling();
      } catch (e) { /* keep polling */ }
    }

    function renderInstanceTaskBoard(tasks) {
      // ALWAYS show every column (a stable board). The Active/All filter only hides
      // finished/old task CARDS — it never removes columns.
      const cols = INSTANCE_RUNTIME_COLUMNS;
      const activeIds = ['queued', 'waiting', 'running', 'needs_approval', 'needs_human'];
      const allowed = new Set(cols.flatMap(c => c.statuses));
      const all = (tasks || []).filter(t => allowed.has(t.status));
      const shown = showAllRuntimeTasks ? all : all.filter(t => activeIds.includes(t.status));
      renderKanbanBoard({
        boardId: 'inst-unified-board',
        items: shown,
        columns: cols,
        renderCard: runtimeTaskCard,
        columnForItem: task => cols.find(col => col.statuses.includes(task.status)) || cols[0],
      });
      // Re-append the application columns from cache (renderKanbanBoard cleared the
      // board). Synchronous → the columns never blink/disappear on a poll.
      renderApplicationColumns();
      // Reflect the count of hidden (history) tasks on the prominent toggle.
      const hidden = all.length - shown.length;
      const allBtn = document.querySelector('#board-filter-toggle [data-board-filter="all"]');
      if (allBtn) allBtn.textContent = hidden > 0 && !showAllRuntimeTasks ? `All (${hidden} hidden)` : 'All';
    }

    // Prominent Active/All board filter (segmented control in the toolbar).
    function setBoardFilter(mode) {
      showAllRuntimeTasks = (mode === 'all');
      document.querySelectorAll('#board-filter-toggle [data-board-filter]').forEach(b => b.classList.toggle('active', b.dataset.boardFilter === mode));
      renderInstanceTaskBoard(currentRuntimeTasks);
    }

    // Live Browser: remote view + control of a paused (needs_human) task, so the
    // For an apply task, derive "<job slug> · <host>" from the job URL.
    function runtimeTaskTitle(task) {
      if (task && task.title) return task.title;
      const url = task && task.input && (task.input.url || task.input.URL);
      if (url) {
        try {
          const u = new URL(url);
          const host = u.hostname.replace(/^(www|careers|job-boards|jobs|boards|apply)\./, '');
          const slug = u.pathname.split('/').filter(Boolean)
            .find(s => s.length > 8 && /[a-z]{3}/i.test(s) && !/^en[_-]|^\d+$/i.test(s));
          const nice = slug
            ? slug.replace(/[-_]+/g, ' ').replace(/\b(en|gb|us|au|vic|nsw|qld|wa|sa|tas|act|nt)\b/gi, '').replace(/\s{2,}/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase())
            : '';
          return nice ? `${nice} · ${host}` : `Job application · ${host}`;
        } catch (e) { /* fall through */ }
      }
      const t = (task && task.type) || 'Runtime task';
      return t.indexOf('job.apply') === 0 ? 'Job application' : t;
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
      // Stop halts the agent at the next step (any in-flight action); shown while running.
      const stoppable = ['queued', 'waiting', 'running', 'needs_approval', 'needs_human'].includes(task.status)
        ? `<button type="button" class="btn btn-outline btn-sm" data-task-action="cancel" data-task-id="${esc(task.id)}" title="Stop the agent now">⏹ Stop</button>`
        : '';
      const del = `<button type="button" class="btn btn-outline btn-sm" data-task-action="delete" data-task-id="${esc(task.id)}" title="Delete this ticket">🗑</button>`;
      const takeover = task.status === 'needs_human'
        ? `<button type="button" class="btn btn-primary btn-sm" data-task-action="takeover" data-task-id="${esc(task.id)}">🖥 Take over</button>`
        : '';
      // Live "running line": the agent's most recent activity, updated each poll.
      const taskEvents = runtimeTaskEvents(task);
      const latest = taskEvents.length ? taskEvents[taskEvents.length - 1] : null;
      const live = ACTIVE_TASK_STATUSES.includes(task.status);
      const latestMsg = latest ? String(latest.message || latest.type || '') : '';
      const ticker = latestMsg
        ? `<div class="rt-ticker${live ? ' rt-ticker-live' : ''}" title="${escAttr(latestMsg)}">${live ? '<span class="rt-dot"></span>' : ''}<span class="rt-ticker-text">${esc(latestMsg)}</span></div>`
        : '';
      card.innerHTML = `
        <h3>${esc(runtimeTaskTitle(task))}</h3>
        <p>${esc(task.approval?.prompt || (task.input && task.input.url) || task.id)}</p>
        <div style="font-size:0.7rem;color:var(--muted-soft);margin-bottom:0.45rem">Updated ${esc(formatTime(task.updatedAt || task.createdAt))}</div>
        <div class="kanban-card-meta">
          <span class="tag tag-${esc(task.status || 'queued')}">${esc(String(task.status || 'queued').replace('_', ' '))}</span>
          ${task.requiresApproval ? '<span class="tag">approval</span>' : ''}
        </div>
        ${ticker}
        ${error}
        ${output ? `<div style="font-size:0.72rem;color:var(--muted);line-height:1.45;margin-top:0.45rem;overflow-wrap:anywhere">${esc(output)}${output.length >= 180 ? '...' : ''}</div>` : ''}
        <div style="display:flex;gap:0.4rem;margin-top:0.65rem;flex-wrap:wrap">${takeover}${approval}${stoppable}${del}</div>`;
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


    // ── Unified Board ──────────────────────────────────────────
    async function loadUnifiedBoard() {
      await loadInstanceRuntime();
      await loadInstanceApplications();
      startRuntimePolling(); // live activity while the board is open
    }

    // (KB page + Applications kanban moved to console-instances-apps.js)
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
        // /runtime/status actively PROBES the runner (health + capabilities) and
        // flips it online/offline — /runtime alone returns the stale "registered".
        const data = await api(`/v1/instances/${currentInstance.id}/runtime/status`).catch(() => api(`/v1/instances/${currentInstance.id}/runtime`));
        const rt = data.runtime;
        const status = rt ? String(rt.status || 'registered') : 'none';
        if (status === 'online') {
          badge.textContent = '● Runner online';
          badge.title = rt.endpointUrl || rt.endpoint_url || '';
          badge.style.background = 'rgba(34,197,94,0.15)'; badge.style.color = 'var(--green)';
        } else if (status === 'offline') {
          badge.textContent = '○ Runner offline';
          badge.title = 'The runner isn’t reachable — start it: pags up';
          badge.style.background = 'rgba(239,68,68,0.12)'; badge.style.color = 'var(--red)';
        } else if (rt?.endpointUrl || rt?.endpoint_url) {
          badge.textContent = '● Runner registered';
          badge.title = 'Registered but not probed yet';
          badge.style.background = 'rgba(234,179,8,0.12)'; badge.style.color = 'var(--yellow)';
        } else {
          badge.textContent = '○ No runner';
          badge.title = ''; badge.style.background = 'var(--line)'; badge.style.color = 'var(--muted)';
        }
      } catch {
        badge.textContent = '○ Runner offline';
        badge.title = 'The runner isn’t reachable — start it: pags up';
        badge.style.background = 'rgba(239,68,68,0.12)'; badge.style.color = 'var(--red)';
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
