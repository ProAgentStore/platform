import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtInt, fmtUsd } from "../lib/api";
import { AuditTrail, DangerAction } from "../lib/moderation";
import { Empty, ErrorBox, LiveDot, Loading, Panel } from "../lib/ui";

interface Detail {
	instance: {
		id: string;
		agent_id: string;
		user_id: string;
		status: string;
		config: string;
		created_at: string;
		updated_at: string;
		agent_name: string | null;
		agent_slug: string | null;
		owner_login: string | null;
	};
	/** True when at least one registered machine has a live relay socket right now. */
	runtimeConnected: boolean;
	runtimeNodes: Array<{ runner_node: string; placement: string; status: string; last_seen_at: string | null; runner_version: string; capabilities: string; created_at: string; updated_at: string; connected: boolean }>;
	boardItems: Array<{ job_key: string; user_status: string | null; title: string; subtitle: string; url: string; updated_at: string }>;
	consents: Array<{ connector: string; scope: string; created_at: string }>;
	recentErrors: Array<{ id: string; created_at: string; source: string; status: number | null; message: string }>;
	/** Two dollar figures, never one (#346): list-price value, and the charged subset of it. */
	usage30d: { calls: number; input_tokens: number; output_tokens: number; value_micros: number; charged_micros: number };
}

