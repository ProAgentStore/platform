import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface Agent { id: string; slug: string; name: string; category: string; model: string; visibility: string; status: string; owner_login: string | null; instances: number }
const badge = (v: string) => <span className={v === "published" || v === "active" ? "text-green" : v === "error" ? "text-red" : "text-muted"}>{v}</span>;

export default function Agents() {
	const [search, setSearch] = useState("");
	const [q, setQ] = useState("");
	const [data, setData] = useState<{ agents: Agent[]; total: number } | null>(null);
	const [err, setErr] = useState("");
	useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
	useEffect(() => { setData(null); setErr(""); api<{ agents: Agent[]; total: number }>(`/v1/admin/agents${q ? `?search=${encodeURIComponent(q)}` : ""}`).then(setData).catch((e) => setErr(e.message)); }, [q]);

	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-3">Agents</h1>
			<div className="mb-4"><input placeholder="Search slug / name / owner…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
			{err ? <ErrorBox message={err} /> : !data ? <Loading /> : (
				<Panel title={`Agents (${data.total})`}>
					{!data.agents.length ? <Empty label="No agents." /> : (
						<table className="w-full text-sm">
							<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
								<th className="py-1.5">Slug</th><th>Name</th><th>Owner</th><th>Category</th><th>Model</th><th>Visibility</th><th className="text-right">Instances</th>
							</tr></thead>
							<tbody>
								{data.agents.map((a) => (
									<tr key={a.id} className="border-b border-line/50">
										<td className="py-1.5">{a.slug}</td>
										<td className="truncate max-w-[160px]">{a.name}</td>
										<td>{a.owner_login || "—"}</td>
										<td>{a.category}</td>
										<td className="truncate max-w-[150px] text-muted">{a.model || "—"}</td>
										<td>{badge(a.visibility)}</td>
										<td className="text-right">{a.instances}</td>
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
