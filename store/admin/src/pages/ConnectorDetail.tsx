import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface CatalogConnector { connector: string; tools: Array<{ name: string; scope: string }>; hasWrite: boolean }
interface Consent { instance_id: string; user_id: string; connector: string; scope: string; created_at: string; owner_login: string | null }

export default function ConnectorDetail() {
	const { connector } = useParams();
	const [connectors, setConnectors] = useState<CatalogConnector[] | null>(null);
	const [consents, setConsents] = useState<Consent[] | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => {
		api<{ connectors: CatalogConnector[]; consents: Consent[] }>("/v1/admin/connectors")
			.then((r) => { setConnectors(r.connectors); setConsents(r.consents); })
			.catch((e) => setErr(e.message));
	}, []);

	// Filter to the single connector from the URL.
	const detail = useMemo(
		() => (connectors ?? []).find((c) => c.connector === connector) ?? null,
		[connectors, connector],
	);
	// Write-access grants for this connector only.
	const grants = useMemo(
		() => (consents ?? []).filter((c) => c.connector === connector),
		[consents, connector],
	);

	if (err) return <ErrorBox message={err} />;
	if (!connectors || !consents) return <Loading />;

	return (
		<div>
			<Link to="/connectors" className="text-sm text-muted hover:text-ink">← Connectors</Link>
			<h1 className="font-display text-xl font-bold mt-1 mb-1 flex items-center gap-2">
				{connector}
				{detail?.hasWrite && <span className="text-xs text-warning">write</span>}
			</h1>
			<p className="text-sm text-muted mb-4">External system agents can use, and which users have granted it write access.</p>

			{!detail ? (
				<Panel title="Not found">
					<Empty label={`No connector named "${connector}" is registered.`} />
				</Panel>
			) : (
				<Panel title={`Tools (${detail.tools.length})`}>
					{!detail.tools.length ? <Empty label="This connector exposes no tools." /> : (
						<div className="flex flex-wrap gap-1.5">
							{detail.tools.map((t) => (
								<span key={t.name} className="text-xs bg-paper border border-line rounded px-1.5 py-0.5 font-mono">
									{t.name}<span className={t.scope === "write" ? "text-warning" : "text-muted-soft"}> ·{t.scope}</span>
								</span>
							))}
						</div>
					)}
				</Panel>
			)}

			<Panel title={`Write access granted (${grants.length})`}>
				{!grants.length ? <Empty label="No user has granted this connector write access yet." /> : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead><tr className="text-muted text-xs uppercase text-left"><th>User</th><th>Scope</th><th>Instance</th><th>Granted</th></tr></thead>
							<tbody>
								{grants.map((r) => (
									<tr key={`${r.instance_id}:${r.scope}`} className="border-t border-line/30">
										<td className="py-1">
											<Link to={`/users/${encodeURIComponent(r.user_id)}`} className="hover:text-ink">{r.owner_login || r.user_id}</Link>
										</td>
										<td className="text-warning">{r.scope}</td>
										<td className="text-muted-soft font-mono text-xs truncate max-w-[180px]">{r.instance_id}</td>
										<td className="text-muted">{r.created_at?.slice(0, 16)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Panel>
		</div>
	);
}
