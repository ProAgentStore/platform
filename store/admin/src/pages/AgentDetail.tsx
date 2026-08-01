import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface Detail {
	agent: { id: string; slug: string; name: string; category: string; model: string; visibility: string; status: string; created_at: string; owner_login: string | null; instances: number; connectors: string[] };
	capabilities: { surfaces: string[]; runtime: string | null; workflow: string | null; tools: string[] };
	connectorTools: Array<{ connector: string; tools: Array<{ name: string; scope: string }> }>;
	instances: Array<{ id: string; owner_login: string | null; status: string; created_at: string; consents: Array<{ connector: string; scope: string }> }>;
}

export default function AgentDetail() {
	const { id } = useParams();
	const [d, setD] = useState<Detail | null>(null);
	const [err, setErr] = useState("");
	useEffect(() => { if (!id) return; api<Detail>(`/v1/admin/agents/${encodeURIComponent(id)}`).then(setD).catch((e) => setErr(e.message)); }, [id]);

	if (err) return <ErrorBox message={err} />;
	if (!d) return <Loading />;
	const a = d.agent;

	return (
		<div>
			<Link to="/agents" className="text-sm text-muted hover:text-ink">← Agents</Link>
			<h1 className="font-display text-xl font-bold mt-1 mb-1">{a.name} <span className="text-muted-soft text-base font-normal">{a.slug}</span></h1>
			<p className="text-sm text-muted mb-4">
				owner {a.owner_login || "—"} · {a.category} · {a.model || "no model"} · {a.visibility}/{a.status} · {a.instances} active instance(s)
				{d.capabilities.runtime ? ` · runtime: ${d.capabilities.runtime}` : ""}{d.capabilities.workflow ? ` · workflow: ${d.capabilities.workflow}` : ""}
			</p>

			<Panel title={`Connectors (${d.connectorTools.length})`}>
				{!d.connectorTools.length ? <Empty label="This agent declares no connector tools." /> : (
					<div className="space-y-3">
						{d.connectorTools.map((c) => (
							<div key={c.connector} className="border-b border-line/50 pb-2">
								<div className="font-semibold">{c.connector}</div>
								<div className="flex flex-wrap gap-1.5 mt-1">
									{c.tools.map((t) => (
										<span key={t.name} className="text-xs bg-paper border border-line rounded px-1.5 py-0.5 font-mono">
											{t.name}<span className={t.scope === "write" ? "text-yellow" : "text-muted-soft"}> ·{t.scope}</span>
										</span>
									))}
								</div>
							</div>
						))}
					</div>
				)}
			</Panel>

			<Panel title={`Instances (${d.instances.length}) — connector write consents`}>
				{!d.instances.length ? <Empty label="No instances." /> : (
					<table className="w-full text-sm">
						<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
							<th className="py-1.5">Owner</th><th>Status</th><th>Created</th><th>Write consents</th>
						</tr></thead>
						<tbody>
							{d.instances.map((i) => (
								<tr key={i.id} className="border-b border-line/50">
									<td className="py-1.5">{i.owner_login || "—"}</td>
									<td>{i.status}</td>
									<td className="text-muted">{i.created_at?.slice(0, 10)}</td>
									<td>
										{i.consents.length
											? i.consents.map((c) => <span key={`${c.connector}:${c.scope}`} className="text-xs text-yellow mr-2">{c.connector}·{c.scope}</span>)
											: <span className="text-muted-soft">none</span>}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Panel>

			<Panel title="All capability tools">
				<div className="flex flex-wrap gap-1.5">
					{d.capabilities.tools.length
						? d.capabilities.tools.map((t) => <span key={t} className="text-xs bg-paper border border-line rounded px-1.5 py-0.5 font-mono">{t}</span>)
						: <span className="text-muted-soft text-sm">Default toolset (no explicit allowlist).</span>}
				</div>
			</Panel>
		</div>
	);
}
