import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import {
	blockerHint,
	canAuthorize,
	connectionsFromGrants,
	credentialNote,
	normalizeEndpoint,
	presetFor,
	statusBadge,
	summarizeSmoke,
	type McpCredentialState,
	type McpGrant,
	type McpPreset,
	type McpReport,
} from "../lib/mcpConnections";

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
 *
 * CREDENTIALS ARE PER SERVER (#286). The token field below is bound to ONE endpoint. It used to
 * be one account-wide "MCP token" that the connector sent to whichever server a call named — so
 * a token issued by one server was handed to the next one an agent pointed at. A token entered
 * here reaches that server and no other, and the panel never displays a stored token back: it
 * has no client-side use, so read-back would be attack surface for nothing.
 *
 * CONNECT, DON'T PASTE (#180/#258). Most MCP servers are OAuth public clients: there IS no token a
 * human can copy, and their own docs say not to ask for one. When a tested server publishes
 * dynamic registration + PKCE S256, the panel offers Connect — the browser flow — and the token
 * field stays for the servers that genuinely issue machine credentials. The button appears only
 * where `/v1/mcp/oauth/start` would succeed, because a Connect that always fails reads as a broken
 * feature rather than a server that wants something else.
 *
 * A PRESET IS A PREFILLED URL (#287). The first-party entry saves typing an address; it carries no
 * credential and grants no tool. Its smoke test runs through `mcp_call_tool` like any other call,
 * so it passes the very same per-tool consent — "we wrote this server" is not a permission.
 */
export default function McpConnections({ instanceId, grants, onGrantsChanged }: { instanceId: string; grants: McpGrant[]; onGrantsChanged: (grants: McpGrant[]) => void }) {
	const [url, setUrl] = useState("");
	const [openAuth, setOpenAuth] = useState(false);
	const [testing, setTesting] = useState(false);
	const [report, setReport] = useState<McpReport | null>(null);
	const [msg, setMsg] = useState("");
	const [busyTool, setBusyTool] = useState("");
	const [creds, setCreds] = useState<McpCredentialState>({ credentials: [], legacy: { present: false } });
	/** Which endpoint's token field is open, and what has been typed into it. Never pre-filled
	 *  from the server — there is nothing to pre-fill it with, by design. */
	const [tokenFor, setTokenFor] = useState("");
	const [tokenValue, setTokenValue] = useState("");
	const [presets, setPresets] = useState<McpPreset[]>([]);
	const [authorizing, setAuthorizing] = useState("");
	const [smoke, setSmoke] = useState<{ endpoint: string; ok: boolean; text: string } | null>(null);

	const connections = connectionsFromGrants(grants);

	const loadCreds = useCallback(async () => {
		try {
			const next = await api<McpCredentialState>(`/v1/instances/${instanceId}/mcp/credentials`);
			setCreds(next);
			return next;
		} catch {
			/* metadata only — a failure here must not block the grant UI, which is the primary job */
			return null;
		}
	}, [instanceId]);

	useEffect(() => {
		void loadCreds();
	}, [loadCreds]);

	useEffect(() => {
		// Presets are deployment config, so a build that names no MCP server simply shows none —
		// which is why this failing is silent rather than an error the user cannot act on.
		api<{ presets: McpPreset[] }>("/v1/mcp/presets")
			.then((d) => setPresets(d.presets || []))
			.catch(() => setPresets([]));
	}, []);

	/** Store a token for ONE endpoint, or bind the unbound legacy token to it. */
	const saveCredential = async (endpoint: string, opts: { token?: string; adoptLegacy?: boolean }) => {
		setBusyTool(`cred::${endpoint}`);
		try {
			await api(`/v1/instances/${instanceId}/mcp/credentials`, { method: "PUT", body: JSON.stringify({ url: endpoint, ...opts }) });
			await loadCreds();
			setTokenFor("");
			setTokenValue("");
			setMsg(opts.adoptLegacy ? "Bound your existing token to this server" : "Token saved for this server");
			setTimeout(() => setMsg(""), 2500);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Could not save that token");
		} finally {
			setBusyTool("");
		}
	};

	const removeCredential = async (endpoint: string) => {
		setBusyTool(`cred::${endpoint}`);
		try {
			await api(`/v1/instances/${instanceId}/mcp/credentials?url=${encodeURIComponent(endpoint)}`, { method: "DELETE" });
			await loadCreds();
			setMsg("Token removed for this server");
			setTimeout(() => setMsg(""), 2500);
		} finally {
			setBusyTool("");
		}
	};

	const discardLegacy = async () => {
		setBusyTool("cred::legacy");
		try {
			await api(`/v1/instances/${instanceId}/mcp/credentials?legacy=1`, { method: "DELETE" });
			await loadCreds();
		} finally {
			setBusyTool("");
		}
	};

	/** The per-endpoint token field. Rendered inline under a server row and under a failed test,
	 *  because those are the two moments the user knows which server the token belongs to. */
	const tokenField = (endpoint: string) =>
		tokenFor === endpoint ? (
			<div className="flex flex-wrap gap-1.5 items-center mt-1">
				<input
					type="password"
					autoComplete="off"
					value={tokenValue}
					onChange={(e) => setTokenValue(e.target.value)}
					placeholder={`Access token for ${endpoint}`}
					className="flex-1 min-w-[12rem] px-2 py-1 text-xs bg-surface border border-line rounded font-mono"
				/>
				<button
					type="button"
					disabled={!tokenValue.trim() || busyTool === `cred::${endpoint}`}
					onClick={() => saveCredential(endpoint, { token: tokenValue.trim() })}
					className="px-2 py-1 text-xs font-semibold bg-accent text-white rounded disabled:opacity-40"
				>
					Save
				</button>
				<button type="button" className="text-xs text-muted-soft hover:underline" onClick={() => { setTokenFor(""); setTokenValue(""); }}>
					Cancel
				</button>
				{creds.legacy.present && (
					<button type="button" className="text-xs text-accent hover:underline" disabled={busyTool === `cred::${endpoint}`} onClick={() => saveCredential(endpoint, { adoptLegacy: true })}>
						Use my existing token
					</button>
				)}
			</div>
		) : null;

	/**
	 * Authorize a server in the browser (#180/#258).
	 *
	 * The authorize URL is minted server-side — start also sets the HttpOnly nonce cookie that binds
	 * the flow to THIS browser, so the console cannot construct this URL itself even if it wanted
	 * to. The new tab lands on the API's callback, which stores the credential; this panel has no
	 * way to be told, so it polls its own credential list and stops as soon as one appears.
	 */
	const authorize = async (endpoint: string, scope: string | null) => {
		setAuthorizing(endpoint);
		setMsg("");
		try {
			const started = await api<{ url: string; unattended?: string }>("/v1/mcp/oauth/start", { method: "POST", body: JSON.stringify({ url: endpoint, scope }) });
			// Opened WITHOUT the `noopener` feature on purpose: that flag makes window.open return
			// null by spec, which is indistinguishable from a blocked pop-up and would make the
			// error below fire every time. The handle is dropped immediately instead, which is the
			// same protection against the authorization page reaching back into this tab.
			const win = window.open(started.url, "_blank");
			if (!win) {
				setMsg("Your browser blocked the sign-in window — allow pop-ups for this site and try again.");
				return;
			}
			win.opener = null;
			setMsg("Finish signing in on the new tab. This panel updates when it lands.");
			for (let i = 0; i < 40; i++) {
				await new Promise((resolve) => setTimeout(resolve, 2500));
				const fresh = await loadCreds();
				if (fresh?.credentials.some((c) => c.endpoint === endpoint && c.authMode === "oauth" && !c.expired)) {
					// #181's verdict, said once at the moment it matters: an interactive-only server
					// cannot be renewed with nobody present, so wiring it into a cron chain schedules
					// an outage. Authorizing it is still legitimate — for work you are present for.
					setMsg(
						started.unattended === "interactive-only"
							? "Authorized — but this server issues no refresh token, so access will expire and can’t be renewed unattended."
							: "Authorized. Now allow the specific tools this agent may call.",
					);
					return;
				}
			}
			setMsg("Still waiting for that sign-in. If you finished it, press Test connection.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Could not start authorization for that server");
		} finally {
			setAuthorizing("");
		}
	};

	/**
	 * The dogfood smoke test (#287): call ONE read-only tool for real and show what came back.
	 *
	 * Goes through `mcp_call_tool`, which means the agent's tool allowlist, the connector write gate
	 * and the per-(endpoint, tool) grant all apply — the button is only offered once the report says
	 * that tool is callable. There is deliberately no first-party shortcut: a smoke test that
	 * bypassed consent would be testing a path no real call ever takes.
	 */
	const runSmoke = async (endpoint: string, tool: string) => {
		setBusyTool(`smoke::${endpoint}`);
		setSmoke(null);
		try {
			const r = await api<{ content: string; success: boolean }>(`/v1/instances/${instanceId}/tools/mcp_call_tool`, {
				method: "POST",
				body: JSON.stringify({ url: endpoint, tool }),
			});
			const s = summarizeSmoke(r.content);
			const ok = r.success && s.ok;
			const text = ok
				? s.count === null
					? `${tool} responded${s.detail ? `: ${s.detail}` : ""}`
					: `${tool} returned ${s.count} item${s.count === 1 ? "" : "s"}${s.sample.length ? ` — ${s.sample.join(", ")}${s.count > s.sample.length ? ", …" : ""}` : ""}`
				: `${tool} failed: ${s.detail || r.content.slice(0, 200)}`;
			setSmoke({ endpoint, ok, text });
		} catch (e) {
			setSmoke({ endpoint, ok: false, text: e instanceof Error ? e.message : "The call could not be made" });
		} finally {
			setBusyTool("");
		}
	};

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

			{/* The unbound legacy token. Shown until it is bound or discarded, because the alternative
			    is a user whose agent silently stopped working reading the change as data loss. */}
			{creds.legacy.present && (
				<p className="text-[0.68rem] text-yellow mb-2 leading-snug">
					You have an older account-wide MCP token. It isn’t bound to a server, so it is no longer sent automatically — one token reaching every server you name was the reason. Add a
					token per server below (“Use my existing token” binds this one without retyping it), or{" "}
					<button type="button" className="underline" disabled={busyTool === "cred::legacy"} onClick={() => discardLegacy()}>
						discard it
					</button>
					.
				</p>
			)}

			{/* Existing connections — one row per server, derived from the grants. */}
			{connections.length > 0 && (
				<ul className="mb-2">
					{connections.map((c) => (
						<li key={c.endpoint} className="text-xs mb-1.5">
							<div className="flex items-center gap-2">
								<code className="font-mono text-muted truncate max-w-[16rem]">{c.endpoint}</code>
								<span className="text-muted-soft">{c.wildcard ? "all tools" : `${c.grants.length} tool${c.grants.length === 1 ? "" : "s"}`}</span>
								{(() => {
									const note = credentialNote(creds.credentials, c.endpoint);
									return <span className={note.tone === "amber" ? "text-yellow" : "text-muted-soft"}>· {note.label}</span>;
								})()}
								{/* An OAuth server gets Reauthorize, not "replace token": there is no token to
								    replace, and offering one sends the user hunting for something that
								    does not exist. Bearer servers keep the field. */}
								{creds.credentials.find((k) => k.endpoint === c.endpoint)?.authMode === "oauth" ? (
									<button
										type="button"
										className="text-accent hover:underline"
										disabled={authorizing === c.endpoint}
										onClick={() => authorize(c.endpoint, presetFor(presets, c.endpoint)?.scope ?? null)}
									>
										{authorizing === c.endpoint ? "Waiting for sign-in…" : "Reauthorize"}
									</button>
								) : (
									<button type="button" className="text-accent hover:underline" onClick={() => { setTokenFor(tokenFor === c.endpoint ? "" : c.endpoint); setTokenValue(""); }}>
										{creds.credentials.some((k) => k.endpoint === c.endpoint) ? "Replace token" : "Add token"}
									</button>
								)}
								{creds.credentials.some((k) => k.endpoint === c.endpoint) && (
									<button type="button" className="text-muted-soft hover:text-red" disabled={busyTool === `cred::${c.endpoint}`} onClick={() => removeCredential(c.endpoint)}>
										Remove token
									</button>
								)}
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
							{tokenField(c.endpoint)}
						</li>
					))}
				</ul>
			)}

			{/* First-party presets (#287) — a prefilled address, nothing more. Absent on a deployment
			    that names no MCP server of its own, which is the normal state of a local build. */}
			{presets.length > 0 && (
				<div className="flex flex-wrap gap-1.5 items-center mb-1.5">
					<span className="text-[0.68rem] text-muted-soft">Suggested:</span>
					{presets.map((p) => (
						<button
							key={p.id}
							type="button"
							title={p.description}
							disabled={testing}
							onClick={() => {
								setUrl(p.url);
								void runTest(p.url, "vault");
							}}
							className="px-2 py-0.5 text-[0.68rem] rounded-full border border-line bg-surface hover:border-accent disabled:opacity-40"
						>
							{p.label}
						</button>
					))}
				</div>
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
				Open server — don’t send this server’s stored token
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

					{/* The credential remedy, offered at the moment the user knows which server needs it.
					    `auth_required` is included: the server rejected what we sent, and the fix is a
					    new token for THIS endpoint — not for the account.

					    Connect comes FIRST where the server supports it, because on an OAuth server
					    there is no token for the user to find: telling them to paste one sends them
					    looking for something that does not exist. */}
					{(report.status === "credential_missing" || report.status === "credential_expired" || report.status === "auth_required") && (
						<div className="flex flex-wrap items-center gap-2 mt-1">
							{canAuthorize(report) && (
								<button
									type="button"
									disabled={authorizing === report.endpoint}
									onClick={() => authorize(report.endpoint, presetFor(presets, report.endpoint)?.scope ?? null)}
									className="px-2 py-1 text-xs font-semibold bg-accent text-white rounded disabled:opacity-40"
								>
									{authorizing === report.endpoint ? "Waiting for sign-in…" : report.status === "credential_missing" ? "Connect" : "Reconnect"}
								</button>
							)}
							{tokenFor !== report.endpoint && (
								<button type="button" className="text-[0.68rem] text-accent hover:underline" onClick={() => { setTokenFor(report.endpoint); setTokenValue(""); }}>
									{report.status === "credential_missing" ? "Add a token for this server" : "Replace this server’s token"}
								</button>
							)}
						</div>
					)}
					{(report.status === "credential_missing" || report.status === "credential_expired" || report.status === "auth_required") && tokenField(report.endpoint)}

					{/* Auth model, when the server published any. Shape only — never a token. */}
					{report.auth?.protectedResource && (
						<p className="text-[0.68rem] text-muted-soft mt-1">
							OAuth-protected by <code className="font-mono">{report.auth.authorizationServer}</code>
							{report.auth.unattended === "interactive-only" && " — it issues no refresh token, so access can’t be renewed unattended."}
							{report.auth.dynamicRegistration === false && " — it needs a pre-registered client, so connect it with a token instead."}
						</p>
					)}

					{/* The dogfood smoke test (#287), offered only once that exact tool is callable. */}
					{report.status === "connected" &&
						(() => {
							const preset = presetFor(presets, report.endpoint);
							const tool = preset?.smokeTool ? report.tools.find((t) => t.name === preset.smokeTool) : undefined;
							if (!preset?.smokeTool || !tool) return null;
							return (
								<div className="mt-1.5">
									{tool.callable ? (
										<button
											type="button"
											disabled={busyTool === `smoke::${report.endpoint}`}
											onClick={() => runSmoke(report.endpoint, preset.smokeTool as string)}
											className="text-[0.68rem] text-accent hover:underline disabled:opacity-40"
										>
											{busyTool === `smoke::${report.endpoint}` ? "Running…" : `Run ${preset.smokeTool} as a live check`}
										</button>
									) : (
										<span className="text-[0.68rem] text-muted-soft">
											Allow <code className="font-mono">{preset.smokeTool}</code> below to run a live check against this server.
										</span>
									)}
									{smoke?.endpoint === report.endpoint && <p className={`text-[0.68rem] mt-0.5 ${smoke.ok ? "text-green" : "text-yellow"}`}>{smoke.text}</p>}
								</div>
							);
						})()}

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
