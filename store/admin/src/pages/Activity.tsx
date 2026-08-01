import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface ErrRow { id: string; created_at: string; user_id: string | null; source: string; status: number | null; message: string }
interface AuditRow { id: string; created_at: string; actor_user_id: string; action: string; target_type: string | null; target_id: string | null; detail: string | null }

export default function Activity() {
	const [errors, setErrors] = useState<ErrRow[] | null>(null);
	const [audit, setAudit] = useState<AuditRow[] | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => {
		api<{ errors: ErrRow[] }>("/v1/admin/errors?limit=100").then((r) => setErrors(r.errors)).catch((e) => setErr(e.message));
		api<{ audit: AuditRow[] }>("/v1/admin/audit?limit=100").then((r) => setAudit(r.audit)).catch((e) => setErr(e.message));
	}, []);

	if (err) return <ErrorBox message={err} />;

	return (
		<div>
			<Panel title={errors ? `Errors (${errors.length})` : "Errors"}>
				{!errors ? <Loading /> : !errors.length ? <Empty label="No errors logged. 🎉" /> : (
					<div className="space-y-1.5 text-sm">
						{errors.map((e) => (
							<div key={e.id} className="border-b border-line/50 pb-1.5">
								<div className="flex gap-2 text-xs text-muted">
									<span>{e.created_at}</span>
									<span className="text-accent">{e.source}</span>
									{e.status != null && <span className={e.status >= 500 ? "text-red" : "text-yellow"}>{e.status}</span>}
									{e.user_id && <span className="truncate max-w-[160px]">{e.user_id}</span>}
								</div>
								<div className="break-words">{e.message}</div>
							</div>
						))}
					</div>
				)}
			</Panel>

			<Panel title={audit ? `Admin audit log (${audit.length})` : "Admin audit log"}>
				{!audit ? <Loading /> : !audit.length ? <Empty label="No admin actions yet." /> : (
					<table className="w-full text-sm">
						<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
							<th className="py-1.5">When</th><th>Actor</th><th>Action</th><th>Target</th>
						</tr></thead>
						<tbody>
							{audit.map((a) => (
								<tr key={a.id} className="border-b border-line/50">
									<td className="py-1.5 text-muted">{a.created_at}</td>
									<td className="truncate max-w-[160px]">{a.actor_user_id}</td>
									<td className="text-accent">{a.action}</td>
									<td className="text-muted">{a.target_type ? `${a.target_type}:${a.target_id ?? ""}` : "—"}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Panel>
		</div>
	);
}
