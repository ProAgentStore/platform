import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface AuditRow { id: string; created_at: string; actor_user_id: string; action: string; target_type: string | null; target_id: string | null; detail: string | null }

export default function Audit() {
	const [audit, setAudit] = useState<AuditRow[] | null>(null);
	const [err, setErr] = useState("");
	useEffect(() => { api<{ audit: AuditRow[] }>("/v1/admin/audit?limit=200").then((r) => setAudit(r.audit)).catch((e) => setErr(e.message)); }, []);

	if (err) return <ErrorBox message={err} />;
	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-1">Admin audit log</h1>
			<p className="text-sm text-muted mb-4">Every privileged operator action, newest first.</p>
			{!audit ? <Loading /> : (
				<Panel>
					{!audit.length ? <Empty label="No admin actions yet." /> : (
						<table className="w-full text-sm">
							<thead><tr className="text-muted text-xs uppercase text-left border-b border-line"><th className="py-1.5">When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
							<tbody>
								{audit.map((a) => (
									<tr key={a.id} className="border-b border-line/50">
										<td className="py-1.5 text-muted whitespace-nowrap">{a.created_at?.slice(0, 16)}</td>
										<td className="truncate max-w-[160px]">{a.actor_user_id}</td>
										<td className="text-accent">{a.action}</td>
										<td className="text-muted">{a.target_type ? `${a.target_type}:${a.target_id ?? ""}` : "—"}</td>
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
