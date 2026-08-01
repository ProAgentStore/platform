import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtUsd } from "../lib/api";
import { ErrorBox, Loading, Panel } from "../lib/ui";

interface UserDetailResp {
	user: { github_login: string; github_name: string; roles: string[]; subscription_status: string | null; created_at: string; updated_at: string; spend30dMicros: number };
	agents: Array<{ id: string; slug: string; name: string; visibility: string; status: string }>;
	instances: Array<{ id: string; agent_name: string | null; status: string }>;
	keyProviders: Array<{ provider: string; last_used_at: string | null }>;
	recentErrors: Array<{ id: string; created_at: string; source: string; status: number | null; message: string }>;
}

export default function UserDetail() {
	const { id } = useParams();
	const [d, setD] = useState<UserDetailResp | null>(null);
	const [err, setErr] = useState("");
	useEffect(() => {
		if (!id) return;
		api<UserDetailResp>(`/v1/admin/users/${encodeURIComponent(id)}`).then(setD).catch((e) => setErr(e.message));
	}, [id]);

	if (err) return <ErrorBox message={err} />;
	if (!d) return <Loading />;

	return (
		<div>
			<Link to="/users" className="text-sm text-muted hover:text-ink">← Users</Link>
			<h1 className="font-display text-xl font-bold mt-1 mb-1">{d.user.github_login}</h1>
			<p className="text-sm text-muted mb-4">{d.user.github_name} · roles: {d.user.roles.join(", ")} · sub: {d.user.subscription_status || "none"} · spend 30d: {fmtUsd(d.user.spend30dMicros)} · joined {d.user.created_at?.slice(0, 10)}</p>

			<div className="grid md:grid-cols-2 gap-4">
				<Panel title={`Agents (${d.agents.length})`}>
					{d.agents.length ? d.agents.map((a) => <div key={a.id} className="text-sm border-b border-line/50 py-1">{a.name} <span className="text-muted-soft text-xs">{a.visibility}/{a.status}</span></div>) : <div className="text-muted-soft text-sm">None.</div>}
				</Panel>
				<Panel title={`Instances (${d.instances.length})`}>
					{d.instances.length ? d.instances.map((i) => <div key={i.id} className="text-sm border-b border-line/50 py-1">{i.agent_name || "?"} <span className="text-muted-soft text-xs">{i.status}</span></div>) : <div className="text-muted-soft text-sm">None.</div>}
				</Panel>
				<Panel title={`API keys (${d.keyProviders.length})`}>
					{d.keyProviders.length ? d.keyProviders.map((k) => <div key={k.provider} className="text-sm border-b border-line/50 py-1">{k.provider} <span className="text-muted-soft text-xs">{k.last_used_at ? `used ${k.last_used_at.slice(0, 10)}` : "unused"}</span></div>) : <div className="text-muted-soft text-sm">None.</div>}
				</Panel>
				<Panel title={`Recent errors (${d.recentErrors.length})`}>
					{d.recentErrors.length ? d.recentErrors.map((e) => <div key={e.id} className="text-sm border-b border-line/50 py-1"><span className="text-muted-soft text-xs">{e.created_at?.slice(5, 16)} [{e.source}] </span>{e.message}</div>) : <div className="text-muted-soft text-sm">None.</div>}
				</Panel>
			</div>
		</div>
	);
}
