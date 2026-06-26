// biome-ignore-all lint/correctness/noUnusedVariables: Console functions are called from inline HTML handlers.
// ── Profile ──────────────────────────────────────────────────

    let tokenVisible = false;

    function showProfile(updateUrl = true) {
      if (!user) return;
      if (updateUrl) rememberConsoleReturn(); // capture where we came from to return to
      showPage('profile-page');
      if (updateUrl) setConsoleUrl('/profile');

      document.getElementById('profile-avatar').src = user.avatar || '';
      document.getElementById('profile-name').textContent = user.name || user.login;
      document.getElementById('profile-login').textContent = `@${user.login}`;
      document.getElementById('profile-uid').textContent = user.id;

      const ghLink = document.getElementById('profile-gh-link');
      ghLink.innerHTML = '';
      const a = document.createElement('a');
      a.href = `https://github.com/${user.login}`;
      a.textContent = user.login;
      a.target = '_blank';
      a.rel = 'noopener';
      ghLink.appendChild(a);

      const rolesEl = document.getElementById('profile-roles');
      rolesEl.innerHTML = '';
      for (const r of (user.roles || [])) {
        const badge = document.createElement('span');
        badge.className = `role-badge role-${r}`;
        badge.textContent = r;
        rolesEl.appendChild(badge);
      }

      tokenVisible = false;
      const tokenEl = document.getElementById('profile-token');
      tokenEl.textContent = token ? `${token.slice(0, 12)}...` : 'Not signed in';

      // Profile edit fields
      document.getElementById('p-display-name').value = user.name || '';
      document.getElementById('p-bio').value = user.bio || '';
      document.getElementById('p-website').value = user.website || '';
      document.getElementById('p-twitter').value = user.twitter || '';
      document.getElementById('p-slack').value = user.slackWebhook === 'configured' ? '(configured — enter new URL to change)' : '';
      document.getElementById('profile-dev-link').href = `/developers/${user.login}/`;

      loadKeys();
      loadCandidateProfile();
    }

    // ── Candidate Profile (structured, reusable info agents fill forms with) ──
    let candidateProfileFields = [];
    async function loadCandidateProfile() {
      const box = document.getElementById('cp-fields');
      if (!box) return;
      try {
        const data = await api('/v1/profile');
        candidateProfileFields = data.fields || [];
        const p = data.profile || {};
        const fieldHtml = f => `
          <div${f.group === 'preferences' || f.key === 'website' || f.key === 'linkedin' || f.key === 'workAuthorization' ? ' style="grid-column:1/-1"' : ''}>
            <label style="font-size:0.74rem;color:var(--muted);font-weight:600">${esc(f.label)}${f.private ? ' <span style="color:var(--muted-soft)">· private</span>' : ''}</label>
            <input id="cp-${esc(f.key)}" value="${esc(p[f.key] || '')}" style="width:100%;background:var(--paper);border:1px solid var(--line);border-radius:0.4rem;padding:0.4rem 0.6rem;color:var(--ink);font-size:0.85rem">
          </div>`;
        const identity = candidateProfileFields.filter(f => f.group !== 'preferences');
        const prefs = candidateProfileFields.filter(f => f.group === 'preferences');
        box.innerHTML = identity.map(fieldHtml).join('')
          + (prefs.length ? `<div style="grid-column:1/-1;margin-top:0.6rem;font-weight:700;font-size:0.86rem">Job Preferences <span style="font-weight:400;color:var(--muted);font-size:0.76rem">— what you want; guides the agent's answers (location, work type, relocation)</span></div>` + prefs.map(fieldHtml).join('') : '');
      } catch (e) { box.innerHTML = '<p style="font-size:0.8rem;color:var(--muted)">Could not load candidate profile.</p>'; }
    }

    async function saveCandidateProfile() {
      const status = document.getElementById('cp-status');
      const body = {};
      for (const f of candidateProfileFields) { const el = document.getElementById('cp-' + f.key); if (el) body[f.key] = el.value.trim(); }
      try {
        await api('/v1/profile', { method: 'PUT', body: JSON.stringify(body) });
        if (status) { status.textContent = 'Saved ✓'; setTimeout(() => { status.textContent = ''; }, 2500); }
      } catch (e) { if (status) status.textContent = 'Save failed'; }
    }

    function copyToken() {
      if (!token) return;
      navigator.clipboard.writeText(token).then(() => {
        const btn = document.querySelector('.copy-btn');
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    }

    function toggleTokenVisibility() {
      if (!token) return;
      tokenVisible = !tokenVisible;
      document.getElementById('profile-token').textContent = tokenVisible ? token : `${token.slice(0, 12)}...`;
    }

    // ── Notifications ─────────────────────────────────────────

    async function loadNotifBadge() {
      try {
        const data = await api('/v1/notifications?unread=true&limit=1');
        const badge = document.getElementById('notif-badge');
        if (data.unreadCount > 0) {
          badge.textContent = String(data.unreadCount > 9 ? '9+' : data.unreadCount);
          badge.style.display = '';
        } else {
          badge.style.display = 'none';
        }
      } catch {}
    }

    async function showNotifications(updateUrl = true) {
      if (updateUrl) rememberConsoleReturn(); // capture where we came from to return to
      showPage('notifications-page');
      if (updateUrl) setConsoleUrl('/notifications');
      try {
        const data = await api('/v1/notifications');
        const list = document.getElementById('notif-list');
        const empty = document.getElementById('notif-empty');
        list.innerHTML = '';
        const items = data.notifications || [];
        empty.classList.toggle('hidden', items.length > 0);
        for (const n of items) {
          const item = document.createElement('div');
          item.style.cssText = `padding:0.75rem;background:var(--panel);border:1px solid var(--line);border-radius:0.5rem;${n.read ? 'opacity:0.6' : ''}`;
          item.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:start">
            <div>
              <div style="font-weight:600;font-size:0.88rem">${esc(n.title)}</div>
              <div style="font-size:0.82rem;color:var(--muted);margin-top:0.2rem">${esc(n.body)}</div>
              <div style="font-size:0.7rem;color:var(--muted-soft);margin-top:0.3rem">${new Date(n.created_at).toLocaleString()}</div>
            </div>
            ${!n.read ? '<span style="width:8px;height:8px;border-radius:50%;background:var(--accent);flex-shrink:0;margin-top:0.3rem"></span>' : ''}
          </div>`;
          if (!n.read) {
            item.style.cursor = 'pointer';
            item.addEventListener('click', async () => {
              await api(`/v1/notifications/${n.id}/read`, { method: 'POST' });
              showNotifications();
              loadNotifBadge();
            });
          }
          list.appendChild(item);
        }
      } catch {}
    }

    async function markAllRead() {
      await api('/v1/notifications/read-all', { method: 'POST' });
      showNotifications();
      loadNotifBadge();
    }

    async function saveProfile() {
      try {
        const slackVal = document.getElementById('p-slack').value;
        const updates = {
          display_name: document.getElementById('p-display-name').value,
          bio: document.getElementById('p-bio').value,
          website: document.getElementById('p-website').value,
          twitter: document.getElementById('p-twitter').value,
        };
        if (slackVal && !slackVal.startsWith('(')) updates.slack_webhook = slackVal;
        await api('/v1/auth/me', {
          method: 'PUT',
          body: JSON.stringify(updates),
        });
        alert('Profile saved!');
      } catch (e) { alert(e.message); }
    }

    // ── API Keys ─────────────────────────────────────────────────

    async function loadKeys() {
      const container = document.getElementById('keys-list');
      const loading = document.getElementById('keys-loading');
      try {
        const data = await api('/v1/keys/status');
        loading.style.display = 'none';
        container.innerHTML = '';
        for (const p of data.providers) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0.75rem;background:var(--paper);border:1px solid var(--line);border-radius:0.5rem';
          row.innerHTML = `<span style="font-size:0.88rem;font-weight:500;flex:1">${esc(p.name)}</span>
            <span style="font-size:0.75rem;color:${p.hasKey ? 'var(--green)' : 'var(--muted-soft)'}">${p.hasKey ? 'Stored' : 'Not set'}</span>`;

          if (p.hasKey) {
            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-outline btn-sm';
            delBtn.textContent = 'Remove';
            delBtn.addEventListener('click', async () => {
              if (!confirm(`Remove ${p.name} key?`)) return;
              await api(`/v1/keys/${p.id}`, { method: 'DELETE' });
              loadKeys();
            });
            row.appendChild(delBtn);
          } else {
            const addBtn = document.createElement('button');
            addBtn.className = 'btn btn-primary btn-sm';
            addBtn.textContent = 'Add Key';
            addBtn.addEventListener('click', () => {
              let accountId = null;
              if (p.id === 'cloudflare') {
                accountId = prompt('Cloudflare account ID:');
                if (!accountId) return;
              }
              const key = prompt(p.id === 'cloudflare' ? `${p.name} API token:` : `${p.name} API key:`);
              if (!key) return;
              api(`/v1/keys/${p.id}`, { method: 'PUT', body: JSON.stringify({ key, accountId }) })
                .then(() => loadKeys())
                .catch(e => alert(e.message));
            });
            row.appendChild(addBtn);
          }
          container.appendChild(row);
        }
      } catch (e) {
        loading.textContent = 'Failed to load keys';
      }
    }

