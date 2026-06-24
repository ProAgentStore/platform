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
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0b0b0f;display:flex;flex-direction:column';
      overlay.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;padding:8px 12px;background:#16161c;color:#fff;font-size:0.85rem;flex:0 0 auto">
          <span>🖥 Live browser — your mouse, scroll &amp; keyboard go through. Solve it, then <b>Done</b>.</span>
          <span id="takeover-status" style="color:#9ca3af;font-size:0.78rem">connecting…</span>
          <span style="flex:1"></span>
          <button id="takeover-fs" class="btn btn-outline btn-sm" style="color:#fff;border-color:#555">Fullscreen</button>
          <button id="takeover-done" class="btn btn-primary btn-sm">Done — submit</button>
          <button id="takeover-close" class="btn btn-outline btn-sm" style="color:#fff;border-color:#555">Close</button>
        </div>
        <div id="takeover-stage" style="flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden">
          <canvas id="takeover-frame" tabindex="0" style="max-width:100%;max-height:100%;cursor:crosshair;outline:none"></canvas>
        </div>`;
      document.body.appendChild(overlay);
      const img = overlay.querySelector('#takeover-frame');
      const ctx = img.getContext('2d');
      const statusEl = overlay.querySelector('#takeover-status');
      let alive = true;
      // CSS viewport of the real page (reported by the runner) — clicks map to
      // these coordinates, which is what CDP Input expects regardless of DPR.
      let pageW = 0, pageH = 0;
      let lastImg = null, cursorPos = null;

      // Redraw the latest frame plus a synthetic cursor (the screenshot doesn't
      // include the OS pointer, so we show where you're aiming).
      function render() {
        if (!lastImg) return;
        if (img.width !== lastImg.naturalWidth) { img.width = lastImg.naturalWidth; img.height = lastImg.naturalHeight; }
        ctx.drawImage(lastImg, 0, 0);
        if (cursorPos) {
          // cursorPos is in page (CSS) space, but the canvas is the frame's
          // device-pixel size (retina screencast = 2x). Scale the cursor so the
          // dot sits EXACTLY where the relayed click lands — otherwise on a 2x
          // display it draws at half-position and you aim at the wrong spot.
          const sx = pageW ? lastImg.naturalWidth / pageW : 1;
          const sy = pageH ? lastImg.naturalHeight / pageH : 1;
          const cx = cursorPos.x * sx, cy = cursorPos.y * sy;
          const r = 9 * sx;
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(245,158,11,0.95)'; ctx.lineWidth = 2 * sx; ctx.stroke();
          ctx.beginPath(); ctx.arc(cx, cy, r / 3.6, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(245,158,11,0.95)'; ctx.fill();
        }
      }

      async function poll() {
        while (alive) {
          try {
            const data = await api(`/v1/instances/${inst}/takeover/${encodeURIComponent(taskId)}/frame`);
            if (data && data.frame) {
              if (data.width) pageW = data.width;
              if (data.height) pageH = data.height;
              // Draw onto the canvas (overwrites in place — no blank flash).
              await new Promise((res) => {
                const im = new Image();
                im.onload = () => { lastImg = im; render(); res(); };
                im.onerror = () => res();
                im.src = data.frame;
              });
              statusEl.textContent = 'live';
            }
          } catch (e) { statusEl.textContent = 'frame error'; }
          await new Promise(r => setTimeout(r, 300));
        }
      }
      function sendInput(payload) {
        api(`/v1/instances/${inst}/takeover/${encodeURIComponent(taskId)}/input`, { method: 'POST', body: JSON.stringify(payload) }).catch(() => {});
      }
      function toCoords(ev) {
        const rect = img.getBoundingClientRect();
        const w = pageW || img.width || rect.width;
        const h = pageH || img.height || rect.height;
        return { x: Math.round((ev.clientX - rect.left) / rect.width * w), y: Math.round((ev.clientY - rect.top) / rect.height * h) };
      }
      // Forward the full mouse/scroll/keyboard stream to the real browser.
      // Stream moves only while dragging (button down) to avoid flooding with
      // idle hover events; a click still sends down→up so hover-on-click works.
      let lastMove = 0, dragging = false;
      img.addEventListener('mousemove', (ev) => {
        cursorPos = toCoords(ev); render();
        const now = Date.now(); if (now - lastMove < 60) return; lastMove = now;
        sendInput({ type: 'move', x: cursorPos.x, y: cursorPos.y });
      });
      img.addEventListener('mouseleave', () => { cursorPos = null; render(); });
      img.addEventListener('mousedown', (ev) => { ev.preventDefault(); img.focus(); dragging = true; const c = toCoords(ev); sendInput({ type: 'move', x: c.x, y: c.y }); sendInput({ type: 'down', x: c.x, y: c.y }); });
      window.addEventListener('mouseup', (ev) => { if (!dragging) return; dragging = false; ev.preventDefault?.(); const c = toCoords(ev); sendInput({ type: 'up', x: c.x, y: c.y }); });
      img.addEventListener('contextmenu', (ev) => ev.preventDefault());
      let lastWheel = 0;
      img.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const now = Date.now(); if (now - lastWheel < 45) return; lastWheel = now;
        const c = toCoords(ev); sendInput({ type: 'scroll', x: c.x, y: c.y, deltaX: Math.round(ev.deltaX), deltaY: Math.round(ev.deltaY) });
      }, { passive: false });

      // Mobile touch: 1 finger = tap/drag (down/move/up), 2 fingers = scroll.
      function touchCoords(t) {
        const rect = img.getBoundingClientRect();
        const w = pageW || img.width || rect.width;
        const h = pageH || img.height || rect.height;
        return { x: Math.round((t.clientX - rect.left) / rect.width * w), y: Math.round((t.clientY - rect.top) / rect.height * h) };
      }
      let touchMode = null, lastTouchY = 0, lastTouchX = 0;
      img.addEventListener('touchstart', (ev) => {
        ev.preventDefault();
        if (ev.touches.length >= 2) {
          touchMode = 'scroll';
          lastTouchY = ev.touches[0].clientY; lastTouchX = ev.touches[0].clientX;
          return;
        }
        touchMode = 'drag';
        const c = touchCoords(ev.touches[0]); cursorPos = c; render();
        sendInput({ type: 'move', x: c.x, y: c.y });
        sendInput({ type: 'down', x: c.x, y: c.y });
      }, { passive: false });
      img.addEventListener('touchmove', (ev) => {
        ev.preventDefault();
        const now = Date.now();
        if (touchMode === 'scroll' && ev.touches.length) {
          const dy = lastTouchY - ev.touches[0].clientY;
          const dx = lastTouchX - ev.touches[0].clientX;
          lastTouchY = ev.touches[0].clientY; lastTouchX = ev.touches[0].clientX;
          if (now - lastWheel < 45) return; lastWheel = now;
          const c = cursorPos || { x: 0, y: 0 };
          sendInput({ type: 'scroll', x: c.x, y: c.y, deltaX: Math.round(dx), deltaY: Math.round(dy) });
          return;
        }
        const c = touchCoords(ev.touches[0]); cursorPos = c; render();
        if (now - lastMove < 60) return; lastMove = now;
        sendInput({ type: 'move', x: c.x, y: c.y });
      }, { passive: false });
      img.addEventListener('touchend', (ev) => {
        ev.preventDefault();
        if (touchMode === 'drag' && cursorPos) sendInput({ type: 'up', x: cursorPos.x, y: cursorPos.y });
        touchMode = null;
      }, { passive: false });
      function onKey(ev) {
        if (!alive) return;
        if (ev.metaKey || ev.ctrlKey) return; // let browser shortcuts (Cmd+R, etc.) work
        if (ev.key && ev.key.length === 1) sendInput({ type: 'text', text: ev.key });
        else if (ev.key) sendInput({ type: 'key', key: ev.key, code: ev.code, keyCode: ev.keyCode });
        ev.preventDefault();
      }
      document.addEventListener('keydown', onKey, true);
      function teardown() {
        alive = false;
        document.removeEventListener('keydown', onKey, true);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        overlay.remove();
      }
      overlay.querySelector('#takeover-fs').addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else overlay.requestFullscreen().catch(() => {});
      });
      overlay.querySelector('#takeover-close').addEventListener('click', teardown);
      const doneBtn = overlay.querySelector('#takeover-done');
      doneBtn.addEventListener('click', async () => {
        doneBtn.disabled = true; doneBtn.textContent = 'Submitting…';
        try {
          const r = await api(`/v1/instances/${inst}/takeover/${encodeURIComponent(taskId)}/resume`, { method: 'POST' });
          if (r && r.submitted) { statusEl.textContent = 'submitted ✓'; teardown(); loadUnifiedBoard(); return; }
          statusEl.textContent = (r && r.reason) ? r.reason : 'Not submitted yet';
        } catch (e) { statusEl.textContent = 'submit error'; }
        doneBtn.disabled = false; doneBtn.textContent = 'Done — submit';
      });
      img.focus();
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
      const isError = task.status === 'needs_human' ? false : !!task.error;
      body.innerHTML = `
        <div class="rt-tabs" style="display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:0.85rem;flex-wrap:wrap">
          <button type="button" class="rt-tab" data-rt-tab="overview">Overview</button>
          <button type="button" class="rt-tab" data-rt-tab="activity">Activity${events.length ? ` (${events.length})` : ''}</button>
          <button type="button" class="rt-tab" data-rt-tab="input">Input</button>
          <button type="button" class="rt-tab" data-rt-tab="output">Output</button>
        </div>
        <div data-rt-panel="overview">
          <div class="runtime-detail-grid">
            ${runtimeDetailField('Task ID', task.id || '')}
            ${runtimeDetailField('Status', String(task.status || 'queued').replace('_', ' '))}
            ${runtimeDetailField('Created', formatTime(task.createdAt))}
            ${runtimeDetailField('Updated', formatTime(task.updatedAt || task.completedAt))}
          </div>
          ${task.approval?.prompt ? `<div class="runtime-detail-field"><div class="runtime-detail-label">Approval Prompt</div><div class="runtime-detail-value">${esc(task.approval.prompt)}</div></div>` : ''}
          ${task.error ? `<div class="runtime-detail-field"><div class="runtime-detail-label">${task.status === 'needs_human' ? '⚠️ Needs you' : 'Error'}</div><div class="runtime-detail-value" style="color:${isError ? 'var(--red)' : '#f59e0b'}">${esc(task.error)}</div></div>` : ''}
        </div>
        <div data-rt-panel="activity" hidden>${renderRuntimeHistory(events)}</div>
        <div data-rt-panel="input" hidden><pre class="runtime-detail-pre">${esc(safePrettyJson(task.input))}</pre></div>
        <div data-rt-panel="output" hidden><pre class="runtime-detail-pre">${esc(safePrettyJson(task.output))}</pre></div>`;
      const rtTabs = body.querySelectorAll('.rt-tab');
      const showTab = (name) => {
        rtTabs.forEach(t => {
          const on = t.dataset.rtTab === name;
          t.style.cssText = `background:none;border:none;border-bottom:2px solid ${on ? '#7c3aed' : 'transparent'};padding:0.4rem 0.75rem;cursor:pointer;font-size:0.82rem;font-weight:600;color:${on ? '#7c3aed' : 'var(--muted)'}`;
        });
        body.querySelectorAll('[data-rt-panel]').forEach(p => { p.hidden = p.dataset.rtPanel !== name; });
      };
      rtTabs.forEach(t => t.addEventListener('click', () => showTab(t.dataset.rtTab)));
      showTab(task.status === 'needs_human' ? 'overview' : 'overview');
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
      // Scope the activity feed to THIS task — its full history, every event,
      // newest first — always visible below the detail (not the global feed).
      const heading = document.getElementById('inst-activity-heading');
      if (heading) heading.textContent = 'Full task activity';
      renderInstanceRuntimeEvents(runtimeTaskEvents(task).slice().reverse());
      document.getElementById('inst-runtime-events')?.classList.remove('hidden');
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
      // Back on the board: restore the cross-task "Recent Activity" feed.
      const heading = document.getElementById('inst-activity-heading');
      if (heading) heading.textContent = 'Recent Activity';
      renderInstanceRuntimeEvents((currentRuntimeEvents || []).slice(0, 25));
      document.getElementById('inst-runtime-events')?.classList.remove('hidden');
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

    function eventIcon(type) {
      const t = String(type || '');
      if (t.includes('human_handoff') || t.includes('human_challenge')) return '🖥';
      if (t.endsWith('.failed')) return '❌';
      if (t.endsWith('.completed') || t.endsWith('.filled')) return '✅';
      if (t.endsWith('.cancelled')) return '🚫';
      if (t.endsWith('.approved')) return '👍';
      if (t.endsWith('.created')) return '🆕';
      if (t.endsWith('.running') || t.endsWith('.started')) return '▶️';
      if (t.startsWith('browser.goto')) return '🌐';
      if (t.startsWith('job.form')) return '📝';
      if (t.startsWith('file')) return '📎';
      return '•';
    }

    function renderInstanceRuntimeEvents(events) {
      const list = document.getElementById('inst-runtime-event-list');
      list.innerHTML = '';
      if (!events.length) {
        list.innerHTML = '<div style="color:var(--muted-soft);font-size:0.82rem">No activity yet.</div>';
        return;
      }
      for (const event of events) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:0.55rem;align-items:baseline;border-bottom:1px solid var(--line);padding:0.4rem 0;font-size:0.8rem';
        const label = String(event.type || 'event').replace(/[._]/g, ' ');
        row.innerHTML = `
          <span style="flex:0 0 auto;font-size:0.9rem;line-height:1">${eventIcon(event.type)}</span>
          <span style="flex:1;min-width:0">
            <span style="display:block;overflow-wrap:anywhere">${esc(event.message || label)}</span>
            <span style="color:var(--muted-soft);font-size:0.7rem">${esc(label)}</span>
          </span>
          <span style="flex:0 0 auto;color:var(--muted-soft);white-space:nowrap;font-size:0.72rem">${esc(formatTime(event.createdAt))}</span>`;
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
