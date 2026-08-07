import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import {
	accountConnections,
	connectionSummary,
	disconnectedMessage,
	disconnectPromptFor,
	type ConnectorEntry,
} from "../lib/accountConnections";
import type { ConnectorReach } from "../lib/connectorState";

/**
 * The account's connected accounts (#355) — Gmail, Google Drive, Zoho WorkDrive, GitHub.
 *
 * These used to be rendered inside one agent's Settings tab, which is why this component exists:
 * the tab is titled with an agent's name, so a control that changes every agent read as changing
 * that one. Here the page IS the account, and the scope is the location.
 *
 * The list is a `.map()` over `GET /v1/connectors` (#352 Stage 1) — labels, connected-ness,
 * account, blast radius and the endpoints to call all come from the server. No connector is named
 * in this file, which is the point: the previous arrangement's real cost was that adding a
 * connector meant remembering a fourth hand-written block.
 *
 * GitHub is rendered separately and deliberately. Its "connection" is not a stored credential but
 * an identity link (`users.linked_github_login`) plus an App installation, so it cannot answer
 * `connected` from the vault row the rest of the list reads, and folding it in would make one
 * field mean two things. It belongs on this page anyway — nobody hunting for "where do I connect
 * GitHub" looks under identity — so it sits at the top of the same section with its own row.
 */
