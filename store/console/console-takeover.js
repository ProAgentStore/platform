// biome-ignore-all lint/correctness/noUnusedVariables: called from inline HTML handlers + console-instances.js (shared global scope).
// ── Live Browser takeover + ask-and-hold input (split out of console-instances.js) ──

    // user can solve a CAPTCHA / human challenge the agent can't.
    // Ask-and-hold: the agent needs a value (not a browser action) → show an input
    // box, not the live screen. The value is saved to the profile + the agent resumes.
    function openNeedsInput(taskId, field) {
      const inst = currentInstance && currentInstance.id;
      if (!inst) return;
      const overlay = document.createElement('div');
      overlay.id = 'takeover-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center';
      overlay.innerHTML = `
        <div class="create-form" style="max-width:440px;width:90%;background:var(--paper);padding:1.25rem;border-radius:0.6rem">
          <h3 style="margin:0 0 0.4rem;font-size:1rem">The agent needs a value from you</h3>
          <p style="font-size:0.85rem;color:var(--muted);margin:0 0 0.75rem">${esc(field)}</p>
          <input id="ni-value" placeholder="Enter ${esc(field)}" style="width:100%">
          <div style="display:flex;gap:0.5rem;margin-top:0.75rem">
            <button id="ni-submit" class="btn btn-primary btn-sm">Submit &amp; continue</button>
            <button id="ni-cancel" class="btn btn-outline btn-sm">Cancel</button>
          </div>
          <div id="ni-status" style="font-size:0.78rem;color:var(--muted);margin-top:0.5rem"></div>
        </div>`;
      document.body.appendChild(overlay);
      const input = overlay.querySelector('#ni-value');
      input.focus();
      overlay.querySelector('#ni-cancel').addEventListener('click', () => overlay.remove());
      const submit = async () => {
        const value = input.value.trim();
        if (!value) { input.focus(); return; }
        overlay.querySelector('#ni-status').textContent = 'Saving…';
        try {
          await api(`/v1/instances/${inst}/input`, { method: 'POST', body: JSON.stringify({ taskId, value }) });
          overlay.querySelector('#ni-status').textContent = 'Saved — the agent is continuing ✓';
          setTimeout(() => { overlay.remove(); loadUnifiedBoard(); }, 800);
        } catch (e) { overlay.querySelector('#ni-status').textContent = 'Could not submit.'; }
      };
      overlay.querySelector('#ni-submit').addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    }

    function openTakeover(taskId) {
      const inst = currentInstance && currentInstance.id;
      if (!inst) return;
      // A needs_input handoff wants a typed value, not browser control.
      const handoff = (currentRuntimeEvents || []).find(e => e.taskId === taskId && e.type === 'job.human_handoff_required');
      const hdata = (handoff && handoff.data) || {};
      if (hdata.reason === 'needs_input') { openNeedsInput(taskId, hdata.inputField || 'a value'); return; }
      const overlay = document.createElement('div');
      overlay.id = 'takeover-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0b0b0f;display:flex;flex-direction:column';
      overlay.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;padding:8px 12px;background:#16161c;color:#fff;font-size:0.85rem;flex:0 0 auto">
          <span>🖥 Live browser — your mouse, scroll &amp; keyboard go through. Solve it, then <b>Done</b>.</span>
          <span id="takeover-status" style="color:#9ca3af;font-size:0.78rem">connecting…</span>
          <span style="flex:1"></span>
          <button id="takeover-fs" class="btn btn-outline btn-sm" style="color:#fff;border-color:#555">Fullscreen</button>
          <button id="takeover-done" class="btn btn-primary btn-sm">Done</button>
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
        doneBtn.disabled = true; doneBtn.textContent = 'Working…';
        try {
          const r = await api(`/v1/instances/${inst}/takeover/${encodeURIComponent(taskId)}/resume`, { method: 'POST' });
          // submitted = old single-shot flow; resumed = agent-driven flow handing
          // back to the brain. Both mean "done here" → close + refresh the board.
          if (r && (r.submitted || r.resumed)) { statusEl.textContent = r.submitted ? 'submitted ✓' : 'handed back — agent continuing ✓'; teardown(); loadUnifiedBoard(); return; }
          statusEl.textContent = (r && r.reason) ? r.reason : 'Not done yet';
        } catch (e) { statusEl.textContent = 'submit error'; }
        doneBtn.disabled = false; doneBtn.textContent = 'Done';
      });
      img.focus();
      poll();
    }

    // A human-readable task title (the raw type like "job.apply_agent" is useless).
