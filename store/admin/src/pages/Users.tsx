import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtUsd } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface AdminUser {
	id: string; github_login: string; github_name: string; roles: string[];
	subscription_status: string | null; created_at: string;
	agents_owned: number; active_instances: number; key_providers: string[]; spend30dMicros: number;
}

export default function Users() {
	const [search, setSearch] = useState("");
	const [q, setQ] = useState("");
	const [data, setData] = useState<{ users: AdminUser[]; total: number } | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
	useEffect(() => {
		setData(null); setErr("");
		api<{ users: AdminUser[]; total: number }>(`/v1/admin/users${q ? `?search=${encodeURIComponent(q)}` : ""}`).then(setData).catch((e) => setErr(e.message));
	}, [q]);

	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-3">Users</h1>
			<div className="mb-4"><input placeholder="Search login / name / id…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
			{err ? <ErrorBox message={err} /> : !data ? <Loading /> : (
				<Panel title={`Users (${data.total})`}>
					{!data.users.length ? <Empty label="No users match." /> : (
						<table className="w-full text-sm">
							<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
								<th className="py-1.5">Login</th><th>Roles</th><th className="text-right">Agents</th><th className="text-right">Instances</th><th>Keys</th><th className="text-right">Spend 30d</th>
							</tr></thead>
							<tbody>
								{data.users.map((u) => (
									<tr key={u.id} className="border-b border-line/50 hover:bg-panel-hover">
										<td className="py-1.5"><Link to={`/users/${encodeURIComponent(u.id)}`} className="text-accent hover:underline">{u.github_login}</Link></td>
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
		</div>
	);
}
