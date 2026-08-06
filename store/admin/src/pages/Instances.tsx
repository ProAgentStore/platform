import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { LIST_PAGE, buildListQuery, isFiltered, predicateKey, predicateParams } from "../lib/list-query";
import { Empty, ErrorBox, LiveDot, Loading, Panel } from "../lib/ui";
import { Pager } from "./Agents";

interface Instance {
	id: string;
	agent_id: string;
	agent_name: string | null;
	agent_slug: string | null;
	user_id: string;
	owner_login: string | null;
	display_name: string | null;
	status: string;
	created_at: string;
	runtime_nodes: number;
	last_seen_at: string | null;
	/** LIVE relay check. `null` = unknown (not checked), never "offline". */
	runtimeConnected: boolean | null;
}

const PAGE = LIST_PAGE;
const STATUSES = ["active", "paused", "canceled"];
const badge = (v: string) => <span className={v === "active" ? "text-green" : v === "canceled" ? "text-muted-soft" : "text-muted"}>{v}</span>;

/**
 * Every subscription across every tenant (issue #38). Filterable by agent, owner and
 * status, and deep-linkable — an agent's detail page links here pre-filtered, which is
 * how "who is running this thing" gets answered without retyping a slug.
 *
 * The runtime column shows the LIVE relay state, and shows "unknown" as unknown: the
 * list caps its live-check fan-out at 50 rows and reports null past that budget.
 */
export default function Instances() {
	const [params, setParams] = useSearchParams();
	const [agent, setAgent] = useState(params.get("agent") ?? "");
	const [owner, setOwner] = useState(params.get("owner") ?? "");
	const [status, setStatus] = useState(params.get("status") ?? "");
	const [agentQ, setAgentQ] = useState(agent);
	const [ownerQ, setOwnerQ] = useState(owner);
	const [offset, setOffset] = useState(0);
	const [data, setData] = useState<{ instances: Instance[]; total: number } | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => { const t = setTimeout(() => setAgentQ(agent.trim()), 300); return () => clearTimeout(t); }, [agent]);
	useEffect(() => { const t = setTimeout(() => setOwnerQ(owner.trim()), 300); return () => clearTimeout(t); }, [owner]);

	const filters = useMemo(() => ({ agent: agentQ, owner: ownerQ, status }), [agentQ, ownerQ, status]);
	// One predicate, three derivations (reset key, address bar, request) — all from the
	// same field list, so they cannot drift apart (lib/list-query.ts).
	const key = predicateKey(filters);
	// biome-ignore lint/correctness/useExhaustiveDependencies: resets the page when the PREDICATE changes; `offset` is what this sets, not what it reads
	useEffect(() => { setOffset(0); }, [key]);

	// Keep the URL in step so a filtered view is linkable/shareable between operators.
	useEffect(() => { setParams(predicateParams(filters), { replace: true }); }, [filters, setParams]);

	const qs = useMemo(() => buildListQuery(filters, offset, PAGE), [filters, offset]);

	useEffect(() => {
		setData(null);
		setErr("");
		api<{ instances: Instance[]; total: number }>(`/v1/admin/instances?${qs}`).then(setData).catch((e) => setErr(e.message));
	}, [qs]);

	const filtered = isFiltered(filters);

	return (
		<div>
			<h1 className="font-display text-xl font-bold mb-1">Instances</h1>
			<p className="text-sm text-muted mb-4">
				Every subscription across all tenants. Runtime is the live relay socket — <span className="text-yellow">unknown</span> means unchecked, not offline.
			</p>

			<div className="flex flex-wrap items-center gap-2 mb-4">
				<input placeholder="Agent (slug or id)" value={agent} onChange={(e) => setAgent(e.target.value)} className="!w-auto min-w-[14rem] text-sm" />
				<input placeholder="Owner (login or id)" value={owner} onChange={(e) => setOwner(e.target.value)} className="!w-auto min-w-[14rem] text-sm" />
				<select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-auto text-sm">
					<option value="">Any status</option>
					{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
				</select>
				{filtered ? (
					<button type="button" onClick={() => { setAgent(""); setOwner(""); setStatus(""); }} className="text-sm px-3 py-1.5 rounded-lg border border-line text-muted hover:bg-panel-hover">
						Clear
					</button>
				) : null}
			</div>

			{err ? <ErrorBox message={err} /> : !data ? <Loading /> : (
				<Panel title={`Instances (${data.total}${filtered ? " matching" : ""})`} right={<Pager total={data.total} offset={offset} onChange={setOffset} page={PAGE} />}>
					{!data.instances.length ? <Empty label="No instances match these filters." /> : (
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead><tr className="text-muted text-xs uppercase text-left border-b border-line">
									<th className="py-1.5">Agent</th><th>Name</th><th>Owner</th><th>Status</th><th>Runtime</th><th>Last seen</th><th>Created</th>
								</tr></thead>
								<tbody>
									{data.instances.map((i) => (
										<tr key={i.id} className="border-b border-line/50 hover:bg-panel-hover">
											<td className="py-1.5">
												<Link to={`/instances/${i.id}`} className="text-accent hover:underline">{i.agent_name || i.agent_slug || i.id}</Link>
											</td>
											<td className="truncate max-w-[150px] text-muted">{i.display_name || "—"}</td>
											<td>{i.owner_login || <span className="font-mono text-xs text-muted-soft">{i.user_id.slice(0, 8)}</span>}</td>
											<td>{badge(i.status)}</td>
											<td><LiveDot connected={i.runtimeConnected} noRunner={!i.runtime_nodes} /></td>
											<td className="text-muted text-xs">{i.last_seen_at?.slice(5, 16) || "—"}</td>
											<td className="text-muted">{i.created_at?.slice(0, 10)}</td>
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
