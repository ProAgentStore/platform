// biome-ignore-all lint/correctness/noUnusedVariables: called across console files (shared global scope).
// ── Runtime task detail: detail view, activity list, copy-log, task actions ──
// Split out of console-instances.js. Shared global scope (classic-script sibling).

    function renderRuntimeTaskDetail(task, scrollIntoView = false) {
      const section = document.getElementById('runtime-task-detail');
      const title = document.getElementById('runtime-task-detail-title');
      const status = document.getElementById('runtime-task-detail-status');
      const body = document.getElementById('runtime-task-detail-body');
      const actions = document.getElementById('runtime-task-detail-actions');
      const events = runtimeTaskEvents(task);
      title.textContent = runtimeTaskTitle(task);
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

    // Copy the open task's ENTIRE activity log as JSON (to paste for analysis).
    async function copyTaskActivity(evt) {
      const btn = evt?.target?.closest('button');
      if (!currentRuntimeTaskId) return;
      const task = (currentRuntimeTasks || []).find(t => t.id === currentRuntimeTaskId) || { id: currentRuntimeTaskId };
      const events = runtimeTaskEvents(task).map(e => ({
        type: e.type,
        message: e.message || '',
        data: e.data || undefined,
        timestamp: e.createdAt || e.created_at,
      }));
      const payload = { taskId: task.id, type: task.type, status: task.status, url: task.input && task.input.url, count: events.length, events };
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        if (btn) { const o = btn.innerHTML; btn.textContent = `Copied ${events.length} ✓`; setTimeout(() => { btn.innerHTML = o; }, 1800); }
      } catch (e) { alert('Copy failed: ' + e.message); }
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
      // Board shows only the kanban — per-task activity lives in each task's
      // detail (Activity tab), so don't clutter the board with a cross-task feed.
      document.getElementById('inst-runtime-events')?.classList.add('hidden');
    }

    async function handleRuntimeTaskAction(taskId, action, sourceButton = null) {
      if (!currentInstance || !taskId || !action) return;
      if (action === 'cancel' && !confirm('Stop the agent on this task now?')) return;
      if (action === 'delete') {
        if (!confirm('Delete this ticket? This stops the agent and removes the task.')) return;
        try {
          await api(`/v1/instances/${currentInstance.id}/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
          if (currentRuntimeTaskId === taskId) closeRuntimeTaskDetail();
          await loadInstanceRuntime();
        } catch (e) { alert('Delete failed: ' + e.message); }
        return;
      }
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
