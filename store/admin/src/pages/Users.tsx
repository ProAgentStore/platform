import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtUsd } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface AdminUser {
	id: string; github_login: string; github_name: string; roles: string[];
	subscription_status: string | null; created_at: string;
	agents_owned: number; active_instances: number; key_providers: string[]; value30dMicros: number; charged30dMicros: number;
	/** Moderation state — visible in the list so a blocked account is obvious without a click. */
	suspended: boolean; suspended_reason: string | null;
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
			<div className="mb-4"><input aria-label="Search users by login, name or id" placeholder="Search login / name / id…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
			{err ? <ErrorBox message={err} /> : !data ? <Loading /> : (
				<Panel title={`Users (${data.total})`}>
					{!data.users.length ? <Empty label="No users match." /> : (
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
									<th className="py-1.5">Login</th><th>Roles</th><th className="text-right">Agents</th><th className="text-right">Instances</th><th>Keys</th><th className="text-right" title="List-price value of AI consumed. Not a bill — see Charged.">Value 30d</th><th className="text-right" title="The part someone is actually charged for (own API key, or paid by us).">Charged 30d</th>
								</tr></thead>
								<tbody>
									{data.users.map((u) => (
										<tr key={u.id} className="border-b border-line/50 hover:bg-panel-hover">
											<td className="py-1.5">
												<Link to={`/users/${encodeURIComponent(u.id)}`} className="text-accent hover:underline">{u.github_login}</Link>
												{u.suspended ? <span className="text-red text-xs ml-1.5" title={u.suspended_reason || "Suspended"}>suspended</span> : null}
											</td>
											<td>{u.roles.filter((r) => r !== "user").join(", ") || "—"}</td>
											<td className="text-right">{u.agents_owned}</td>
											<td className="text-right">{u.active_instances}</td>
											<td>{u.key_providers.join(", ") || "—"}</td>
											<td className="text-right">{fmtUsd(u.value30dMicros)}</td>
											<td className="text-right">{fmtUsd(u.charged30dMicros)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Panel>
			)}
		</div>
	);
}
