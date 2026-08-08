import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface CatalogConnector { connector: string; tools: Array<{ name: string; scope: string }>; hasWrite: boolean }
interface Consent { instance_id: string; user_id: string; connector: string; scope: string; created_at: string; owner_login: string | null }

export default function Connectors() {
	const [connectors, setConnectors] = useState<CatalogConnector[] | null>(null);
	const [consents, setConsents] = useState<Consent[] | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => {
		api<{ connectors: CatalogConnector[]; consents: Consent[] }>("/v1/admin/connectors")
			.then((r) => { setConnectors(r.connectors); setConsents(r.consents); })
			.catch((e) => setErr(e.message));
	}, []);

	// Group write-consents by user, then by connector.
	const byUser = useMemo(() => {
		const m = new Map<string, { login: string | null; rows: Consent[] }>();
		for (const c of consents ?? []) {
			const g = m.get(c.user_id) ?? { login: c.owner_login, rows: [] };
			g.rows.push(c);
			m.set(c.user_id, g);
		}
		return [...m.entries()];
	}, [consents]);

	if (err) return <ErrorBox message={err} />;
	if (!connectors || !consents) return <Loading />;

	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-1">Connectors</h1>
			<p className="text-sm text-muted mb-4">External systems agents can use, and which users have granted write access.</p>

			<Panel title={`Available connectors (${connectors.length})`}>
				{!connectors.length ? <Empty label="No connectors registered." /> : (
					<div className="space-y-3">
						{connectors.map((c) => (
							<div key={c.connector} className="border-b border-line/50 pb-2">
								<div className="flex items-center gap-2">
									<Link to={`/connectors/${encodeURIComponent(c.connector)}`} className="font-semibold text-accent hover:underline">{c.connector}</Link>
									{c.hasWrite && <span className="text-xs text-yellow">write</span>}
								</div>
								<div className="flex flex-wrap gap-1.5 mt-1">
									{c.tools.map((t) => (
										<span key={t.name} className="text-xs bg-paper border border-line rounded px-1.5 py-0.5 font-mono">
											{t.name}<span className={t.scope === "write" ? "text-yellow" : "text-muted-soft"}> ·{t.scope}</span>
										</span>
									))}
								</div>
							</div>
						))}
					</div>
				)}
			</Panel>

			<Panel title={`Write access granted — by user (${byUser.length})`}>
				{!byUser.length ? <Empty label="No user has granted a connector write access yet." /> : (
					<div className="space-y-3">
						{byUser.map(([uid, g]) => (
							<div key={uid} className="border-b border-line/50 pb-2">
								<div className="text-sm font-semibold">{g.login || uid}</div>
								<div className="overflow-x-auto">
									<table className="w-full text-sm mt-1">
										<thead><tr className="text-muted text-xs uppercase text-left"><th>Connector</th><th>Scope</th><th>Instance</th><th>Granted</th></tr></thead>
										<tbody>
											{g.rows.map((r) => (
												<tr key={`${r.instance_id}:${r.connector}:${r.scope}`} className="border-t border-line/30">
													<td className="py-1">{r.connector}</td>
													<td className="text-yellow">{r.scope}</td>
													<td className="text-muted-soft font-mono text-xs truncate max-w-[180px]">{r.instance_id}</td>
													<td className="text-muted">{r.created_at?.slice(0, 16)}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</div>
						))}
					</div>
				)}
			</Panel>
		</div>
	);
}
