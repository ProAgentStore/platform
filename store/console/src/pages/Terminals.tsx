import { useState, useCallback, useEffect } from "react";
import Page from "../components/Page";
import Button from "../components/Button";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { renderTerminal, terminalTail } from "@proagentstore/sdk/ui";
import { SafeHtmlView } from "@proagentstore/sdk/ui-react";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { terminalsBusy } from "../lib/pollBusy";
import { Terminal, RefreshCw, Bot, GitBranch, Circle, Pin, PinOff } from "lucide-react";

interface TerminalInstance { instanceId: string; name: string; agentSlug: string | null; status: string; connected: boolean; bound: boolean; pinnedNode?: string | null }
interface TerminalSession { sessionId: string; instanceId: string; repoId: string; repoName: string | null; engine: string; status: string; issueNumber?: number; issueTitle?: string; updatedAt: string; terminalTail?: string | null }
interface TerminalNode { node: string; aka?: string[]; machineId?: string | null; identityHint?: string | null; placement: string; runnerVersion: string; lastSeenAt: string | null; connected: boolean; instances: TerminalInstance[]; sessions: TerminalSession[] }

function ago(iso: string | null): string {
	if (!iso) return "never";
	const t = Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
	if (Number.isNaN(t)) return iso;
	const s = Math.max(0, Math.round((Date.now() - t) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

const sessionTone = (status: string) =>
	status === "active" ? "text-success" : status === "suspended" ? "text-amber-400" : "text-muted-soft";

/**
 * The two facts a green dot used to run together (#531).
 *
 *   "routed"   — this agent holds a socket here AND its runner calls arrive here.
 *   "stranded" — it holds a socket here and the pin sends its work to another machine, so nothing
 *                of this agent's runs on this one however alive the dot looks.
 *   "off"      — no socket here.
 *
 * Routing is `getBoundRunnerConn`: a pin is authoritative and never falls through, so a pin
 * elsewhere excludes this machine outright. UNPINNED is the case a boolean could not express —
 * routing then follows whichever machine holds a live socket, so a connected chip IS a routed one,
 * which is why `pinnedNode` (the name, or null) travels rather than a second flag.
 */
function instanceRouting(i: TerminalInstance): "routed" | "stranded" | "off" {
	if (!i.connected) return "off";
	return i.bound || !i.pinnedNode ? "routed" : "stranded";
}

export default function Terminals() {
	const navigate = useNavigate();
	const [nodes, setNodes] = useState<TerminalNode[]>([]);
	const [loading, setLoading] = useState(true);
	/** node name → why the last forget was refused, rendered on that machine's card. */
	const [forgetError, setForgetError] = useState<Record<string, string>>({});
	const [forgetting, setForgetting] = useState("");

	const load = useCallback(async () => {
		try {
			const d = await api<{ nodes: TerminalNode[] }>("/v1/terminals/nodes");
			setNodes(d.nodes || []);
		} catch { /* keep last good */ }
		setLoading(false);
	}, []);

	// Forget a machine (#393). A node row is written on register and never removed, so a laptop
	// renamed by DHCP leaves its old names on the account forever, listed as offline machines the
	// owner recognises as their own. Deliberately a confirmed USER action and never a stale-sweep:
	// a laptop that is merely closed must not lose its registrations.
	//
	// The server refuses while an agent is pinned here or a session is open, and the refusal is the
	// useful half — it names what to repoint. So it is shown on the card rather than thrown away.
	const forget = useCallback(async (n: TerminalNode) => {
		const names = [n.node, ...(n.aka || [])];
		const also = names.length > 1 ? `\n\nThis machine has also been known as: ${names.slice(1).join(", ")}. All of its registrations are removed.` : "";
		if (!confirm(`Forget "${n.node}"?${also}\n\nIt disappears from this page. Nothing on the machine changes — running \`pags up\` there registers it again.`)) return;
		setForgetting(n.node);
		setForgetError((e) => ({ ...e, [n.node]: "" }));
		try {
			await api(`/v1/terminals/nodes/${encodeURIComponent(n.node)}`, { method: "DELETE" });
			await load();
		} catch (err) {
			setForgetError((e) => ({ ...e, [n.node]: err instanceof Error ? err.message : String(err) }));
		}
		setForgetting("");
	}, [load]);

	// The poll hook only fires on the interval (its catch-up fetch is for tier CHANGES, and first
	// mount is deliberately not one), so without a mount fetch the page showed "Loading…"
	// for 5s on every visit even with machines already connected.
	useEffect(() => {
		void load();
	}, [load]);
	// Poll so connect/disconnect + session status stay live without a manual refresh — but only
	// while there is something to see change (#272). Full 5s while a machine is believed OFFLINE
	// or missing (the state the user is fixing with `pags up`, and the one #241 showed must never
	// slow down) or while a coding session is active; 20s for a settled, fully-connected fleet,
	// which is a set of booleans that change about twice a day; nothing in a hidden tab, with an
	// immediate re-fetch the moment it is looked at again.
	useTieredPolling(load, { activeMs: 5000, passiveMs: 20000 }, terminalsBusy(nodes));

	return (
		<Page width={1040}>
			<div className="flex justify-between items-center mb-1">
				<div className="flex items-center gap-2.5">
					<Terminal size={20} className="text-accent" />
					<h1 className="font-display text-xl font-bold">Terminals</h1>
				</div>
				<Button onClick={load}>
					<RefreshCw size={13} /> Refresh
				</Button>
			</div>
			<p className="text-sm text-muted mb-4">Every machine running <code className="text-accent">pags up</code> under your account — across all your agents.</p>

			{loading && nodes.length === 0 ? (
				<p className="text-center py-8 text-muted text-sm">Loading…</p>
			) : nodes.length === 0 ? (
				<div className="text-center py-10 px-4 bg-panel border border-line rounded-xl">
					<Terminal size={28} className="mx-auto text-muted-soft mb-2" />
					<div className="font-semibold text-sm">No terminals connected</div>
					<div className="text-sm text-muted mt-1">Install the CLI and run <code className="text-accent">pags up</code> on any machine — it shows up here.</div>
				</div>
			) : (
				<div className="flex flex-col gap-3">
					{nodes.map((n) => (
						<div key={n.node} className="bg-panel border border-line rounded-xl overflow-hidden">
							{/* Machine header */}
							<div className="flex items-center gap-2.5 px-4 py-3 border-b border-line">
								<span className={`w-2.5 h-2.5 rounded-full shrink-0 ${n.connected ? "bg-success" : "bg-muted-soft"}`} title={n.connected ? "Connected" : "Disconnected"} />
								<div className="min-w-0 flex-1">
									<div className="font-semibold text-sm flex items-center gap-2 flex-wrap">
										<Terminal size={14} className="text-muted shrink-0" />
										<span className="truncate">{n.node}</span>
										{/* Last week's name for the same machine (#393) — the string a stranded pin
										    still carries, so it is what makes the fold recognisable rather than magic. */}
										{/* `min-w-0`, NOT `shrink-0`: a flex item that refuses to shrink gives `truncate`
									    no width to clamp to, so at 320px a machine with two old names drew its
									    "also …" line straight out of the card and under the Forget button. Measured
									    in WebKit; the horizontal-overflow guards cannot see it, because the text
									    escapes its own box without widening the document. */}
									{!!n.aka?.length && <span className="text-2xs text-muted-soft truncate min-w-0">also {n.aka.join(" · ")}</span>}
										<span className={`text-2xs font-bold px-1.5 py-0.5 rounded ${n.connected ? "bg-success-soft text-success" : "bg-line text-muted-soft"}`}>{n.connected ? "connected" : "offline"}</span>
									</div>
									<div className="text-xs text-muted-soft mt-0.5">
										{n.placement === "managed" ? "cloud" : "local"} · v{n.runnerVersion || "?"} · seen {ago(n.lastSeenAt)}
									</div>
								</div>
								{/* Forgetting a CONNECTED machine is refused by the server anyway (it would
								    re-register within a heartbeat), so the button is not offered for one —
								    a control whose only outcome is a refusal reads as broken. */}
								{!n.connected && (
									<Button variant="danger" size="sm" onClick={() => void forget(n)} disabled={forgetting === n.node}
										title="Remove this machine's registrations. Nothing on the machine changes."
										className="shrink-0">
										{forgetting === n.node ? "Forgetting…" : "Forget"}
									</Button>
								)}
							</div>

							{/* Why this machine has no stable identity, and what to do about it (#393). Without
							    it, a runner too old to mint an id looks exactly like one that had nothing to
							    merge — the machine keeps appearing under its old names and the fix looks like
							    it did nothing. */}
							{n.identityHint && (
								<div className="px-4 py-2 text-xs text-warning border-b border-line/60">{n.identityHint}</div>
							)}

							{/* The refusal is the useful half — it names the pins or sessions to clear first. */}
							{forgetError[n.node] && (
								<div className="px-4 py-2 text-xs text-danger border-b border-line/60">{forgetError[n.node]}</div>
							)}

							{/* Agents served by this machine. A 📌 marks agents PINNED to run here; a struck-
							    through pin marks one that is CONNECTED here and pinned somewhere else, so
							    nothing of it runs on this machine (#531). Both used to wear the same green
							    dot, so a machine an agent never reaches looked exactly like the machine it
							    runs on — which is the claim the agent's own Runner card was contradicting
							    one page over. */}
							<div className="px-4 py-2.5 flex flex-wrap gap-1.5 border-b border-line/60">
								<span className="text-2xs uppercase tracking-wide text-muted-soft self-center mr-1">Agents</span>
								{n.instances.map((i) => {
									const routing = instanceRouting(i);
									return (
										<Link key={i.instanceId} to={`/instances/${i.instanceId}`}
											title={routing === "stranded"
												? `Connected here, but this agent is pinned to ${i.pinnedNode} — its work runs there, not on this machine.`
												: i.bound ? "Pinned to run on this machine" : "Served by this machine"}
											className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs px-2 py-1 rounded-lg border no-underline transition-colors max-w-full min-w-0 ${i.bound ? "border-accent/50 bg-accent-soft text-ink" : "border-line text-ink hover:border-accent"}`}>
											<Circle size={7} className={`shrink-0 ${routing === "routed" ? "fill-success text-success" : routing === "stranded" ? "fill-warning text-warning" : "fill-muted-soft text-muted-soft"}`} />
											<Bot size={12} className="text-muted shrink-0" /><span className="truncate min-w-0">{i.name}</span>
											{i.bound && <Pin size={10} className="text-accent shrink-0" />}
											{/* Said out loud, not only in a `title`: a phone has no hover, and this is
											    the one chip whose colour alone would be read as "all good".
											    `basis-full` gives it its OWN line inside the chip — sharing one line
											    with the agent name truncated BOTH at 320px, and an agent you cannot
											    name is a worse chip than a taller one. */}
											{routing === "stranded" && (
												<span className="basis-full flex items-center gap-1 text-2xs text-warning min-w-0">
													<PinOff size={10} className="shrink-0" />
													<span className="truncate min-w-0">runs on {i.pinnedNode}</span>
												</span>
											)}
										</Link>
									);
								})}
							</div>

							{/* Coding sessions on this machine */}
							{n.sessions.length > 0 ? (
								<div className="divide-y divide-line/50">
									{n.sessions.map((s) => (
										<button key={s.sessionId} type="button" onClick={() => navigate(`/instances/${s.instanceId}/coding/${s.sessionId}`)}
											className="w-full text-left px-4 py-2.5 hover:bg-panel-hover transition-colors">
											<div className="flex items-center gap-2 text-sm">
												<GitBranch size={13} className="text-muted shrink-0" />
												<span className="font-semibold truncate">{s.repoName || s.repoId}</span>
												{/* An "active" session under an offline machine is stranded — its runner is gone.
												    Don't paint it green; show it amber with the reason so it reads as "not running". */}
												{s.status === "active" && !n.connected ? (
													<span className="text-2xs font-bold text-amber-400" title="This machine is offline — open the agent to move this session to a connected machine.">active · machine offline</span>
												) : (
													<span className={`text-2xs font-bold ${sessionTone(s.status)}`}>{s.status}</span>
												)}
												<span className="text-2xs text-muted-soft">{s.engine}</span>
												{typeof s.issueNumber === "number" && <span className="text-2xs text-accent">#{s.issueNumber}</span>}
												<span className="text-2xs text-muted-soft ml-auto shrink-0">{ago(s.updatedAt)}</span>
											</div>
											{s.terminalTail && (
												// Colorized with the SAME renderer the Coder uses (#187) — this pane used to be
												// a plain uncolorized <pre> purely because the colorizer lived inside one agent's
												// package. The renderer escapes every byte; see terminal-render.ts.
												<SafeHtmlView
													as="pre"
													className="mt-1.5 text-2xs leading-snug bg-black/30 rounded-md px-2 py-1.5 overflow-hidden max-h-16 whitespace-pre-wrap break-words font-mono"
													html={renderTerminal(terminalTail(s.terminalTail, 400))}
												/>
											)}
										</button>
									))}
								</div>
							) : (
								<div className="px-4 py-2.5 text-xs text-muted-soft">No coding sessions on this machine.</div>
							)}
						</div>
					))}
				</div>
			)}
		</Page>
	);
}
