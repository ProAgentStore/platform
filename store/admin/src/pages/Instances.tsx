import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface Instance { id: string; agent_name: string | null; owner_login: string | null; status: string; created_at: string }
const badge = (v: string) => <span className={v === "active" ? "text-green" : "text-muted"}>{v}</span>;

export default function Instances() {
	const [data, setData] = useState<{ instances: Instance[]; total: number } | null>(null);
	const [err, setErr] = useState("");
	useEffect(() => { api<{ instances: Instance[]; total: number }>("/v1/admin/instances").then(setData).catch((e) => setErr(e.message)); }, []);

	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-3">Instances</h1>
			{err ? <ErrorBox message={err} /> : !data ? <Loading /> : (
				<Panel title={`Instances (${data.total})`}>
					{!data.instances.length ? <Empty label="No instances." /> : (
						<table className="w-full text-sm">
							<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
								<th className="py-1.5">Agent</th><th>Owner</th><th>Status</th><th>Created</th>
							</tr></thead>
							<tbody>
								{data.instances.map((i) => (
									<tr key={i.id} className="border-b border-line/50">
										<td className="py-1.5"><Link to={`/instances/${i.id}`} className="text-accent hover:underline">{i.agent_name || i.id}</Link></td>
										<td>{i.owner_login || "—"}</td>
										<td>{badge(i.status)}</td>
										<td className="text-muted">{i.created_at?.slice(0, 10)}</td>
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
