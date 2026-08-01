import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface Agent { id: string; slug: string; name: string; category: string; model: string; visibility: string; status: string; owner_login: string | null; instances: number }
interface Instance { id: string; agent_name: string | null; owner_login: string | null; status: string; created_at: string }

const badge = (v: string) => {
	const c = v === "published" || v === "active" ? "text-green" : v === "error" ? "text-red" : "text-muted";
	return <span className={`text-xs ${c}`}>{v}</span>;
};

export default function Agents() {
	const [search, setSearch] = useState("");
	const [q, setQ] = useState("");
	const [agents, setAgents] = useState<{ agents: Agent[]; total: number } | null>(null);
	const [instances, setInstances] = useState<{ instances: Instance[]; total: number } | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);

	useEffect(() => {
		setErr("");
		api<{ agents: Agent[]; total: number }>(`/v1/admin/agents${q ? `?search=${encodeURIComponent(q)}` : ""}`).then(setAgents).catch((e) => setErr(e.message));
	}, [q]);
	useEffect(() => {
		api<{ instances: Instance[]; total: number }>("/v1/admin/instances").then(setInstances).catch((e) => setErr(e.message));
	}, []);

	if (err) return <ErrorBox message={err} />;

	return (
		<div>
			<div className="mb-4"><input placeholder="Search agents by slug / name / owner…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>

			<Panel title={agents ? `Agents (${agents.total})` : "Agents"}>
				{!agents ? <Loading /> : !agents.agents.length ? <Empty label="No agents." /> : (
					<table className="w-full text-sm">
						<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
							<th className="py-1.5">Slug</th><th>Name</th><th>Owner</th><th>Category</th><th>Model</th><th>Visibility</th><th className="text-right">Instances</th>
						</tr></thead>
						<tbody>
							{agents.agents.map((a) => (
								<tr key={a.id} className="border-b border-line/50">
									<td className="py-1.5">{a.slug}</td>
									<td className="truncate max-w-[160px]">{a.name}</td>
									<td>{a.owner_login || "—"}</td>
									<td>{a.category}</td>
									<td className="truncate max-w-[140px] text-muted">{a.model || "—"}</td>
									<td>{badge(a.visibility)}</td>
									<td className="text-right">{a.instances}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Panel>

			<Panel title={instances ? `Instances (${instances.total})` : "Instances"}>
				{!instances ? <Loading /> : !instances.instances.length ? <Empty label="No instances." /> : (
					<table className="w-full text-sm">
						<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
							<th className="py-1.5">Agent</th><th>Owner</th><th>Status</th><th>Created</th>
						</tr></thead>
						<tbody>
							{instances.instances.map((i) => (
								<tr key={i.id} className="border-b border-line/50">
									<td className="py-1.5">{i.agent_name || "—"}</td>
									<td>{i.owner_login || "—"}</td>
									<td>{badge(i.status)}</td>
									<td className="text-muted">{i.created_at?.slice(0, 10)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Panel>
		</div>
	);
}
