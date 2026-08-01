import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface TInstance { instanceId: string; name: string; agentSlug: string | null; status: string; connected: boolean; bound: boolean; runtime: string }
interface TSession { sessionId: string; repoName: string | null; engine: string; status: string; issueTitle?: string; updatedAt: string; terminalTail?: string | null }
interface TNode { node: string; ownerLogin: string | null; runnerVersion: string; lastSeenAt: string | null; connected: boolean; instances: TInstance[]; sessions: TSession[] }

const dot = (on: boolean) => <span className={on ? "text-green" : "text-muted-soft"}>●</span>;

export default function Terminals() {
	const [nodes, setNodes] = useState<TNode[] | null>(null);
	const [err, setErr] = useState("");

	const load = () => {
		setErr("");
		api<{ nodes: TNode[] }>("/v1/admin/terminals").then((r) => setNodes(r.nodes)).catch((e) => setErr(e.message));
	};
	useEffect(() => {
		load();
		const t = setInterval(load, 10000); // refresh liveness + tails
		return () => clearInterval(t);
	}, []);

	if (err) return <ErrorBox message={err} />;
	if (!nodes) return <Loading />;
	if (!nodes.length) return <Empty label="No CLIs connected. Runners appear here when someone runs `pags up`." />;

	return (
		<div>
			<p className="text-sm text-muted mb-3">{nodes.length} machine(s) — {nodes.filter((n) => n.connected).length} live. Auto-refreshes every 10s.</p>
			{nodes.map((n) => (
				<Panel key={`${n.ownerLogin}:${n.node}`}>
					<div className="flex items-center gap-2 mb-2">
						{dot(n.connected)}
						<span className="font-semibold font-mono">{n.node}</span>
						<span className="text-xs text-muted">{n.ownerLogin || "?"}</span>
						<span className="text-xs text-muted-soft">v{n.runnerVersion || "?"}</span>
						<span className="ml-auto text-xs text-muted-soft">{n.connected ? "online" : `last seen ${n.lastSeenAt || "—"}`}</span>
					</div>

					{n.instances.length > 0 && (
						<div className="text-sm mb-2">
							{n.instances.map((i) => (
								<span key={i.instanceId} className="inline-flex items-center gap-1 mr-3">
									{dot(i.connected)} {i.name}
									<span className="text-xs text-muted-soft">({i.runtime}{i.bound ? " · pinned" : ""})</span>
								</span>
							))}
						</div>
					)}

					{n.sessions.map((s) => (
						<div key={s.sessionId} className="mt-2 border-t border-line/50 pt-2">
							<div className="flex gap-2 text-xs text-muted mb-1">
								<Link to={`/coding-sessions/${s.sessionId}`} className="text-accent hover:underline">{s.engine}</Link>
								<span>{s.status}</span>
								{s.repoName && <span>{s.repoName}</span>}
								{s.issueTitle && <span className="truncate max-w-[240px]">{s.issueTitle}</span>}
								<span className="ml-auto">{s.updatedAt?.slice(0, 16)}</span>
							</div>
							{s.terminalTail ? (
								<pre className="text-xs bg-paper border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-56 overflow-y-auto font-mono text-muted">{s.terminalTail.split("\n").slice(-20).join("\n")}</pre>
							) : (
								<div className="text-xs text-muted-soft">no terminal output captured</div>
							)}
						</div>
					))}
					{n.instances.length === 0 && n.sessions.length === 0 && <Empty label="No runner-using agents on this machine." />}
				</Panel>
			))}
		</div>
	);
}
