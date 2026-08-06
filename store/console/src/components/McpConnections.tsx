import { useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { blockerHint, connectionsFromGrants, normalizeEndpoint, statusBadge, type McpGrant, type McpReport } from "../lib/mcpConnections";

/**
 * MCP Connections (#266) — the guided lifecycle for a user-named MCP endpoint:
 * enter a URL → validate → connect → discover the server's tools → tick the ones this agent may
 * call → verify.
 *
 * WHAT THIS REPLACED. The old panel was two text inputs: paste a URL, type a tool name, click
 * Allow. That asks the user to already know the answer to the question they came here with —
 * you cannot type a tool name you have never seen, and nothing told you whether the URL was even
 * reachable until an agent silently failed hours later. Discovery (`tools/list`) is read-scoped
 * and needs no consent, which is exactly what makes per-tool consent (#262) usable: enumerate
 * first, approve from the real list.
 *
 * WHY TEST RESULTS ARE NOT CACHED. A connection's health is a fact about right now, not stored
 * state. Persisting "connected" would produce the console's favourite lie — a green badge for a
 * server that went down, or for a grant that has since been revoked. The panel shows the result
 * of the test YOU just ran, and says nothing at all otherwise.
 *
 * The connection list itself comes from the grants (lib/mcpConnections.ts): the endpoint URL is
 * already the identity that consent, the trace and the connector all key on, so there is no
 * second record to rename or to drift.
 */
export default function McpConnections({ instanceId, grants, onGrantsChanged }: { instanceId: string; grants: McpGrant[]; onGrantsChanged: (grants: McpGrant[]) => void }) {
	const [url, setUrl] = useState("");
	const [openAuth, setOpenAuth] = useState(false);
	const [testing, setTesting] = useState(false);
	const [report, setReport] = useState<McpReport | null>(null);
	const [msg, setMsg] = useState("");
	const [busyTool, setBusyTool] = useState("");

	const connections = connectionsFromGrants(grants);

	const reload = async () => {
		const d = await api<{ grants?: McpGrant[] }>(`/v1/instances/${instanceId}/mcp/consent`);
		onGrantsChanged(d.grants || []);
		return d.grants || [];
	};

	/**
	 * Run the connection test. Every request goes to the server route, which is the only path
	 * out: the browser never fetches the MCP endpoint itself. That is not just a CORS
	 * convenience — a user-supplied endpoint fetched from the Worker is SSRF-guarded there, and
	 * an endpoint fetched from the browser would be neither guarded nor logged.
	 */
	const runTest = async (endpoint: string, auth: "vault" | "none") => {
		const normalized = normalizeEndpoint(endpoint);
		if (!normalized) {
			setMsg("That isn’t an https MCP endpoint — it must start with https://");
			setReport(null);
			return;
		}
		setTesting(true);
		setMsg("");
		try {
			const r = await api<McpReport>(`/v1/instances/${instanceId}/mcp/test`, { method: "POST", body: JSON.stringify({ url: normalized, auth }) });
			setReport(r);
		} catch (e) {
			setReport(null);
			setMsg(e instanceof Error ? e.message : "Could not reach that endpoint");
		} finally {
			setTesting(false);
		}
	};

	/** Grant or revoke one (server, tool) pair, then re-read: the server owns the stored form. */
	const setGrant = async (endpoint: string, tool: string, enabled: boolean) => {
		setBusyTool(`${endpoint}::${tool}`);
		try {
			await api(`/v1/instances/${instanceId}/mcp/consent`, { method: "PUT", body: JSON.stringify({ url: endpoint, tool, enabled }) });
			const fresh = await reload();
			// Re-derive callability from the grants we just re-read rather than toggling the
			// checkbox locally — an optimistic tick that consent later disagreed with is the
			// "test says allowed, call says denied" gap this whole surface exists to close.
			if (report && report.endpoint === endpoint) {
				const mine = fresh.filter((g) => g.endpoint === endpoint);
				const wildcard = mine.some((g) => g.tool === "*");
				const tools = report.tools.map((t) => {
					const granted = mine.some((g) => g.tool === t.name) || (wildcard && !t.destructive);
					const blockedBy = !report.gates.callToolEnabled
						? ("tool_disabled" as const)
						: !report.gates.writeConsent
							? ("no_write_consent" as const)
							: granted
								? undefined
								: wildcard && t.destructive
									? ("wildcard_excludes_destructive" as const)
									: ("no_grant" as const);
					return { ...t, granted, callable: !blockedBy, blockedBy };
				});
				setReport({ ...report, tools, callableCount: tools.filter((t) => t.callable).length });
			}
			setMsg(enabled ? `Allowed ${tool}` : `Revoked ${tool}`);
			setTimeout(() => setMsg(""), 2500);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Could not change that grant");
		} finally {
			setBusyTool("");
		}
	};

	/** Disconnect = revoke every grant on that server. The connection IS its grants. */
	const disconnect = async (endpoint: string, toolNames: string[]) => {
		setBusyTool(endpoint);
		try {
			for (const tool of toolNames) {
				await api(`/v1/instances/${instanceId}/mcp/consent`, { method: "PUT", body: JSON.stringify({ url: endpoint, tool, enabled: false }) });
			}
			await reload();
			if (report?.endpoint === endpoint) setReport(null);
			setMsg("Disconnected");
			setTimeout(() => setMsg(""), 2500);
		} finally {
			setBusyTool("");
		}
	};

	const badge = report ? statusBadge(report.status) : null;
	const toneClass = badge?.tone === "green" ? "text-green" : badge?.tone === "amber" ? "text-yellow" : "text-red";

	return (
		<div className="mb-3 pb-3 border-b border-line">
			<div className="text-sm font-semibold mb-0.5">MCP connections</div>
			<p className="text-[0.7rem] text-muted-soft mb-2">
				Point this agent at a remote MCP server. Testing a URL reads the server’s own tool list — nothing is granted until you tick it. A server is identified by its
				address, so there is no nickname to keep in sync; add as many as you like.
			</p>

			{/* Existing connections — one row per server, derived from the grants. */}
			{connections.length > 0 && (
				<ul className="mb-2">
					{connections.map((c) => (
						<li key={c.endpoint} className="text-xs mb-1.5">
							<div className="flex items-center gap-2">
								<code className="font-mono text-muted truncate max-w-[16rem]">{c.endpoint}</code>
								<span className="text-muted-soft">{c.wildcard ? "all tools" : `${c.grants.length} tool${c.grants.length === 1 ? "" : "s"}`}</span>
								<button type="button" className="ml-auto text-accent hover:underline" onClick={() => { setUrl(c.endpoint); runTest(c.endpoint, openAuth ? "none" : "vault"); }}>
									Test
								</button>
								<button type="button" className="text-muted-soft hover:text-red" disabled={busyTool === c.endpoint} onClick={() => disconnect(c.endpoint, c.grants.map((g) => g.tool))}>
									Disconnect
								</button>
							</div>
							<div className="flex flex-wrap gap-1 mt-0.5">
								{c.grants.map((g) => (
									<span key={g.tool} className="px-1.5 py-0.5 rounded bg-surface border border-line font-mono text-[0.65rem]">
										{g.tool === "*" ? "*" : g.tool}
										{g.destructive && <span className="text-red ml-1">!</span>}
										<button type="button" className="ml-1 text-muted-soft hover:text-red" onClick={() => setGrant(c.endpoint, g.tool, false)} aria-label={`Revoke ${g.tool}`}>
											×
										</button>
									</span>
								))}
							</div>
						</li>
					))}
				</ul>
			)}

			{/* Add / test an endpoint. */}
			<div className="flex flex-wrap gap-1.5 items-center">
				<input
					type="url"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https://example.com/mcp"
					className="flex-1 min-w-[12rem] px-2 py-1 text-xs bg-surface border border-line rounded"
				/>
				<button
					type="button"
					disabled={!url.trim() || testing}
					onClick={() => runTest(url.trim(), openAuth ? "none" : "vault")}
					className="px-2.5 py-1 text-xs font-semibold bg-accent text-white rounded disabled:opacity-40"
				>
					{testing ? "Testing…" : "Test connection"}
				</button>
			</div>
			<label className="flex items-center gap-1.5 text-[0.68rem] text-muted-soft mt-1 cursor-pointer">
				<input type="checkbox" checked={openAuth} onChange={(e) => setOpenAuth(e.target.checked)} className="w-3 h-3 accent-accent" />
				Open server — don’t send my stored MCP token
			</label>
			{msg && <p className="text-xs text-green mt-1">{msg}</p>}

			{/* The report. Everything here is the result of the test just run — never cached. */}
			{report && (
				<div className="mt-2 p-2 rounded border border-line bg-surface">
					<div className="flex items-center gap-2 text-xs">
						<span className={`font-semibold ${toneClass}`}>{badge?.label}</span>
						<code className="font-mono text-muted truncate max-w-[14rem]">{report.endpoint}</code>
						{report.durationMs != null && <span className="ml-auto text-muted-soft">{report.durationMs}ms</span>}
					</div>
					<p className="text-[0.7rem] text-muted mt-1 leading-snug">{report.detail}</p>

					{/* Auth model, when the server published any. Shape only — never a token. */}
					{report.auth?.protectedResource && (
						<p className="text-[0.68rem] text-muted-soft mt-1">
							OAuth-protected by <code className="font-mono">{report.auth.authorizationServer}</code>
							{report.auth.unattended === "interactive-only" && " — it issues no refresh token, so access can’t be renewed unattended."}
						</p>
					)}

					{/* The gates. Shown even on success, because "connected" with a closed gate is
					    the exact state that looks fine and does nothing. */}
					{report.status === "connected" && !report.gates.callToolEnabled && (
						<p className="text-[0.68rem] text-yellow mt-1">This agent can’t run <code className="font-mono">mcp_call_tool</code>, so nothing here is callable yet — enable it under Tools.</p>
					)}
					{report.status === "connected" && report.gates.callToolEnabled && !report.gates.writeConsent && (
						<p className="text-[0.68rem] text-yellow mt-1">MCP write access is off. Granting a tool below turns it on.</p>
					)}

					{report.tools.length > 0 && (
						<div className="mt-2">
							<div className="flex items-center gap-2 mb-1">
								<span className="text-[0.7rem] font-semibold">Tools on this server</span>
								<button
									type="button"
									className="ml-auto text-[0.68rem] text-accent hover:underline"
									disabled={busyTool !== ""}
									onClick={() => setGrant(report.endpoint, "*", true)}
								>
									Allow all non-destructive
								</button>
							</div>
							{report.tools.map((t) => (
								<label key={t.name} className="flex items-start gap-2 text-xs mb-1 cursor-pointer">
									<input
										type="checkbox"
										checked={t.granted}
										disabled={busyTool === `${report.endpoint}::${t.name}`}
										onChange={(e) => setGrant(report.endpoint, t.name, e.target.checked)}
										className="w-3.5 h-3.5 accent-accent mt-0.5"
									/>
									<span className="min-w-0">
										<span className="font-mono text-[0.72rem] font-semibold">{t.name}</span>
										{t.destructive && <span className="ml-1.5 text-[0.62rem] uppercase tracking-wide text-red">destructive</span>}
										{t.description && <span className="block text-[0.66rem] text-muted-soft leading-snug">{t.description}</span>}
										{!t.callable && t.blockedBy && <span className="block text-[0.66rem] text-yellow leading-snug">{blockerHint(t.blockedBy)}</span>}
									</span>
								</label>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
