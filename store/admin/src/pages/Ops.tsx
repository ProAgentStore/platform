import { useEffect, useState } from "react";
import { api, fmtInt } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel, Stat } from "../lib/ui";

interface StuckSession {
	id: string;
	instance_id: string;
	user_id: string;
	owner_login: string | null;
	client_type: string;
	status: string;
	updated_at: string;
}
interface StaleRunner {
	instance_id: string;
	runner_node: string;
	user_id: string;
	owner_login: string | null;
	runner_version: string;
	status: string;
	last_seen_at: string | null;
}
interface NoKeyUser {
	id: string;
	github_login: string;
	github_name: string;
	active_instances: number;
}
interface Ops {
	stuckSessions: StuckSession[];
	staleRunners: StaleRunner[];
	noKeyUsers: NoKeyUser[];
	errors24h: number;
}

const statusColor = (s: string) =>
	s === "failed" || s === "blocked" ? "text-red" : s === "needs_human" ? "text-yellow" : "text-muted";

export default function Ops() {
	const [ops, setOps] = useState<Ops | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => {
		api<Ops>("/v1/admin/ops").then(setOps).catch((e) => setErr(e.message));
	}, []);

	if (err) return <ErrorBox message={err} />;
	if (!ops) return <Loading />;

	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-1">Ops queue</h1>
			<p className="text-sm text-muted mb-4">What's wrong right now, across all users — triage the queue top to bottom.</p>

			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
				<Stat label="Stuck sessions" value={fmtInt(ops.stuckSessions.length)} accent={ops.stuckSessions.length > 0} />
				<Stat label="Stale runners" value={fmtInt(ops.staleRunners.length)} accent={ops.staleRunners.length > 0} />
				<Stat label="Users w/o API key" value={fmtInt(ops.noKeyUsers.length)} accent={ops.noKeyUsers.length > 0} />
				<Stat label="Errors (24h)" value={fmtInt(ops.errors24h)} accent={ops.errors24h > 0} />
			</div>

			<Panel title="Stuck / failed coding sessions">
				{!ops.stuckSessions.length ? <Empty label="No stuck sessions. 🎉" /> : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
								<th className="py-1.5">Status</th><th>Owner</th><th>Engine</th><th>Instance</th><th>Updated</th>
							</tr></thead>
							<tbody>
								{ops.stuckSessions.map((s) => (
									<tr key={s.id} className="border-b border-line/50 align-top">
										<td className={`py-1.5 font-semibold whitespace-nowrap ${statusColor(s.status)}`}>{s.status}</td>
										<td className="whitespace-nowrap">{s.owner_login || s.user_id}</td>
										<td className="text-muted whitespace-nowrap">{s.client_type}</td>
										<td className="text-muted-soft truncate max-w-[180px]">{s.instance_id}</td>
										<td className="text-muted whitespace-nowrap">{s.updated_at?.slice(5, 16)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Panel>

			<Panel title="Runner nodes — stale (possibly offline)">
				{!ops.staleRunners.length ? <Empty label="All registered runners are fresh." /> : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
								<th className="py-1.5">Node</th><th>Owner</th><th>Version</th><th>Instance</th><th>Last seen</th>
							</tr></thead>
							<tbody>
								{ops.staleRunners.map((n) => (
									<tr key={`${n.instance_id}:${n.runner_node}`} className="border-b border-line/50 align-top">
										<td className="py-1.5 whitespace-nowrap">{n.runner_node}</td>
										<td className="whitespace-nowrap">{n.owner_login || n.user_id}</td>
										<td className="text-muted whitespace-nowrap">{n.runner_version || "—"}</td>
										<td className="text-muted-soft truncate max-w-[180px]">{n.instance_id}</td>
										<td className="text-muted whitespace-nowrap">{n.last_seen_at ? n.last_seen_at.slice(5, 16) : "never"}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Panel>

			<Panel title="Users with active instances but no API key">
				{!ops.noKeyUsers.length ? <Empty label="Every active subscriber has a key on file." /> : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
								<th className="py-1.5">User</th><th>Name</th><th>Active instances</th>
							</tr></thead>
							<tbody>
								{ops.noKeyUsers.map((u) => (
									<tr key={u.id} className="border-b border-line/50 align-top">
										<td className="py-1.5 whitespace-nowrap">{u.github_login}</td>
										<td className="text-muted">{u.github_name || "—"}</td>
										<td className="font-semibold">{u.active_instances}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Panel>
		</div>
	);
}
