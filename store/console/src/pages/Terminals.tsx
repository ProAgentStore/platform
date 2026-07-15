import { useState, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { usePolling } from "@proagentstore/sdk/hooks";
import { Terminal, RefreshCw, Bot, GitBranch, Circle, Pin } from "lucide-react";

interface TerminalInstance { instanceId: string; name: string; agentSlug: string | null; status: string; connected: boolean; bound: boolean }
interface TerminalSession { sessionId: string; instanceId: string; repoId: string; repoName: string | null; engine: string; status: string; issueNumber?: number; issueTitle?: string; updatedAt: string; terminalTail?: string | null }
interface TerminalNode { node: string; placement: string; runnerVersion: string; lastSeenAt: string | null; connected: boolean; instances: TerminalInstance[]; sessions: TerminalSession[] }

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
	status === "active" ? "text-green" : status === "suspended" ? "text-amber-400" : "text-muted-soft";

export default function Terminals() {
	const navigate = useNavigate();
	const [nodes, setNodes] = useState<TerminalNode[]>([]);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		try {
			const d = await api<{ nodes: TerminalNode[] }>("/v1/terminals/nodes");
			setNodes(d.nodes || []);
		} catch { /* keep last good */ }
		setLoading(false);
	}, []);

	// Poll so connect/disconnect + session status stay live without a manual refresh.
	usePolling(load, 5000, true);

	return (
		<div className="max-w-[1040px] mx-auto px-3 py-3 sm:px-6 sm:py-5">
			<div className="flex justify-between items-center mb-1">
				<div className="flex items-center gap-2.5">
					<Terminal size={20} className="text-accent" />
					<h1 className="font-display text-xl font-bold">Terminals</h1>
				</div>
				<button type="button" onClick={load} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold hover:border-accent hover:text-accent">
					<RefreshCw size={13} /> Refresh
				</button>
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
								<span className={`w-2.5 h-2.5 rounded-full shrink-0 ${n.connected ? "bg-green" : "bg-muted-soft"}`} title={n.connected ? "Connected" : "Disconnected"} />
								<div className="min-w-0 flex-1">
									<div className="font-semibold text-sm flex items-center gap-2 flex-wrap">
										<Terminal size={14} className="text-muted shrink-0" />
										<span className="truncate">{n.node}</span>
										<span className={`text-[0.65rem] font-bold px-1.5 py-0.5 rounded ${n.connected ? "bg-green/15 text-green" : "bg-line text-muted-soft"}`}>{n.connected ? "connected" : "offline"}</span>
									</div>
									<div className="text-xs text-muted-soft mt-0.5">
										{n.placement === "managed" ? "cloud" : "local"} · v{n.runnerVersion || "?"} · seen {ago(n.lastSeenAt)}
									</div>
								</div>
							</div>

							{/* Agents served by this machine. A 📌 marks agents PINNED to run here. */}
							<div className="px-4 py-2.5 flex flex-wrap gap-1.5 border-b border-line/60">
								<span className="text-[0.7rem] uppercase tracking-wide text-muted-soft self-center mr-1">Agents</span>
								{n.instances.map((i) => (
									<Link key={i.instanceId} to={`/instances/${i.instanceId}`} title={i.bound ? "Pinned to run on this machine" : "Served by this machine"} className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg border no-underline transition-colors ${i.bound ? "border-accent/50 bg-accent/10 text-ink" : "border-line text-ink hover:border-accent"}`}>
										<Circle size={7} className={i.connected ? "fill-green text-green" : "fill-muted-soft text-muted-soft"} />
										<Bot size={12} className="text-muted" />{i.name}
										{i.bound && <Pin size={10} className="text-accent" />}
									</Link>
								))}
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
													<span className="text-[0.7rem] font-bold text-amber-400" title="This machine is offline — open the agent to move this session to a connected machine.">active · machine offline</span>
												) : (
													<span className={`text-[0.7rem] font-bold ${sessionTone(s.status)}`}>{s.status}</span>
												)}
												<span className="text-[0.7rem] text-muted-soft">{s.engine}</span>
												{typeof s.issueNumber === "number" && <span className="text-[0.7rem] text-accent">#{s.issueNumber}</span>}
												<span className="text-[0.7rem] text-muted-soft ml-auto shrink-0">{ago(s.updatedAt)}</span>
											</div>
											{s.terminalTail && (
												<pre className="mt-1.5 text-[0.7rem] leading-snug text-muted-soft bg-black/30 rounded-md px-2 py-1.5 overflow-hidden max-h-16 whitespace-pre-wrap break-words font-mono">{s.terminalTail.slice(-400)}</pre>
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
		</div>
	);
}
