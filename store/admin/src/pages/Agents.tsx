import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { LIST_PAGE, buildListQuery, isFiltered, pagerRange, predicateKey } from "../lib/list-query";
import { Empty, ErrorBox, Loading, Panel } from "../lib/ui";

interface Agent {
	id: string;
	slug: string;
	name: string;
	category: string;
	model: string;
	visibility: string;
	status: string;
	owner_login: string | null;
	instances: number;
	connectors: string[];
	capabilities: { surfaces: string[]; runtime: string | null; workflow: string | null };
}

const PAGE = LIST_PAGE;
const VISIBILITIES = ["published", "draft", "unlisted"];
const STATUSES = ["active", "inactive", "error"];

const badge = (v: string) => (
	<span className={v === "published" || v === "active" ? "text-green" : v === "error" ? "text-red" : "text-muted"}>{v}</span>
);

/**
 * Every agent across every tenant, INCLUDING drafts and unlisted ones (issue #38).
 * The filters are the point: the public catalog answers "what can people subscribe
 * to", while an operator's questions are "show me the drafts", "show me the broken
 * ones", "show me this creator's" — none of which a search box can express.
 */
export default function Agents() {
	const [search, setSearch] = useState("");
	const [q, setQ] = useState("");
	const [visibility, setVisibility] = useState("");
	const [status, setStatus] = useState("");
	const [owner, setOwner] = useState("");
	const [ownerQ, setOwnerQ] = useState("");
	const [offset, setOffset] = useState(0);
	const [data, setData] = useState<{ agents: Agent[]; total: number } | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
	useEffect(() => { const t = setTimeout(() => setOwnerQ(owner.trim()), 300); return () => clearTimeout(t); }, [owner]);

	const filters = useMemo(() => ({ search: q, visibility, status, owner: ownerQ }), [q, visibility, status, ownerQ]);
	// Any filter change invalidates the current page — otherwise a narrowed result set
	// keeps an offset it no longer has rows for and the table reads as empty. Keyed on
	// `predicateKey`, which is derived from the SAME field list as the query, so a new
	// filter cannot reach one and not the other (lib/list-query.ts).
	const key = predicateKey(filters);
	// biome-ignore lint/correctness/useExhaustiveDependencies: resets the page when the PREDICATE changes; `offset` is what this sets, not what it reads
	useEffect(() => { setOffset(0); }, [key]);

	const qs = useMemo(() => buildListQuery(filters, offset, PAGE), [filters, offset]);

	useEffect(() => {
		setData(null);
		setErr("");
		api<{ agents: Agent[]; total: number }>(`/v1/admin/agents?${qs}`).then(setData).catch((e) => setErr(e.message));
	}, [qs]);

	const filtered = isFiltered(filters);

	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-1">Agents</h1>
			<p className="text-sm text-muted mb-4">Every agent across all tenants — drafts and unlisted included.</p>

			<div className="flex flex-wrap items-center gap-2 mb-4">
				<input placeholder="Search slug / name / owner…" value={search} onChange={(e) => setSearch(e.target.value)} className="!w-auto min-w-[16rem] text-sm" />
				<select value={visibility} onChange={(e) => setVisibility(e.target.value)} className="!w-auto text-sm">
					<option value="">Any visibility</option>
					{VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}
				</select>
				<select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-auto text-sm">
					<option value="">Any status</option>
					{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
				</select>
				<input placeholder="Owner (login or id)" value={owner} onChange={(e) => setOwner(e.target.value)} className="!w-auto min-w-[13rem] text-sm" />
				{filtered ? (
					<button
						type="button"
						onClick={() => { setSearch(""); setVisibility(""); setStatus(""); setOwner(""); }}
						className="text-sm px-3 py-1.5 rounded-lg border border-line text-muted hover:bg-panel-hover"
					>
						Clear
					</button>
				) : null}
			</div>

			{err ? <ErrorBox message={err} /> : !data ? <Loading /> : (
				<Panel title={`Agents (${data.total}${filtered ? " matching" : ""})`} right={<Pager total={data.total} offset={offset} onChange={setOffset} />}>
					{!data.agents.length ? <Empty label="No agents match these filters." /> : (
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
									<th className="py-1.5">Slug</th><th>Name</th><th>Owner</th><th>Category</th><th>Model</th>
									<th>Visibility</th><th>Status</th><th className="text-right">Inst.</th><th>Connectors</th>
								</tr></thead>
								<tbody>
									{data.agents.map((a) => (
										<tr key={a.id} className="border-b border-line/50 hover:bg-panel-hover">
											<td className="py-1.5"><Link to={`/agents/${encodeURIComponent(a.slug || a.id)}`} className="text-accent hover:underline">{a.slug}</Link></td>
											<td className="truncate max-w-[150px]">{a.name}</td>
											<td>{a.owner_login || "—"}</td>
											<td className="text-muted">{a.category || "—"}</td>
											<td className="truncate max-w-[140px] text-muted">{a.model || "—"}</td>
											<td>{badge(a.visibility)}</td>
											<td>{badge(a.status)}</td>
											<td className="text-right">{a.instances}</td>
											<td>
												{a.connectors.length
													? a.connectors.map((c) => <span key={c} className="text-xs bg-paper border border-line rounded px-1.5 py-0.5 mr-1">{c}</span>)
													: <span className="text-muted-soft">—</span>}
											</td>
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

/**
 * Prev/next over a server-side total. Shared with the Instances list; the arithmetic is
 * `pagerRange` (lib/list-query.ts) so this is a renderer, not a second implementation.
 */
export function Pager({ total, offset, onChange, page = PAGE }: { total: number; offset: number; onChange: (o: number) => void; page?: number }) {
	const r = pagerRange(total, offset, page);
	if (!r.visible) return null;
	return (
		<div className="flex items-center gap-2 text-xs text-muted">
			<span>{r.from}–{r.to} of {total}</span>
			<button type="button" disabled={!r.hasPrev} onClick={() => onChange(r.prevOffset)} className="px-2 py-1 rounded border border-line disabled:opacity-30 hover:bg-panel-hover">Prev</button>
			<button type="button" disabled={!r.hasNext} onClick={() => onChange(r.nextOffset)} className="px-2 py-1 rounded border border-line disabled:opacity-30 hover:bg-panel-hover">Next</button>
		</div>
	);
}
