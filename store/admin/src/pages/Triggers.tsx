import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface Trigger {
	id: string;
	agentName: string | null;
	ownerLogin: string | null;
	name: string;
	type: string;
	action: string;
	enabled: boolean;
	hasSecret: boolean;
	schedule: string | null;
	createdAt: string;
}

const enabledBadge = (v: boolean) => <span className={v ? "text-green" : "text-muted"}>{v ? "enabled" : "off"}</span>;

export default function Triggers() {
	const [data, setData] = useState<{ triggers: Trigger[]; count: number } | null>(null);
	const [err, setErr] = useState("");
	useEffect(() => { api<{ triggers: Trigger[]; count: number }>("/v1/admin/triggers").then(setData).catch((e) => setErr(e.message)); }, []);

	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-3">Triggers</h1>
			{err ? <ErrorBox message={err} /> : !data ? <Loading /> : (
				<Panel title={`Triggers (${data.count})`}>
					{!data.triggers.length ? <Empty label="No triggers." /> : (
						<table className="w-full text-sm">
							<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
								<th className="py-1.5">Owner</th><th>Agent</th><th>Type</th><th>Schedule</th><th>Enabled</th><th>Created</th>
							</tr></thead>
							<tbody>
								{data.triggers.map((t) => (
									<tr key={t.id} className="border-b border-line/50">
										<td className="py-1.5">{t.ownerLogin || "—"}</td>
										<td>{t.agentName || "—"}</td>
										<td>{t.type === "webhook" ? `webhook${t.hasSecret ? " 🔒" : ""}` : t.type}</td>
										<td className="text-muted">{t.type === "cron" ? (t.schedule || "—") : "—"}</td>
										<td>{enabledBadge(t.enabled)}</td>
										<td className="text-muted">{t.createdAt?.slice(0, 10)}</td>
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
