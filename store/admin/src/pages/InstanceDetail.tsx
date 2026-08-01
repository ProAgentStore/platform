import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtInt, fmtUsd } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

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
	runtimeNodes: Array<{ runner_node: string; placement: string; status: string; last_seen_at: string | null; runner_version: string; capabilities: string; created_at: string; updated_at: string }>;
	boardItems: Array<{ job_key: string; user_status: string | null; title: string; subtitle: string; url: string; updated_at: string }>;
	consents: Array<{ connector: string; scope: string; created_at: string }>;
	recentErrors: Array<{ id: string; created_at: string; source: string; status: number | null; message: string }>;
	usage30d: { calls: number; input_tokens: number; output_tokens: number; cost_micros: number };
}

export default function InstanceDetail() {
	const { id } = useParams();
	const [d, setD] = useState<Detail | null>(null);
	const [err, setErr] = useState("");
	useEffect(() => {
		if (!id) return;
		api<Detail>(`/v1/admin/instances/${encodeURIComponent(id)}/detail`).then(setD).catch((e) => setErr(e.message));
	}, [id]);

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
				owner {i.owner_login || "—"} · status {i.status} · created {i.created_at?.slice(0, 10)} · <span className="font-mono text-xs">{i.id}</span>
			</p>

			<div className="grid md:grid-cols-2 gap-4">
				<Panel title={`Runtime nodes (${d.runtimeNodes.length})`}>
					{!d.runtimeNodes.length ? <Empty label="No runners registered." /> : (
						<table className="w-full text-sm">
							<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
								<th className="py-1.5">Node</th><th>Status</th><th>Version</th><th>Last seen</th>
							</tr></thead>
							<tbody>
								{d.runtimeNodes.map((n) => (
									<tr key={n.runner_node} className="border-b border-line/50">
										<td className="py-1.5 font-mono text-xs">{n.runner_node}</td>
										<td>{n.status}</td>
										<td className="text-muted">{n.runner_version || "—"}</td>
										<td className="text-muted">{n.last_seen_at?.slice(5, 16) || "—"}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Panel>

				<Panel title="30-day usage">
					<div className="grid grid-cols-2 gap-3 text-sm">
						<div><div className="text-2xl font-bold text-accent">{fmtUsd(u.cost_micros)}</div><div className="text-xs text-muted mt-1">est. cost (BYOK)</div></div>
						<div><div className="text-2xl font-bold">{fmtInt(u.calls)}</div><div className="text-xs text-muted mt-1">AI calls</div></div>
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
									{b.user_status ? <span className="text-xs text-yellow ml-2">{b.user_status}</span> : null}
								</div>
							))}
						</div>
					)}
				</Panel>

				<Panel title={`Connector consents (${d.consents.length})`}>
					{!d.consents.length ? <Empty label="No write consents granted." /> : (
						<div className="flex flex-wrap gap-1.5">
							{d.consents.map((c) => (
								<span key={`${c.connector}:${c.scope}`} className="text-xs text-yellow bg-paper border border-line rounded px-1.5 py-0.5">
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
		</div>
	);
}
