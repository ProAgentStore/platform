import { useCallback, useEffect, useId, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { type Machine, machinesToShow, machineTile, type NodeDetail, pinnedWarning, runnerReading } from "../lib/runnerPanel";

/**
 * The Runner card: is this agent's machine up, and which machine should it be?
 *
 * Extracted from SettingsTab at #305 because it is the one block on that tab with its own data
 * (three endpoints), its own refresh cycle (a Refresh button plus a window-focus re-check, since
 * `pags up` can start, stop or be taken over while the tab sits open) and its own writes. Nothing
 * else on the tab reads any of it.
 *
 * Every sentence it prints is decided in `lib/runnerPanel.ts`, where the three readings this card
 * makes of two overlapping endpoints are reconciled and tested against each other — that file's
 * header says which pair used to contradict itself on screen and why.
 */
export interface RunnerPanelProps {
	instanceId: string;
}

/** `GET /v1/instances/:id/runner-node`. */
type RunnerNodeResp = { runnerNode: string | null; nodes: string[]; nodesDetail?: NodeDetail[]; resolvedNode?: string | null };

const CARD = "bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4";

export default function RunnerPanel({ instanceId }: RunnerPanelProps) {
	const runsOnLabelId = useId();
	const [runtimeInfo, setRuntimeInfo] = useState<Record<string, unknown> | null>(null);
	// Node binding: which machine this instance runs on ("" = automatic).
	const [runnerNode, setRunnerNode] = useState("");
	const [nodesDetail, setNodesDetail] = useState<NodeDetail[]>([]);
	// Where the pin actually resolves: a hostname moves under a machine, so a pin can name a
	// machine correctly and a hostname wrongly at the same time (#379). Server-computed — only it
	// holds the machine id that proves two names are one machine.
	const [resolvedNode, setResolvedNode] = useState<string | null>(null);
	const [runnerNodeMsg, setRunnerNodeMsg] = useState("");
	const [refreshing, setRefreshing] = useState(false);
	const [machines, setMachines] = useState<Machine[]>([]);
	// Does this agent use a local runtime (browser/coding)? Only then is this panel relevant.
	// Default true (show) until we learn it's cloud-only, so it never flickers off for a runner
	// agent. Set from capabilities.runtime.
	const [needsRunner, setNeedsRunner] = useState(true);

	// Re-check the runner (live RelayDO truth) on demand — used by the Refresh button and the
	// tab-focus re-check, so a just-started/stopped `pags up` reflects without a reload. Also pulls
	// the full machine list (all your `pags up` nodes) for the "Runs on" tiles.
	const refresh = useCallback(async () => {
		setRefreshing(true);
		try {
			const [st, rn, tn] = await Promise.all([
				api<Record<string, unknown>>(`/v1/instances/${instanceId}/runtime/status`).catch(() => null),
				api<RunnerNodeResp>(`/v1/instances/${instanceId}/runner-node`).catch(() => null),
				api<{ nodes: Machine[] }>(`/v1/terminals/nodes`).catch(() => null),
			]);
			if (st) setRuntimeInfo(st);
			if (rn) {
				setRunnerNode(rn.runnerNode || "");
				setNodesDetail(rn.nodesDetail || []);
				setResolvedNode(rn.resolvedNode || null);
			}
			if (tn) setMachines(tn.nodes || []);
		} finally {
			setRefreshing(false);
		}
	}, [instanceId]);

	useEffect(() => {
		refresh();
		api<{ instances?: Array<{ id: string; capabilities?: { runtime?: string | null } }> }>("/v1/instances/my/instances")
			.then((d) => {
				const mine = (d.instances || []).find((i) => i.id === instanceId);
				if (mine) setNeedsRunner(mine.capabilities?.runtime != null);
			})
			.catch(() => undefined);
	}, [instanceId, refresh]);

	// A machine can connect/disconnect (or be taken over with `pags up --force`) while this tab is
	// open, and everything here is otherwise fetched once on mount — so without this the card and
	// the picker show stale online/offline state (and a stale "⚠ machine offline") until a reload.
	useEffect(() => {
		const onFocus = () => refresh();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
		// `refresh` alone: it is a useCallback keyed on `instanceId`, so naming that too only
		// re-subscribed the listener twice for one change.
	}, [refresh]);

	const save = async (node: string) => {
		setRunnerNode(node);
		setRunnerNodeMsg("Saving…");
		try {
			await api(`/v1/instances/${instanceId}/runner-node`, { method: "PUT", body: JSON.stringify({ runnerNode: node || null }) });
			setRunnerNodeMsg(node ? `Pinned to ${node}` : "Set to automatic");
		} catch (e) {
			setRunnerNodeMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	if (!needsRunner) {
		return (
			<div className={`${CARD} text-sm text-muted`}>
				<h3 className="text-base font-bold mb-1">Runner</h3>
				This agent runs entirely in the cloud — no local runner (<code className="text-accent">pags up</code>) needed.
			</div>
		);
	}

	const reading = runnerReading(runtimeInfo, nodesDetail, runnerNode);
	const warning = pinnedWarning(runnerNode, nodesDetail, resolvedNode);
	const tiles = machinesToShow(machines, runnerNode, instanceId, nodesDetail);
	// Why it isn't attached, computed server-side (#237). The panel used to show only an amber
	// "agent not attached", which is a symptom with no cause and no remedy — the CLI knew both and
	// printed them to a terminal nobody was watching.
	const attachment = (runtimeInfo as { attachment?: { message?: string; remedy?: string | null } } | null)?.attachment;

	return (
		<div className={CARD}>
			<div className="flex items-center justify-between gap-2 mb-1">
				<h3 className="text-base font-bold">Runner</h3>
				<button type="button" onClick={refresh} disabled={refreshing} className="text-xs px-2.5 py-1 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold disabled:opacity-50">{refreshing ? "Refreshing…" : "Refresh"}</button>
			</div>
			<div className="text-sm text-muted leading-relaxed">
				{runtimeInfo ? (
					<>
						Status: <span className={reading.online ? "text-green" : ""}>{reading.online ? "Online" : "Offline"}</span>
						{/* Agent's own socket down while the machine is up for OTHER agents. */}
						{!reading.online && reading.pinnedNodeOnline && <span className="text-amber-500"> · machine online, agent not attached</span>}
						{reading.node && <> · Node: {reading.node}</>}
						{/* The cause + the one command that fixes it. `pags up` is the WRONG advice when the
						    machine is already running, which is exactly the confusing case. */}
						{!reading.online && attachment?.message && (
							<div className="mt-1 text-[0.8rem] text-muted-soft">
								{attachment.message}
								{attachment.remedy && (
									<> Run <code className="px-1 py-0.5 rounded bg-paper border border-line font-mono text-[0.75rem]">{attachment.remedy}</code>.</>
								)}
							</div>
						)}
					</>
				) : (
					"Checking runner status..."
				)}
			</div>

			{/* Node binding — ONE machine per agent (no auto-any). A tile per machine you run
			    `pags up` on; click one to bind this agent there. */}
			{/* This <label> named nothing — what it labels is the GRID of machine tiles, and a label
			    can only name one form control. A named group announces the same thing. */}
			{/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> renders its <legend> inside its own top border, and the only border here IS a top rule — role="group" carries the same semantics without cutting the rule in half. */}
			<div className="mt-3 pt-3 border-t border-line/60" role="group" aria-labelledby={runsOnLabelId}>
				<div id={runsOnLabelId} className="block text-sm font-semibold mb-1">Runs on</div>
				<p className="text-xs text-muted-soft mb-2">
					Bind this agent to exactly one machine running <code className="text-accent">pags up</code> — its runner tasks (chat tools, apply, coding) route there.
				</p>
				{tiles.length === 0 ? (
					<div className="text-xs text-muted px-3 py-3 border border-dashed border-line rounded-lg">
						No machines connected yet. Run <code className="text-accent">pags up</code> on a machine — it appears here and on the <span className="text-accent">Terminals</span> page.
					</div>
				) : (
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
						{tiles.map((m) => {
							const t = machineTile(m, instanceId, runnerNode);
							return (
								<button
									key={t.node}
									type="button"
									onClick={() => save(t.node)}
									aria-pressed={t.pinned}
									title={t.pinned ? "This agent is bound to this machine" : "Bind this agent to this machine"}
									className={`text-left rounded-xl border p-3 transition-colors ${t.pinned ? "border-accent bg-accent/10" : "border-line bg-paper hover:border-accent/60"}`}
								>
									<div className="flex items-center gap-2 min-w-0">
										<span className={`w-2.5 h-2.5 rounded-full shrink-0 ${t.tone === "attached" ? "bg-green" : t.tone === "online" ? "bg-amber-500" : "bg-muted-soft"}`} />
										<span className="font-semibold text-sm truncate">{t.node}</span>
										{t.pinned && <span className="ml-auto shrink-0 text-[0.6rem] font-bold uppercase tracking-wide text-accent border border-accent/40 rounded px-1.5 py-0.5">Pinned</span>}
									</div>
									<div className={`text-[0.7rem] mt-1 ${t.tone === "attached" ? "text-green" : t.tone === "online" ? "text-amber-500" : "text-muted-soft"}`}>{t.statusText}</div>
									<div className="text-[0.7rem] text-muted-soft mt-0.5">{t.meta}</div>
									{/* The names this machine used to answer to (#393). Shown rather than swallowed:
									    pins, relay names and session rows are all still keyed by hostname, so this
									    is what a stranded pin literally says — and it is how the user recognises
									    their own laptop under last week's name. */}
									{t.alsoKnownAs && <div className="text-[0.7rem] text-muted-soft mt-0.5 truncate">{t.alsoKnownAs}</div>}
								</button>
							);
						})}
					</div>
				)}
				{/* The pin names a hostname this machine has stopped using, and the SAME machine is
				    here under another one — so it is already serving this agent. Say it out loud
				    rather than repointing silently: only the USER can decide that a pin should now
				    read differently, and a silent rewrite is indistinguishable from the platform
				    moving their agent to a machine they did not choose (#379). */}
				{warning === "renamed" && (
					<p className="text-xs text-muted mt-2">
						Pinned to <b>{runnerNode}</b>, which this machine no longer calls itself — it now reports as <b>{resolvedNode}</b>, and this agent is running there.{" "}
						<button type="button" onClick={() => resolvedNode && save(resolvedNode)} className="underline text-accent font-semibold">Repin to {resolvedNode}</button>
					</p>
				)}
				{/* Pinned machine not serving THIS agent → guidance (machine-online vs fully-offline). */}
				{warning === "not_attached" && (
					<p className="text-xs text-amber-500 mt-2">
						⚠ <b>{runnerNode}</b> is online, but this agent isn't attached to it yet. Restart <code className="text-accent">pags up</code> on it (it attaches newly-subscribed agents on start).
					</p>
				)}
				{warning === "offline" && (
					<p className="text-xs text-amber-500 mt-2">
						⚠ <b>{runnerNode}</b> isn't connected. This agent's runner tasks won't run until you start <code className="text-accent">pags up</code> on it, or pick another machine.
					</p>
				)}
				{!runnerNode && tiles.length > 0 && <p className="text-xs text-amber-500 mt-2">Pick a machine above to run this agent on.</p>}
				{runnerNodeMsg && <p className="text-xs text-muted mt-1">{runnerNodeMsg}</p>}
			</div>
		</div>
	);
}
