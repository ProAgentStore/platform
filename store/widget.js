/**
 * ProAgentStore embeddable chat widget.
 * Usage: <script src="https://proagentstore.online/widget.js" data-agent="slug" data-theme="dark"></script>
 */
(() => {
	const script = document.currentScript;
	const agentId = script?.getAttribute("data-agent");
	const theme = script?.getAttribute("data-theme") || "dark";
	const API = "https://api.proagentstore.online";

	if (!agentId) {
		console.error("ProAgentStore widget: data-agent attribute required");
		return;
	}

	/**
	 * The widget's own failures reach the durable log (#1088) as `client:widget`. It runs on a CUSTOMER's
	 * site, so: anonymous always, nothing written to that site's storage, only the widget's own handled
	 * failures (never the host page's errors), never the visitor's message, at most 5 reports per page.
	 * Each has an event id and is retried in memory (2 s, 10 s, 30 s) until the platform acknowledges it.
	 */
	let widgetReports = 0;
	function reportWidgetError(message, context) {
		if (widgetReports >= 5) return;
		widgetReports++;
		const body = JSON.stringify({
			id: crypto?.randomUUID ? crypto.randomUUID() : `wid-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			source: "widget",
			message,
			context: { agent: agentId, embedHost: location.hostname, ...context },
			build: "widget",
		});
		const delays = [2000, 10000, 30000];
		const attempt = (n) =>
			fetch(`${API}/v1/errors/client`, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body })
				.then((r) => (r.ok || [400, 413, 422].includes(r.status) ? null : Promise.reject(r.status)))
				.catch(() => (n < delays.length ? new Promise((res) => setTimeout(res, delays[n])).then(() => attempt(n + 1)) : null));
		void attempt(0);
	}

	let sessionId = null;
	const _open = false;

	const isDark = theme === "dark";
	const colors = isDark
		? {
				bg: "#0a0a0a",
				panel: "#171717",
				ink: "#fafafa",
				muted: "#a3a3a3",
				accent: "#7c3aed",
				line: "#262626",
				userBg: "#7c3aed",
				botBg: "#1f1f1f",
			}
		: {
				bg: "#fff",
				panel: "#f5f5f5",
				ink: "#171717",
				muted: "#737373",
				accent: "#7c3aed",
				line: "#e5e5e5",
				userBg: "#7c3aed",
				botBg: "#f0f0f0",
			};

	// Create container
	const container = document.createElement("div");
	container.id = "pags-widget";
	container.innerHTML = `
    <style>
      #pags-widget *{margin:0;padding:0;box-sizing:border-box;font-family:'Manrope',system-ui,sans-serif}
      #pags-fab{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;background:${colors.accent};color:#fff;border:none;cursor:pointer;font-size:1.5rem;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:99999;transition:transform 0.15s}
      #pags-fab:hover{transform:scale(1.05)}
      #pags-panel{position:fixed;bottom:88px;right:20px;width:380px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 120px);background:${colors.bg};border:1px solid ${colors.line};border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,0.4);z-index:99998;display:none;flex-direction:column;overflow:hidden}
      #pags-panel.open{display:flex}
      #pags-header{padding:12px 16px;border-bottom:1px solid ${colors.line};display:flex;align-items:center;gap:8px;background:${colors.panel}}
      #pags-header .dot{width:10px;height:10px;border-radius:50%;background:#22c55e;flex-shrink:0}
      #pags-header .name{font-weight:600;font-size:14px;color:${colors.ink};flex:1}
      #pags-header .close{background:none;border:none;color:${colors.muted};cursor:pointer;font-size:18px;padding:4px}
      #pags-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
      .pags-msg{max-width:85%;padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.5;white-space:pre-wrap}
      .pags-msg.user{background:${colors.userBg};color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
      .pags-msg.assistant{background:${colors.botBg};color:${colors.ink};align-self:flex-start;border-bottom-left-radius:4px;border:1px solid ${colors.line}}
      .pags-msg.system{background:rgba(234,179,8,0.1);color:#eab308;align-self:center;font-size:12px;border-radius:999px;padding:4px 12px}
      #pags-thinking{color:${colors.muted};font-style:italic;font-size:12px;padding:4px 12px;display:none}
      #pags-bar{display:flex;gap:8px;padding:10px 12px;border-top:1px solid ${colors.line}}
      #pags-bar input{flex:1;background:${colors.panel};border:1px solid ${colors.line};border-radius:8px;padding:8px 12px;color:${colors.ink};font-size:14px;outline:none;font-family:inherit}
      #pags-bar input:focus{border-color:${colors.accent}}
      #pags-bar button{background:${colors.accent};color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit}
      #pags-powered{text-align:center;padding:6px;font-size:10px;color:${colors.muted};border-top:1px solid ${colors.line}}
      #pags-powered a{color:${colors.accent};text-decoration:none}
    </style>
    <button id="pags-fab" onclick="document.getElementById('pags-panel').classList.toggle('open')">&#9889;</button>
    <div id="pags-panel">
      <div id="pags-header">
        <span class="dot"></span>
        <span class="name" id="pags-agent-name">Agent</span>
        <button class="close" onclick="document.getElementById('pags-panel').classList.remove('open')">&times;</button>
      </div>
      <div id="pags-msgs"></div>
      <div id="pags-thinking">Thinking...</div>
      <div id="pags-bar">
        <input id="pags-input" placeholder="Ask a question..." onkeydown="if(event.key==='Enter')window._pagsSend()">
        <button onclick="window._pagsSend()">Send</button>
      </div>
      <div id="pags-powered">Powered by <a href="https://proagentstore.online" target="_blank">ProAgentStore</a></div>
    </div>`;
	document.body.appendChild(container);

	// Load agent name
	fetch(`${API}/v1/public/agents/${agentId}`)
		.then((r) => {
			if (!r.ok && r.status !== 404) reportWidgetError(`agent load → ${r.status}`, { status: r.status });
			return r.json();
		})
		.then((a) => {
			if (a.name)
				document.getElementById("pags-agent-name").textContent = a.name;
		})
		.catch((e) => {
			if (navigator.onLine !== false) reportWidgetError("agent load → network error", { error: String(e?.message || e).slice(0, 200) });
		});

	function esc(s) {
		const d = document.createElement("div");
		d.textContent = s || "";
		return d.innerHTML;
	}

	window._pagsSend = async () => {
		const input = document.getElementById("pags-input");
		const message = input.value.trim();
		if (!message) return;
		input.value = "";

		const msgs = document.getElementById("pags-msgs");
		msgs.innerHTML += `<div class="pags-msg user">${esc(message)}</div>`;
		msgs.scrollTop = msgs.scrollHeight;
		document.getElementById("pags-thinking").style.display = "";

		let reported = false;
		try {
			const res = await fetch(`${API}/v1/public/agents/${agentId}/try`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: message, sessionId: sessionId }),
			});
			if (res.status >= 500) {
				reported = true;
				reportWidgetError(`try → ${res.status}`, { status: res.status });
			}
			const data = await res.json();
			sessionId = data.sessionId || sessionId;
			if (data.message)
				msgs.innerHTML += `<div class="pags-msg assistant">${esc(data.message.content)}</div>`;
			if (data.error)
				msgs.innerHTML += `<div class="pags-msg system">${esc(data.error)}</div>`;
		} catch (e) {
			if (!reported && navigator.onLine !== false) reportWidgetError("try → network error", { error: String(e?.message || e).slice(0, 200) });
			msgs.innerHTML += `<div class="pags-msg system">Error: ${esc(e.message)}</div>`;
		}
		document.getElementById("pags-thinking").style.display = "none";
		msgs.scrollTop = msgs.scrollHeight;
	};
})();
