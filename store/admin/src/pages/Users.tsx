import { useEffect, useState } from "react";
import { api, fmtUsd } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface AdminUser {
	id: string;
	github_login: string;
	github_name: string;
	roles: string[];
	subscription_status: string | null;
	created_at: string;
	agents_owned: number;
	active_instances: number;
	key_providers: string[];
	spend30dMicros: number;
}
interface UserDetail {
	user: AdminUser;
	agents: Array<{ id: string; slug: string; name: string; visibility: string; status: string }>;
	instances: Array<{ id: string; agent_name: string | null; status: string }>;
	keyProviders: Array<{ provider: string; last_used_at: string | null }>;
	recentErrors: Array<{ id: string; created_at: string; source: string; message: string }>;
}

export default function Users() {
	const [search, setSearch] = useState("");
	const [q, setQ] = useState("");
	const [data, setData] = useState<{ users: AdminUser[]; total: number } | null>(null);
	const [err, setErr] = useState("");
	const [sel, setSel] = useState<string | null>(null);

	useEffect(() => {
		const t = setTimeout(() => setQ(search.trim()), 300);
		return () => clearTimeout(t);
	}, [search]);

	useEffect(() => {
		setData(null);
		setErr("");
		api<{ users: AdminUser[]; total: number }>(`/v1/admin/users${q ? `?search=${encodeURIComponent(q)}` : ""}`)
			.then(setData)
			.catch((e) => setErr(e.message));
	}, [q]);

	return (
		<div>
			<div className="mb-4">
				<input placeholder="Search login / name / id…" value={search} onChange={(e) => setSearch(e.target.value)} />
			</div>
			{err ? <ErrorBox message={err} /> : !data ? <Loading /> : (
				<Panel title={`Users (${data.total})`}>
					{!data.users.length ? <Empty label="No users match." /> : (
						<table className="w-full text-sm">
							<thead>
								<tr className="text-muted text-xs uppercase text-left border-b border-line">
									<th className="py-1.5">Login</th>
									<th>Roles</th>
									<th className="text-right">Agents</th>
									<th className="text-right">Instances</th>
									<th>Keys</th>
									<th className="text-right">Spend 30d</th>
								</tr>
							</thead>
							<tbody>
								{data.users.map((u) => (
									<tr key={u.id} className="border-b border-line/50 hover:bg-panel-hover cursor-pointer" onClick={() => setSel(u.id)}>
										<td className="py-1.5">{u.github_login}</td>
										<td>{u.roles.filter((r) => r !== "user").join(", ") || "—"}</td>
										<td className="text-right">{u.agents_owned}</td>
										<td className="text-right">{u.active_instances}</td>
										<td>{u.key_providers.join(", ") || "—"}</td>
										<td className="text-right">{fmtUsd(u.spend30dMicros)}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Panel>
			)}
			{sel && <UserDetailModal id={sel} onClose={() => setSel(null)} />}
		</div>
	);
}

function UserDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
	const [d, setD] = useState<UserDetail | null>(null);
	const [err, setErr] = useState("");
	useEffect(() => {
		api<UserDetail>(`/v1/admin/users/${id}`).then(setD).catch((e) => setErr(e.message));
	}, [id]);
	return (
		<div className="fixed inset-0 bg-black/60 flex items-start justify-center p-4 overflow-y-auto z-50" onClick={onClose}>
			<div className="bg-panel border border-line rounded-xl p-5 max-w-2xl w-full mt-10" onClick={(e) => e.stopPropagation()}>
				{err ? <ErrorBox message={err} /> : !d ? <Loading /> : (
					<>
						<div className="flex items-center justify-between mb-3">
							<h2 className="font-display text-lg font-bold">{d.user.github_login}</h2>
							<button onClick={onClose} className="text-muted hover:text-ink text-xl leading-none">×</button>
						</div>
						<div className="text-sm text-muted mb-4">
							{d.user.github_name} · roles: {d.user.roles.join(", ")} · sub: {d.user.subscription_status || "none"} · spend 30d: {fmtUsd(d.user.spend30dMicros)}
						</div>
						<Section title={`Agents (${d.agents.length})`} rows={d.agents.map((a) => `${a.name} — ${a.visibility}/${a.status}`)} />
						<Section title={`Instances (${d.instances.length})`} rows={d.instances.map((i) => `${i.agent_name || "?"} — ${i.status}`)} />
						<Section title={`Keys (${d.keyProviders.length})`} rows={d.keyProviders.map((k) => k.provider)} />
						<Section title={`Recent errors (${d.recentErrors.length})`} rows={d.recentErrors.map((e) => `${e.created_at} [${e.source}] ${e.message}`)} />
					</>
				)}
			</div>
		</div>
	);
}

function Section({ title, rows }: { title: string; rows: string[] }) {
	return (
		<div className="mb-3">
			<div className="text-xs uppercase text-muted mb-1">{title}</div>
			{rows.length ? (
				<ul className="text-sm space-y-0.5">{rows.map((r, i) => <li key={i} className="truncate">{r}</li>)}</ul>
			) : <div className="text-muted-soft text-sm">None.</div>}
		</div>
	);
}