export default function InstanceDetail() {
	const { id } = useParams();
	const [d, setD] = useState<Detail | null>(null);
	const [err, setErr] = useState("");
	const [refresh, setRefresh] = useState(0);

	const load = useCallback(() => {
		if (!id) return;
		api<Detail>(`/v1/admin/instances/${encodeURIComponent(id)}/detail`).then(setD).catch((e) => setErr(e.message));
	}, [id]);
	useEffect(load, [load]);

	if (err) return <ErrorBox message={err} />;
	if (!d) return <Loading />;
	const i = d.instance;
	const u = d.usage30d;

	return (
		<div>
			<Link to="/instances" className="text-sm text-muted hover:text-ink">← Instances</Link>
			<h1 className="font-display text-xl font-bold mt-1 mb-1">
				{i.agent_name || "?"} <span className="text-muted-soft text-base font-normal">{i.agent_slug || ""}</span>
			</h1>
			<p className="text-sm text-muted mb-4">
				owner <Link to={`/users/${encodeURIComponent(i.user_id)}`} className="text-accent hover:underline">{i.owner_login || i.user_id}</Link>
				{" · "}status {i.status} · runtime <LiveDot connected={d.runtimeConnected} noRunner={!d.runtimeNodes.length} />
				{" · "}created {i.created_at?.slice(0, 10)} · <span className="font-mono text-xs">{i.id}</span>
				{i.agent_slug ? <> · <Link to={`/agents/${encodeURIComponent(i.agent_slug)}`} className="text-accent hover:underline">agent →</Link></> : null}
				{" · "}<Link to={`/instances/${i.id}/trace`} className="text-accent hover:underline">trace →</Link>
			</p>

			<Panel title="Moderation">
				<p className="text-xs text-muted mb-3">Operator actions on this subscription. Recorded in the audit log below.</p>
				<DangerAction
					label="Cancel subscription"
					description="Marks this instance and its subscription canceled. The owner keeps their data; the agent stops running for them."
					withReason
					disabled={i.status === "canceled"}
					disabledReason={i.status === "canceled" ? "already canceled" : undefined}
					confirmPhrase={i.owner_login || undefined}
					run={async ({ reason }) => {
						await api(`/v1/admin/instances/${encodeURIComponent(i.id)}/cancel`, {
							method: "POST",
							body: JSON.stringify({ reason }),
						});
						return "Canceled.";
					}}
					onDone={() => { load(); setRefresh((n) => n + 1); }}
				/>
			</Panel>

			<div className="grid md:grid-cols-2 gap-4">
				<Panel title={`Runtime nodes (${d.runtimeNodes.length})`}>
					{!d.runtimeNodes.length ? <Empty label="No runners registered." /> : (
						<>
							<div className="overflow-x-auto">
								<table className="w-full text-sm">
									<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
										<th className="py-1.5">Node</th><th>Live</th><th>Reported</th><th>Version</th><th>Last seen</th>
									</tr></thead>
									<tbody>
										{d.runtimeNodes.map((n) => (
											<tr key={n.runner_node} className="border-b border-line/50">
												<td className="py-1.5 font-mono text-xs">{n.runner_node}</td>
												<td><LiveDot connected={n.connected} /></td>
												<td className={n.status === "online" && !n.connected ? "text-warning text-xs" : "text-muted text-xs"}>{n.status}</td>
												<td className="text-muted">{n.runner_version || "—"}</td>
												<td className="text-muted">{n.last_seen_at?.slice(5, 16) || "—"}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							{/* The DB column is not cleared on an unclean disconnect, so a machine that
							    died days ago still reads "online". Live is the relay socket; say so. */}
							<p className="text-xs text-muted-soft mt-2">
								<span className="text-warning">Reported</span> is the DB column, which is not cleared when a machine drops —
								trust <span className="text-success">Live</span> (the relay socket).
							</p>
						</>
					)}
				</Panel>

				<Panel title="30-day usage">
					<div className="grid grid-cols-2 gap-3 text-sm">
						<div><div className="text-2xl font-bold text-accent">{fmtUsd(u.value_micros)}</div><div className="text-xs text-muted mt-1">AI value (list price)</div></div>
						<div><div className="text-2xl font-bold">{fmtUsd(u.charged_micros)}</div><div className="text-xs text-muted mt-1">of which charged</div></div>
						<div><div className="text-lg font-bold">{fmtInt(u.calls)}</div><div className="text-xs text-muted mt-1">AI calls</div></div>
						<div><div className="text-lg font-bold">{fmtInt(u.input_tokens)}</div><div className="text-xs text-muted mt-1">input tokens</div></div>
						<div><div className="text-lg font-bold">{fmtInt(u.output_tokens)}</div><div className="text-xs text-muted mt-1">output tokens</div></div>
					</div>
				</Panel>

				<Panel title={`Board items (${d.boardItems.length})`}>
					{!d.boardItems.length ? <Empty label="No board cards." /> : (
						<div className="space-y-1">
							{d.boardItems.map((b) => (
								<div key={b.job_key} className="text-sm border-b border-line/50 py-1">
									{b.title || b.job_key}
									{b.subtitle ? <span className="text-muted-soft text-xs"> · {b.subtitle}</span> : null}
									{b.user_status ? <span className="text-xs text-warning ml-2">{b.user_status}</span> : null}
								</div>
							))}
						</div>
					)}
				</Panel>

				<Panel title={`Connector consents (${d.consents.length})`}>
					{!d.consents.length ? <Empty label="No write consents granted." /> : (
						<div className="flex flex-wrap gap-1.5">
							{d.consents.map((c) => (
								<span key={`${c.connector}:${c.scope}`} className="text-xs text-warning bg-paper border border-line rounded px-1.5 py-0.5">
									{c.connector}·{c.scope}
								</span>
							))}
						</div>
					)}
				</Panel>
			</div>

			<Panel title={`Recent errors (${d.recentErrors.length})`}>
				{!d.recentErrors.length ? <Empty label="No recent errors for this owner." /> : (
					d.recentErrors.map((e) => (
						<div key={e.id} className="text-sm border-b border-line/50 py-1">
							<span className="text-muted-soft text-xs">{e.created_at?.slice(5, 16)} [{e.source}]{e.status ? ` ${e.status}` : ""} </span>
							{e.message}
						</div>
					))
				)}
			</Panel>

			<Panel title="Admin audit trail">
				<AuditTrail targetId={i.id} refresh={refresh} />
			</Panel>
		</div>
	);
}
