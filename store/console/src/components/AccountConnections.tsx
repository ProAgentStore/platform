import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import {
	accountConnections,
	accountRows,
	connectionSummary,
	disconnectedMessage,
	disconnectPromptFor,
	type ConnectorEntry,
	needsPerAgentChoice,
} from "../lib/accountConnections";
import type { ConnectorReach } from "../lib/connectorState";
import Button from "./Button";
import Card from "./Card";

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

	const disconnect = async (entry: ConnectorEntry, accountId?: string, accountName?: string) => {
		if (!entry.flow) return;
		// Disconnecting ONE of several accounts (#715) is a different act from disconnecting the
		// connector: it does not touch the others, so it gets its own confirmation rather than the
		// provider-wide one, which would overstate what is about to happen.
		if (accountId !== undefined) {
			if (!confirm(`Disconnect the ${entry.label} account ${accountName ?? accountId}?\n\nYour other ${entry.label} accounts are unaffected. Any agent set to use THIS one will stop reading or sending until you point it at another.`)) return;
			try {
				const sep = entry.flow.disconnect.includes("?") ? "&" : "?";
				await api(`${entry.flow.disconnect}${sep}account=${encodeURIComponent(accountId)}`, { method: "DELETE" });
				setMsg(`${accountName ?? accountId} disconnected.`);
				await load();
			} catch (e) {
				setMsg(e instanceof Error ? e.message : `Failed to disconnect ${accountName ?? accountId}`);
			}
			return;
		}
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
		<Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Connections</h3>
			<p className="text-xs text-muted mb-3">
				Accounts your agents can reach. Connecting and disconnecting happens <b>here</b>, never on
				an agent — so a change on this page affects every agent that uses that account. You can
				connect more than one of the same kind; each agent then picks which to use on its own
				Settings tab, along with which folders it may read.
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
						? <span className="text-success">· connected as {githubLinked}</span>
						: <span className="text-muted">· not connected</span>}
					<p className="text-2xs text-muted-soft mt-0.5">
						Links your GitHub username so the Coder can show build status and reach your repos.
					</p>
				</div>
				<Button onClick={connectGithub} className="shrink-0">
					{githubLinked ? "Reconnect" : "Connect GitHub"}
				</Button>
			</div>
			{githubMsg && <p className="text-xs text-success mb-3 -mt-1">{githubMsg}</p>}

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
								<span className={entry.connected ? "text-success" : "text-muted"}>· {connectionSummary(entry)}</span>
								{/* Standing, not only in the confirm dialog: what a disconnect destroys should be
								    readable by someone who has NOT decided to click it yet. */}
								{entry.connected && entry.reach && entry.reach.grants > 0 && (
									<p className="text-2xs text-muted-soft mt-0.5">
										Disconnecting revokes those grants everywhere. Reconnecting will not bring them back.
									</p>
								)}
								{/* Only when there is a choice to be aware of. One account needs no list — the
								    summary line above already names it, and a one-item list reads as a
								    decision the reader has to make when there is none. */}
								{needsPerAgentChoice(entry) && (
									<ul className="mt-1.5 space-y-1">
										{accountRows(entry).map((row) => (
											<li key={row.accountId} className="flex items-center justify-between gap-2 text-2xs">
												<span className="text-muted-soft">
													{row.name}
													{row.note && <span className="text-warning"> · {row.note}</span>}
												</span>
												<button
													type="button"
													className="shrink-0 text-danger underline underline-offset-2"
													onClick={() => disconnect(entry, row.accountId, row.name)}
												>
													Disconnect
												</button>
											</li>
										))}
									</ul>
								)}
								{needsPerAgentChoice(entry) && (
									<p className="text-2xs text-muted-soft mt-1">
										Each agent must be told which of these to use, on its own Settings tab. Until it is,
										that agent will not read or send anything through {entry.label}.
									</p>
								)}
								{/* Said on the row, because the choice that decides it is made on the PROVIDER's
								    screen after you leave this one. Without it "Add or reconnect" reads as one
								    action with one outcome. */}
								{entry.connected && (
									<p className="text-2xs text-muted-soft mt-0.5">
										Choose the account at {entry.label} — picking the same one refreshes it, picking a
										different one adds it alongside.
									</p>
								)}
							</div>
							{entry.connected ? (
								/* `sm:shrink-0`, not a bare `shrink-0`, and `flex-wrap` is useless without that
								   change (#723). "Add or reconnect" is a longer label than the "Reconnect" it
								   replaced, and this row also carries "Disconnect": at 320px/1.3x the pair ran
								   5px past the viewport in Chromium and 2px in WebKit, which is the failure that
								   held CI red for two days.

								   `flex-wrap shrink-0` — the pattern at TriggersSection.tsx:587, and the one this
								   issue proposed — was tried FIRST and measured to change nothing, in both
								   engines. It cannot: a flex item's base size is its max-content width, the
								   max-content width of a wrapping flex container is still the sum of its items on
								   one line, and `shrink-0` forbids going below that. So the box stays 325px wide,
								   the buttons fit inside it, and the wrap never triggers. The wrap only becomes
								   reachable once the box is allowed to narrow. (That makes the `flex-wrap` on
								   TriggersSection:587 inert too — it is not overflowing today, but it is not
								   being held back by that class either. Left alone here; it is a separate row
								   nobody has measured.)

								   Shrinking is released only below `sm`, which is exactly where the OUTER row's
								   `flex-wrap sm:flex-nowrap` (#384, above) has already dropped these buttons onto
								   a line of their own — so there is no label column left for them to steal width
								   from, and the desktop row keeps the pin that stops them collapsing. Same
								   breakpoint, same reason, one row down. */
								<div className="flex gap-2 flex-wrap justify-end sm:shrink-0">
									{/* ONE button, because there is one action: start the provider's flow. Whether it
									    refreshes this account or adds a second is decided by which account you pick at
									    the provider, not here — so a separate "Add another" button would be the same
									    request wearing a different label.
									
									    It said "Reconnect" and offered "Add another" only once you HAD two accounts,
									    which is backwards: the affordance you need to reach two was hidden until you
									    were already there. Reconnect also remains the answer to an expired token —
									    now that disconnect revokes grants, that round trip is destructive. */}
									<Button onClick={() => connect(entry)}>Add or reconnect</Button>
									{/* `danger` rather than the muted button with a red hover it used to be: this
									    control revokes grants everywhere and does not give them back, which the
									    paragraph above says out loud. A destructive action that only looks
									    destructive once the pointer is already on it is telling you too late. */}
									{!needsPerAgentChoice(entry) && (
										<Button variant="danger" onClick={() => disconnect(entry)}>Disconnect</Button>
									)}
								</div>
							) : (
								<Button onClick={() => connect(entry)} className="shrink-0">
									Connect {entry.label}
								</Button>
							)}
						</div>
					))}

			{msg && <p className="text-xs text-muted mt-2">{msg}</p>}
		</Card>
	);
}
