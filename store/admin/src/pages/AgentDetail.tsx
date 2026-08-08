import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { AuditTrail, DangerAction } from "../lib/moderation";
import { deleteAgentRequest } from "../lib/moderation-policy";
import { Empty, ErrorBox, Loading, Panel, Stat } from "../lib/ui";

interface Detail {
	agent: { id: string; slug: string; name: string; category: string; model: string; visibility: string; status: string; created_at: string; owner_id: string; owner_login: string | null; instances: number; connectors: string[] };
	capabilities: { surfaces: string[]; runtime: string | null; workflow: string | null; tools: string[] };
	connectorTools: Array<{ connector: string; tools: Array<{ name: string; scope: string }> }>;
	instances: Array<{ id: string; owner_login: string | null; status: string; created_at: string; consents: Array<{ connector: string; scope: string }> }>;
	subscribers: { total: number; active: number };
	recentActivity: Array<{ id: string; ts: number; instance_id: string | null; source: string; level: string; event: string; message: string | null }>;
}

const levelColor = (l: string) => (l === "error" ? "text-danger" : l === "warn" ? "text-warning" : "text-muted");

export default function AgentDetail() {
	const { id } = useParams();
	const navigate = useNavigate();
	const [d, setD] = useState<Detail | null>(null);
	const [err, setErr] = useState("");
	const [refresh, setRefresh] = useState(0);

	const load = useCallback(() => {
		if (!id) return;
		api<Detail>(`/v1/admin/agents/${encodeURIComponent(id)}`).then(setD).catch((e) => setErr(e.message));
	}, [id]);
	useEffect(load, [load]);

	if (err) return <ErrorBox message={err} />;
	if (!d) return <Loading />;
	const a = d.agent;

	return (
		<div>
			<Link to="/agents" className="text-sm text-muted hover:text-ink">← Agents</Link>
			<h1 className="font-display text-xl font-bold mt-1 mb-1">{a.name} <span className="text-muted-soft text-base font-normal">{a.slug}</span></h1>
			<p className="text-sm text-muted mb-4">
				owner <Link to={`/users/${encodeURIComponent(a.owner_id)}`} className="text-accent hover:underline">{a.owner_login || a.owner_id}</Link> · {a.category} · {a.model || "no model"} · {a.visibility}/{a.status}
				{d.capabilities.runtime ? ` · runtime: ${d.capabilities.runtime}` : ""}{d.capabilities.workflow ? ` · workflow: ${d.capabilities.workflow}` : ""}
			</p>

			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
				<Stat label="Active subscribers" value={d.subscribers.active} accent={d.subscribers.active > 0} />
				<Stat label="Subscribers ever" value={d.subscribers.total} />
				<Stat label="Connectors" value={a.connectors.length} />
				<Stat label="Declared tools" value={d.capabilities.tools.length || "default"} />
			</div>

			<Panel title="Moderation">
				<p className="text-xs text-muted mb-3">
					Operator actions on this agent. Every one writes to the admin audit log below, including the before-state.
				</p>
				<div className="flex flex-wrap items-start gap-3">
					<DangerAction
						label="Unpublish"
						tone="neutral"
						description="Pulls the agent from the public catalog (visibility → draft). Reversible by the creator; instances and config are untouched."
						disabled={a.visibility === "draft"}
						disabledReason={a.visibility === "draft" ? "already a draft" : undefined}
						run={async () => {
							await api(`/v1/admin/agents/${encodeURIComponent(a.id)}/unpublish`, { method: "POST" });
							return "Unpublished.";
						}}
						onDone={() => { load(); setRefresh((n) => n + 1); }}
					/>
					<DangerAction
						label="Delete agent"
						description={`Irreversible. Deletes the agent, its executions and its usage rows. ${d.subscribers.active} subscriber instance(s) are currently active.`}
						confirmPhrase={a.slug}
						forceable
						forceLabel={`Cancel ${d.subscribers.active || "all"} subscriber(s) & delete`}
						run={async ({ force, confirmed }) => {
							// Built from what the operator TYPED, not from `a.slug` — so a regressed
							// UI gate cannot still produce a valid delete that the server's own echo
							// check would wave through (lib/moderation-policy.ts).
							const r = await api<{ canceledInstances: number }>(`/v1/admin/agents/${encodeURIComponent(a.id)}`, {
								method: "DELETE",
								body: JSON.stringify(deleteAgentRequest(a.slug, confirmed, force)),
							});
							return `Deleted (${r.canceledInstances} instance(s) canceled).`;
						}}
						onDone={() => navigate("/agents")}
					/>
				</div>
			</Panel>

			<div className="grid md:grid-cols-2 gap-4">
				<Panel title={`Connectors (${d.connectorTools.length})`}>
					{!d.connectorTools.length ? <Empty label="This agent declares no connector tools." /> : (
						<div className="space-y-3">
							{d.connectorTools.map((c) => (
								<div key={c.connector} className="border-b border-line/50 pb-2">
									<div className="font-semibold">{c.connector}</div>
									<div className="flex flex-wrap gap-1.5 mt-1">
										{c.tools.map((t) => (
											<span key={t.name} className="text-xs bg-paper border border-line rounded px-1.5 py-0.5 font-mono">
												{t.name}<span className={t.scope === "write" ? "text-warning" : "text-muted-soft"}> ·{t.scope}</span>
											</span>
										))}
									</div>
								</div>
							))}
						</div>
					)}
				</Panel>

				<Panel title="All capability tools">
					<div className="flex flex-wrap gap-1.5">
						{d.capabilities.tools.length
							? d.capabilities.tools.map((t) => <span key={t} className="text-xs bg-paper border border-line rounded px-1.5 py-0.5 font-mono">{t}</span>)
							: <span className="text-muted-soft text-sm">Default toolset (no explicit allowlist).</span>}
					</div>
					{d.capabilities.surfaces.length ? (
						<div className="text-xs text-muted mt-3">surfaces: {d.capabilities.surfaces.join(", ")}</div>
					) : null}
				</Panel>
			</div>

			<Panel
				title={`Subscribers (${d.instances.length}) — connector write consents`}
				right={<Link to={`/instances?agent=${encodeURIComponent(a.slug || a.id)}`} className="text-xs text-accent hover:underline">Open in Instances →</Link>}
			>
				{!d.instances.length ? <Empty label="Nobody has subscribed to this agent." /> : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
								<th className="py-1.5">Owner</th><th>Status</th><th>Created</th><th>Write consents</th><th />
							</tr></thead>
							<tbody>
								{d.instances.map((i) => (
									<tr key={i.id} className="border-b border-line/50 hover:bg-panel-hover">
										<td className="py-1.5">{i.owner_login || "—"}</td>
										<td>{i.status}</td>
										<td className="text-muted">{i.created_at?.slice(0, 10)}</td>
										<td>
											{i.consents.length
												? i.consents.map((c) => <span key={`${c.connector}:${c.scope}`} className="text-xs text-warning mr-2">{c.connector}·{c.scope}</span>)
												: <span className="text-muted-soft">none</span>}
										</td>
										<td className="text-right"><Link to={`/instances/${i.id}`} className="text-xs text-accent hover:underline">detail →</Link></td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Panel>

			{/* "Is this agent working for anyone" — events across EVERY instance of it,
			    which no per-tenant trace can answer. */}
			<Panel title={`Recent activity (${d.recentActivity.length})`}>
				{!d.recentActivity.length ? <Empty label="No recorded events across this agent's instances." /> : (
					<div className="space-y-0.5">
						{d.recentActivity.map((e) => (
							<div key={e.id} className="text-sm border-b border-line/50 py-1">
								<span className="text-muted-soft text-xs">{new Date(e.ts).toISOString().slice(5, 16).replace("T", " ")} </span>
								<span className={levelColor(e.level)}>{e.event}</span>
								<span className="text-muted-soft text-xs"> [{e.source}]</span>
								{e.message ? <span className="text-muted"> {e.message.slice(0, 160)}</span> : null}
								{e.instance_id ? (
									<Link to={`/instances/${e.instance_id}`} className="text-xs text-accent hover:underline ml-2">instance →</Link>
								) : null}
							</div>
						))}
					</div>
				)}
			</Panel>

			<Panel title="Admin audit trail">
				<AuditTrail targetId={a.id} refresh={refresh} />
			</Panel>
		</div>
	);
}