export default function AccountConnections() {
	const [entries, setEntries] = useState<ConnectorEntry[] | null>(null);
	const [msg, setMsg] = useState("");
	const [githubLinked, setGithubLinked] = useState<string | null>(null);
	const [githubMsg, setGithubMsg] = useState("");

	const load = useCallback(async () => {
		try {
			const d = await api<{ connectors?: ConnectorEntry[] }>("/v1/connectors");
			setEntries(d.connectors ?? []);
		} catch {
			// An empty section with no explanation is worse than an empty section that says so.
			setEntries([]);
			setMsg("Couldn't load your connections. Reload to try again.");
		}
	}, []);

	useEffect(() => {
		void load();
		api<{ githubLinked?: string | null }>("/v1/auth/me")
			.then((d) => setGithubLinked(d.githubLinked ?? null))
			.catch(() => {});
	}, [load]);

	// The GitHub link is a full-page redirect that returns here with ?github_linked=<login>.
	// Moved from the instance Settings tab along with the button that starts it — the callback
	// has to land where the control lives, or the confirmation appears on a page nobody is on.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const justLinked = params.get("github_linked");
		if (!justLinked) return;
		setGithubLinked(justLinked);
		const bound = params.get("github_bound");
		if (bound) setGithubMsg(`Connected as ${justLinked} — ${bound} org${bound === "1" ? "" : "s"} linked. Build status will show for their repos.`);
		params.delete("github_linked");
		params.delete("github_bound");
		const q = params.toString();
		window.history.replaceState({}, "", window.location.pathname + (q ? `?${q}` : ""));
	}, []);

	// OAuth happens in another tab; re-read when the user comes back, so a just-completed
	// connection reflects without a reload.
	useEffect(() => {
		const onFocus = () => void load();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [load]);

	const connect = async (entry: ConnectorEntry) => {
		if (!entry.flow) return;
		try {
			const { url } = await api<{ url: string }>(entry.flow.start);
			window.open(url, "_blank", "noopener");
			setMsg(`Complete the ${entry.label} sign-in in the new tab, then come back here.`);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : `Failed to start the ${entry.label} connection`);
		}
	};

	const disconnect = async (entry: ConnectorEntry) => {
		if (!entry.flow) return;
		// Re-read first: the reach quoted in the confirmation has to be the reach at the moment of
		// the click. Another tab — or this account's other agents — may have granted folders since
		// the page loaded, and this page is further from those grants than the old one was.
		let fresh = entry;
		try {
			const d = await api<{ connectors?: ConnectorEntry[] }>("/v1/connectors");
			setEntries(d.connectors ?? []);
			fresh = (d.connectors ?? []).find((e) => e.id === entry.id) ?? entry;
		} catch { /* never block a disconnect on a status read */ }
		if (!confirm(disconnectPromptFor(fresh))) return;
		try {
			const r = await api<{ revoked?: ConnectorReach }>(fresh.flow?.disconnect ?? entry.flow.disconnect, { method: "DELETE" });
			setMsg(disconnectedMessage(fresh, r.revoked));
			await load();
		} catch (e) {
			setMsg(e instanceof Error ? e.message : `Failed to disconnect ${entry.label}`);
		}
	};

	const connectGithub = async () => {
		try {
			const returnTo = window.location.origin + window.location.pathname;
			const { url } = await api<{ url: string }>(`/v1/auth/github/link/start?return_to=${encodeURIComponent(returnTo)}`);
			window.location.href = url;
		} catch (e) {
			setGithubMsg(e instanceof Error ? e.message : "Couldn't start GitHub link");
		}
	};

	const rows = accountConnections(entries ?? []);

	return (
		<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Connections</h3>
			<p className="text-xs text-muted mb-3">
				Accounts your agents can reach. There is one of each per account, so connecting or
				disconnecting here changes it for <b>every</b> agent at once. Which folders a particular
				agent may read is granted on that agent's own Settings tab.
			</p>

			{/* GitHub — an identity link, not a stored token. See the component header. */}
			{/* `flex-wrap` below sm, and only below sm (#384). #333's `[overflow-wrap:anywhere]` and
			    this row's `shrink-0` are each right on their own — one stops the unbreakable email
			    token running off the page, the other stops the buttons collapsing — but together
			    they leave the row unable to overflow AND unable to wrap, so the whole deficit lands
			    on the only thing that yields. At 320px the label took 25% of the row and ran 140px
			    tall, in both engines: "connecte / d as / serge.pro. / job@gmail / .com". Wrapping is
			    capped at sm because line-breaking uses each item's MAX-content width, so an unpinned
			    `flex-wrap` drops the buttons below the label on a desktop row that fits. */}
			<div className="flex flex-wrap sm:flex-nowrap items-start justify-between gap-3 mb-3">
				{/* `min-w-0` lets the COLUMN shrink; it does not make the STRING shorter. Every row
				    here names an account, and an account name is one unbreakable token — a login, or
				    an email — so the column shrinks to nothing and the token runs off the right edge,
				    panning <main> by up to 205px at a phone width. `[overflow-wrap:anywhere]` is what
				    lowers the min-content width so it wraps instead, and is what Profile already does
				    to the display name and @login for the same reason (#333). */}
				<div className="text-sm min-w-0 [overflow-wrap:anywhere]">
					<span className="font-semibold">GitHub</span>{" "}
					{githubLinked
						? <span className="text-green">· connected as {githubLinked}</span>
						: <span className="text-muted">· not connected</span>}
					<p className="text-[0.7rem] text-muted-soft mt-0.5">
						Links your GitHub username so the Coder can show build status and reach your repos.
					</p>
				</div>
				<button
					type="button"
					onClick={connectGithub}
					className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-bold shrink-0"
				>
					{githubLinked ? "Reconnect" : "Connect GitHub"}
				</button>
			</div>
			{githubMsg && <p className="text-xs text-green mb-3 -mt-1">{githubMsg}</p>}

			{entries === null
				? <p className="text-xs text-muted">Loading…</p>
				: rows.length === 0
					? <p className="text-xs text-muted">No other accounts can be connected on this deployment yet.</p>
					: rows.map((entry) => (
						/* Same crush as the GitHub row above, and worse here: this one carries two
						   buttons, so the label column is left with less of the row. */
						<div key={entry.id} className="flex flex-wrap sm:flex-nowrap items-start justify-between gap-3 mb-3">
							{/* Same unbreakable-token problem as the GitHub row above — this is the one
							    that was actually reported, because `connectionSummary` prints the whole
							    Google/Zoho email. */}
							<div className="text-sm min-w-0 [overflow-wrap:anywhere]">
								<span className="font-semibold">{entry.label}</span>{" "}
								<span className={entry.connected ? "text-green" : "text-muted"}>· {connectionSummary(entry)}</span>
								{/* Standing, not only in the confirm dialog: what a disconnect destroys should be
								    readable by someone who has NOT decided to click it yet. */}
								{entry.connected && entry.reach && entry.reach.grants > 0 && (
									<p className="text-[0.7rem] text-muted-soft mt-0.5">
										Disconnecting revokes those grants everywhere. Reconnecting will not bring them back.
									</p>
								)}
							</div>
							{entry.connected ? (
								<div className="flex gap-2 shrink-0">
									{/* Reconnect exists so an expired token is not a reason to disconnect — now
									    that disconnect revokes grants, that round trip is destructive. */}
									<button type="button" onClick={() => connect(entry)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-bold">
										Reconnect
									</button>
									<button type="button" onClick={() => disconnect(entry)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-red hover:text-red font-bold">
										Disconnect
									</button>
								</div>
							) : (
								<button type="button" onClick={() => connect(entry)} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-bold shrink-0">
									Connect {entry.label}
								</button>
							)}
						</div>
					))}

			{msg && <p className="text-xs text-muted mt-2">{msg}</p>}
		</div>
	);
}
