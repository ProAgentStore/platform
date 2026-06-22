// biome-ignore-all lint/correctness/noUnusedVariables: Console functions are called from inline HTML handlers.
const API = 'https://api.proagentstore.online';
    const SESSION_KEY = 'pags:session';
    let token = null;
    let user = null;
    let currentAgent = null;
    let currentAgentTab = 'chat';
    let currentInstanceTab = 'chat';
    let routeApplying = false;
    let agentsView = 'board';
    const DEFAULT_AGENT_STATUS_BOARD_CONFIG = {
      summary: 'setup, review, live, and attention',
      columns: [
        {
          id: 'setup',
          title: 'Setup',
          color: 'var(--yellow)',
          empty: 'Draft agents appear here until they are ready to share.',
          statuses: ['inactive'],
          visibilities: ['draft'],
          excludeStatuses: ['active', 'error'],
        },
        {
          id: 'review',
          title: 'Review',
          color: 'var(--blue)',
          empty: 'Unlisted agents appear here for private testing.',
          visibilities: ['unlisted'],
          excludeStatuses: ['active', 'error'],
        },
        {
          id: 'live',
          title: 'Live',
          color: 'var(--green)',
          empty: 'Published or active agents appear here.',
          statuses: ['active'],
          visibilities: ['published'],
          excludeStatuses: ['error'],
        },
        {
          id: 'attention',
          title: 'Attention',
          color: 'var(--red)',
          empty: 'Agents with errors appear here.',
          statuses: ['error'],
        },
      ],
    };
    let agentStatusBoardConfig = structuredClone(DEFAULT_AGENT_STATUS_BOARD_CONFIG);

    // ── Auth ────────────────────────────────────────────────────

    function getToken() { return localStorage.getItem(SESSION_KEY); }
    function setToken(t) { t ? localStorage.setItem(SESSION_KEY, t) : localStorage.removeItem(SESSION_KEY); token = t; }

    function consoleUrlPrefix() {
      return window.location.hostname === 'console.proagentstore.online' ? '' : '/console';
    }

    function consolePath() {
      const prefix = consoleUrlPrefix();
      let path = window.location.pathname.replace(/\/+$/, '') || '/';
      if (prefix && (path === prefix || path.startsWith(prefix + '/'))) {
        path = path.slice(prefix.length) || '/';
      }
      return path || '/';
    }

    function setConsoleUrl(path, replace = false) {
      if (routeApplying) return;
      const clean = path.startsWith('/') ? path : `/${path}`;
      const url = `${consoleUrlPrefix()}${clean === '/' ? '/' : clean}`;
      if (`${window.location.pathname}${window.location.search}` === url) return;
      window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
    }

    function routeParts() {
      return consolePath().split('/').filter(Boolean).map(decodeURIComponent);
    }

    async function signIn(provider = 'github') {
      const res = await fetch(`${API}/v1/auth/config`);
      const config = await res.json();
      const returnTo = encodeURIComponent(window.location.href);
      const oauthUrl = provider === 'google' ? config.google_oauth_url : config.oauth_url;
      window.location.href = `${oauthUrl}?app_id=${config.app_id}&response_mode=${config.response_mode}&return_to=${returnTo}`;
    }

    function signOut() {
      setToken(null); user = null;
      showPage('login-page');
      setConsoleUrl('/', true);
      document.getElementById('user-nav').classList.add('hidden');
    }

    /** Show one page, hide all others. */
    function showPage(id) {
      for (const p of ['login-page', 'dashboard', 'agent-detail', 'instance-detail', 'application-detail', 'profile-page', 'notifications-page']) {
        document.getElementById(p).classList.toggle('hidden', p !== id);
      }
      document.body.classList.toggle('chat-active', id === 'application-detail');
    }

    async function handleOAuthCallback() {
      const params = new URLSearchParams(window.location.search);
      // FAS returns the token as fas_session in the query string
      const fasSession = params.get('fas_session');
      if (!fasSession) return false;

      try {
        // Exchange FAS token for a PAGS token
        const res = await api('/v1/auth/exchange', {
          method: 'POST',
          body: JSON.stringify({ fas_session: fasSession }),
        }, true);
        if (res.token) {
          setToken(res.token);
          if (res.user) user = res.user;
          window.history.replaceState({}, '', window.location.pathname);
          return true;
        }
      } catch (e) { console.error('OAuth exchange error:', e); }
      window.history.replaceState({}, '', window.location.pathname);
      return false;
    }

    async function checkAuth() {
      token = getToken();
      if (!token) return false;
      try {
        const data = await api('/v1/auth/me');
        if (data.id) {
          user = data;
          setBoardConfig(user.boardConfig || DEFAULT_AGENT_STATUS_BOARD_CONFIG);
          return true;
        }
      } catch { setToken(null); }
      return false;
    }

    function showUser() {
      document.getElementById('user-nav').classList.remove('hidden');
      document.getElementById('user-avatar').src = user.avatar;
      document.getElementById('user-login').textContent = user.login;
    }

    // ── API helper ──────────────────────────────────────────────

    async function api(path, opts = {}, noAuth = false) {
      const headers = { 'Content-Type': 'application/json' };
      if (!noAuth && token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${API}${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }

    // ── Dashboard ───────────────────────────────────────────────

    async function loadAgents() {
      document.getElementById('agents-loading').classList.remove('hidden');
      try {
        const data = await api('/v1/agents/my/agents');
        const agents = data.agents || [];
        renderAgents(agents);
      } catch (e) { console.error(e); }
      document.getElementById('agents-loading').classList.add('hidden');
    }

    function renderAgents(agents) {
      const empty = document.getElementById('agents-empty');
      const summary = document.getElementById('agents-board-summary');
      empty.classList.toggle('hidden', agents.length > 0);
      summary.textContent = agents.length
        ? `${agents.length} agent${agents.length === 1 ? '' : 's'} across ${agentStatusBoardConfig.summary || 'configured columns'}`
        : 'No agent status yet';
      renderKanbanBoard({
        boardId: 'agents-board',
        items: agents,
        columns: agentStatusBoardConfig.columns,
        renderCard: agentStatusCard,
      });
      renderAgentList(agents);
      applyAgentsView();
    }

    function agentLifecycle(a) {
      return firstMatchingColumn(a)?.id || 'setup';
    }

    function agentLifecycleLabel(a) {
      return firstMatchingColumn(a)?.title || 'Unmatched';
    }

    function renderKanbanBoard({ boardId, items, columns, renderCard, columnForItem }) {
      const board = document.getElementById(boardId);
      board.innerHTML = '';
      for (const col of columns) {
        const resolveColumn = columnForItem || (item => firstMatchingColumn(item, columns));
        const columnItems = items.filter(item => resolveColumn(item)?.id === col.id);
        const column = document.createElement('section');
        column.className = 'kanban-column';
        column.setAttribute('aria-label', `${col.title} column`);
        column.innerHTML = `
          <div class="kanban-header">
            <div class="kanban-title"><span class="kanban-dot" style="background:${col.color}"></span>${esc(col.title)}</div>
            <span class="kanban-count">${columnItems.length}</span>
          </div>
          <div class="kanban-items"></div>`;
        const list = column.querySelector('.kanban-items');
        if (!columnItems.length) {
          list.innerHTML = `<div class="kanban-empty">${esc(col.empty)}</div>`;
        } else {
          for (const item of columnItems) list.appendChild(renderCard(item));
        }
        board.appendChild(column);
      }
    }

    function columnMatchesAgent(column, agent) {
      const status = agent.status || 'inactive';
      const visibility = agent.visibility || 'draft';
      const excludeStatuses = Array.isArray(column.excludeStatuses) ? column.excludeStatuses : [];
      const excludeVisibilities = Array.isArray(column.excludeVisibilities) ? column.excludeVisibilities : [];
      if (excludeStatuses.includes(status) || excludeVisibilities.includes(visibility)) return false;
      if (column.catchAll) return true;
      const statuses = Array.isArray(column.statuses) ? column.statuses : [];
      const visibilities = Array.isArray(column.visibilities) ? column.visibilities : [];
      return statuses.includes(status) || visibilities.includes(visibility);
    }

    function safeBoardColor(value) {
      const color = String(value || '').trim().slice(0, 40);
      if (/^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([0-9, .%]+\)|hsla?\([0-9, .%]+\)|var\(--[a-z0-9-]+\))$/i.test(color)) {
        return color;
      }
      return 'var(--accent)';
    }

    function firstMatchingColumn(agent, columns = agentStatusBoardConfig.columns) {
      return columns.find(col => columnMatchesAgent(col, agent)) || columns[0];
    }

    function normalizeBoardConfig(config) {
      const source = config && Array.isArray(config.columns) ? config : DEFAULT_AGENT_STATUS_BOARD_CONFIG;
      const columns = source.columns
        .filter(col => col?.id && col.title)
        .slice(0, 8)
        .map(col => ({
          id: String(col.id).replace(/[^a-z0-9_-]/gi, '-').toLowerCase(),
          title: String(col.title).slice(0, 40),
          color: safeBoardColor(col.color || 'var(--accent)'),
          empty: String(col.empty || 'No agents in this column.').slice(0, 160),
          statuses: Array.isArray(col.statuses) ? col.statuses.map(String).slice(0, 10) : [],
          visibilities: Array.isArray(col.visibilities) ? col.visibilities.map(String).slice(0, 10) : [],
          excludeStatuses: Array.isArray(col.excludeStatuses) ? col.excludeStatuses.map(String).slice(0, 10) : [],
          excludeVisibilities: Array.isArray(col.excludeVisibilities) ? col.excludeVisibilities.map(String).slice(0, 10) : [],
          catchAll: Boolean(col.catchAll),
        }));
      if (!columns.length) throw new Error('Board config needs at least one column.');
      return {
        summary: String(source.summary || columns.map(c => c.title.toLowerCase()).join(', ')).slice(0, 120),
        columns,
      };
    }

    function setBoardConfig(config) {
      agentStatusBoardConfig = normalizeBoardConfig(config);
      document.getElementById('board-config-json').value = JSON.stringify(agentStatusBoardConfig, null, 2);
    }

    function toggleBoardConfig() {
      const form = document.getElementById('board-config-form');
      form.classList.toggle('hidden');
      if (!form.classList.contains('hidden')) {
        document.getElementById('board-config-json').value = JSON.stringify(agentStatusBoardConfig, null, 2);
        document.getElementById('board-config-error').classList.add('hidden');
      }
    }

    async function saveBoardConfig() {
      const error = document.getElementById('board-config-error');
      try {
        const parsed = JSON.parse(document.getElementById('board-config-json').value);
        const config = normalizeBoardConfig(parsed);
        await api('/v1/auth/me', {
          method: 'PUT',
          body: JSON.stringify({ board_config: config }),
        });
        user.boardConfig = config;
        setBoardConfig(config);
        document.getElementById('board-config-form').classList.add('hidden');
        loadAgents();
      } catch (e) {
        error.textContent = e.message;
        error.classList.remove('hidden');
      }
    }

    async function resetBoardConfig() {
      setBoardConfig(DEFAULT_AGENT_STATUS_BOARD_CONFIG);
      await api('/v1/auth/me', {
        method: 'PUT',
        body: JSON.stringify({ board_config: DEFAULT_AGENT_STATUS_BOARD_CONFIG }),
      });
      if (user) user.boardConfig = DEFAULT_AGENT_STATUS_BOARD_CONFIG;
      document.getElementById('board-config-form').classList.add('hidden');
      loadAgents();
    }

    function agentStatusCard(a) {
      const card = document.createElement('article');
      card.className = 'kanban-card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Open ${a.name}`);
      card.innerHTML = `
        <h3>${esc(a.name)}</h3>
        <p>${esc(a.description || 'No description')}</p>
        <div style="font-size:0.7rem;color:var(--muted-soft);margin-bottom:0.45rem">Updated ${esc(formatTime(a.updated_at))}</div>
        <div class="kanban-card-meta">
          <span class="tag tag-${esc(a.visibility || 'draft')}">${esc(a.visibility || 'draft')}</span>
          <span class="tag tag-${esc(a.status || 'inactive')}">${esc(a.status || 'inactive')}</span>
          <span class="tag tag-cat">${esc(a.category || 'general')}</span>
        </div>`;
      card.addEventListener('click', () => openAgent(a.id));
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openAgent(a.id);
        }
      });
      return card;
    }

    function renderAgentList(agents) {
        const list = document.getElementById('agents-list');
        list.innerHTML = '';
        for (const a of agents) {
            const card = document.createElement('div');
            card.className = 'agent-card';
            card.innerHTML = `<h3>${esc(a.name)}</h3>
              <p>${esc(a.description || 'No description')}</p>
              <div class="agent-meta">
                <span class="tag tag-${esc(a.visibility)}">${esc(a.visibility)}</span>
                <span class="tag tag-${esc(agentLifecycle(a))}">${esc(agentLifecycleLabel(a))}</span>
                <span class="tag tag-cat">${esc(a.category)}</span>
              </div>`;
            card.addEventListener('click', () => openAgent(a.id));
            list.appendChild(card);
        }
    }

    function switchAgentsView(view) {
      agentsView = view === 'list' ? 'list' : 'board';
      applyAgentsView();
    }

    function applyAgentsView() {
      document.getElementById('agents-board').classList.toggle('hidden', agentsView !== 'board');
      document.getElementById('agents-list').classList.toggle('hidden', agentsView !== 'list');
      document.getElementById('agents-view-board').classList.toggle('active', agentsView === 'board');
      document.getElementById('agents-view-list').classList.toggle('active', agentsView === 'list');
    }

    function showDashboard(tab = 'agents', updateUrl = true) {
      showPage('dashboard');
      document.body.classList.remove('chat-active');
      document.getElementById('inst-nav-slot').innerHTML = '';
      currentAgent = null;
      currentInstance = null;
      loadAgents();
      switchDashTab(tab, false);
      if (updateUrl) setConsoleUrl(`/${tab === 'agents' ? 'agents' : tab}`);
    }

    function toggleCreateForm() {
      document.getElementById('create-form').classList.toggle('hidden');
    }

    async function createAgent() {
      const slug = document.getElementById('f-slug').value.trim();
      const name = document.getElementById('f-name').value.trim();
      if (!slug || !name) { showError('create-error', 'Slug and name required'); return; }

      try {
        await api('/v1/agents', {
          method: 'POST',
          body: JSON.stringify({
            slug, name,
            description: document.getElementById('f-desc').value,
            category: document.getElementById('f-category').value,
            model: document.getElementById('f-model').value,
            personality: document.getElementById('f-personality').value,
            goal: document.getElementById('f-goal').value,
          }),
        });
        toggleCreateForm();
        ['f-slug','f-name','f-desc','f-personality','f-goal'].forEach(id => {
          document.getElementById(id).value = '';
        });
        loadAgents();
      } catch (e) { showError('create-error', e.message); }
    }

    // ── Agent detail ────────────────────────────────────────────

    async function openAgent(id, tab = 'chat', updateUrl = true) {
      try {
        const agent = await api(`/v1/agents/${id}`);
        currentAgent = agent;
        showPage('agent-detail');
        document.getElementById('detail-name').textContent = agent.name;
        document.getElementById('detail-slug').textContent = agent.slug;
        document.getElementById('detail-desc').textContent = agent.description;
        if (agent.icon_bg) document.getElementById('detail-icon').style.background = agent.icon_bg;

        // Also fetch DO state for guardrails/personality
        let doState = {};
        try {
          const stub = await api(`/v1/agents/${agent.id}/state`);
          doState = stub;
        } catch {}

        // Settings — identity
        document.getElementById('s-name').value = agent.name;
        document.getElementById('s-desc').value = agent.description;
        document.getElementById('s-category').value = agent.category;
        document.getElementById('s-visibility').value = agent.visibility;
        document.getElementById('s-model').value = agent.model || '@cf/meta/llama-3.2-3b-instruct';
        document.getElementById('s-personality').value = doState.personality || '';
        document.getElementById('s-goal').value = doState.goal || '';
        document.getElementById('s-welcome').value = doState.welcomeMessage || '';

        // Settings — guardrails
        const gr = doState.guardrails || {};
        document.getElementById('s-topics').value = gr.topicRestrictions || '';
        document.getElementById('s-blocked').value = (gr.blockedTerms || []).join(', ');
        document.getElementById('s-style').value = gr.responseStyle || '';
        document.getElementById('s-maxlen').value = gr.maxResponseLength || '';
        document.getElementById('s-citations').checked = gr.requireCitations || false;

        switchTab(tab, false);
        loadMessages();
        loadKnowledge();
        loadMemory();
        loadTasks();
        loadAnalytics();
        loadVersions();
        loadOps();
        if (updateUrl) setConsoleUrl(`/agents/${encodeURIComponent(agent.id)}/${tab}`);
      } catch (e) { alert(e.message); }
    }

	    function switchTab(name, updateUrl = true) {
	      const container = document.getElementById('agent-detail');
	      container.querySelectorAll('.tab').forEach(t => {
	        t.classList.toggle('active', t.textContent.toLowerCase() === name);
	      });
	      container.querySelectorAll('.tab-panel').forEach(p => {
	        p.classList.toggle('active', p.id === `tab-${name}`);
	      });
	      document.body.classList.toggle('chat-active', name === 'chat');
	      currentAgentTab = name;
	      if (name === 'ops') loadOps();
	      if (updateUrl && currentAgent) setConsoleUrl(`/agents/${encodeURIComponent(currentAgent.id)}/${name}`);
	    }

    // ── Chat ────────────────────────────────────────────────────

    async function loadMessages() {
      try {
        const data = await api(`/v1/agents/${currentAgent.id}/messages`);
        const container = document.getElementById('chat-messages');
        container.innerHTML = '';
        for (const m of (data.messages || [])) {
          const content = m.role === 'assistant' ? renderMd(m.content) : esc(m.content);
          container.innerHTML += chatBubble(m.role, m.content);
        }
        container.scrollTop = container.scrollHeight;
      } catch {}
    }

    async function sendMessage() {
      const input = document.getElementById('chat-input');
      const message = input.value.trim();
      if (!message) return;
      input.value = '';

      const container = document.getElementById('chat-messages');
      container.innerHTML += chatBubble("user", message);
      container.scrollTop = container.scrollHeight;
      document.getElementById('chat-thinking').classList.remove('hidden');

      try {
        const data = await api(`/v1/agents/${currentAgent.id}/chat`, {
          method: 'POST',
          body: JSON.stringify({ message }),
        });
        if (data.message) {
          container.innerHTML += chatBubble("assistant", data.message.content);
        }
      } catch (e) {
        container.innerHTML += chatBubble("system", "Error: " + e.message);
      }
      document.getElementById('chat-thinking').classList.add('hidden');
      container.scrollTop = container.scrollHeight;
    }

    // ── Dashboard tabs ─────────────────────────────────────────

    function switchDashTab(tab, updateUrl = true) {
      for (const t of ['agents', 'instances', 'dashboard']) {
        document.getElementById('dash-' + t).classList.toggle('hidden', t !== tab);
        document.getElementById('dash-tab-' + t).classList.toggle('active', t === tab);
      }
      if (tab === 'instances') loadInstances();
      if (tab === 'dashboard') loadDashboard();
      if (updateUrl) setConsoleUrl(`/${tab === 'agents' ? 'agents' : tab}`);
    }

    async function loadDashboard() {
      try {
        const [creator, usage] = await Promise.all([
          api('/v1/dashboard/creator'),
          api('/v1/dashboard/usage'),
        ]);
        document.getElementById('d-agents').textContent = String(creator.totalAgents || 0);
        document.getElementById('d-subs').textContent = String(creator.totalSubscribers || 0);
        document.getElementById('d-usage').textContent = String(creator.totalUsage || 0);
        document.getElementById('d-instances').textContent = String(usage.activeInstances || 0);

        const table = document.getElementById('d-agent-table');
        table.innerHTML = '';
        for (const a of (creator.agents || [])) {
          table.innerHTML += `<div style="display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid var(--line);font-size:0.82rem">
            <span>${esc(a.name)}</span>
            <span style="color:var(--muted)">${a.subscribers || 0} subs · ${a.usage_count || 0} events</span>
          </div>`;
        }
        if (!(creator.agents || []).length) table.innerHTML = '<span style="color:var(--muted-soft);font-size:0.82rem">No agents yet</span>';

        const chart = document.getElementById('d-daily');
        chart.innerHTML = '';
        const daily = usage.dailyUsage || [];
        const max = Math.max(1, ...daily.map(d => d.count));
        for (const d of daily) {
          const bar = document.createElement('div');
          bar.style.cssText = `flex:1;min-width:3px;background:var(--accent);border-radius:2px 2px 0 0;height:${Math.max(4, (d.count / max) * 100)}%`;
          bar.title = `${d.day}: ${d.count}`;
          chart.appendChild(bar);
        }
        if (!daily.length) chart.innerHTML = '<span style="color:var(--muted-soft);font-size:0.82rem">No usage data yet</span>';
      } catch (e) { console.error('Dashboard error:', e); }
    }

