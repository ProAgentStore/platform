import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import Page from "../components/Page";
import LoadFailed from "../components/LoadFailed";
import {
	INBOX_KINDS,
	INBOX_SORTS,
	INBOX_URGENCIES,
	KIND_LABEL,
	SORT_LABEL,
	TRIAGE_VIEWS,
	TRIAGE_VIEW_LABEL,
	ageLabel,
	deferLabel,
	expiryLabel,
	failedSources,
	filtersToQuery,
	parseFilters,
	toggled,
	truncatedSources,
	type InboxItem,
	type InboxResponse,
} from "../lib/inbox";

const chip = (on: boolean) => `px-2.5 py-1 text-xs rounded-full border font-semibold ${on ? "bg-accent-soft text-accent border-accent" : "border-line text-muted hover:text-ink"}`;

/**
 * "Needs you" (#1640): everything on the account waiting on the owner, from every source, in one list.
 * Filters and sort are the URL, the API filters, and an item leaves only when it is resolved at its source.
 */
export default function Inbox() {
	const [search, setSearch] = useSearchParams();
	const filters = useMemo(() => parseFilters(search), [search]);
	const qs = filtersToQuery(filters).toString();
	const [data, setData] = useState<InboxResponse | null>(null);
	const [loadErr, setLoadErr] = useState("");
	const [now, setNow] = useState(() => Date.now());

	const load = useCallback(async () => {
		try {
			setData(await api<InboxResponse>(`/v1/inbox${qs ? `?${qs}` : ""}`));
			setLoadErr("");
			setNow(Date.now());
		} catch (e) {
			setLoadErr(e instanceof Error ? e.message : String(e));
		}
	}, [qs]);

	useEffect(() => {
		void load();
		const t = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
		return () => clearInterval(t);
	}, [load]);

	const [busy, setBusy] = useState("");
	const [actionErr, setActionErr] = useState("");
	/** The owner's own triage (#1697): bookkeeping only, it answers and hides nothing the filter chips cannot bring back. */
	const triage = async (it: InboxItem, body: { status?: "new" | "discussed" | "deferred"; defer_until?: string | null; needs_computer?: boolean }) => {
		setBusy(it.id);
		setActionErr("");
		try {
			await api("/v1/inbox/triage", { method: "PUT", body: JSON.stringify({ item_id: it.id, ...body }) });
			await load();
		} catch (e) {
			setActionErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy("");
		}
	};

	const update = (next: Partial<typeof filters>) => setSearch(filtersToQuery({ ...filters, ...next }), { replace: true });
	const failed = data ? failedSources(data) : [];
	const truncated = data ? truncatedSources(data) : [];
	const anyFilter = filters.kinds.length > 0 || filters.instances.length > 0 || !!filters.agent || !!filters.urgency || filters.triage !== "review" || filters.needsComputer;

	return (
		<Page>
			<div className="flex items-baseline justify-between gap-2 mb-3">
				<h1 className="font-display text-xl font-bold">Needs you{data ? ` (${data.counts.total})` : ""}</h1>
				<select
					aria-label="Sort"
					value={filters.sort}
					onChange={(e) => update({ sort: e.target.value as typeof filters.sort })}
					className="bg-panel border border-line rounded-lg px-2 py-1 text-xs text-ink"
				>
					{INBOX_SORTS.map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
				</select>
			</div>

			{data && (
				<div className="mb-4 flex flex-col gap-2" data-testid="inbox-filters">
					<fieldset className="flex flex-wrap gap-1.5 min-w-0 border-0 p-0 m-0" aria-label="Filter by kind">
						{INBOX_KINDS.filter((k) => data.counts.byKind[k] || filters.kinds.includes(k)).map((k) => (
							<button key={k} type="button" aria-pressed={filters.kinds.includes(k)} onClick={() => update({ kinds: toggled(filters.kinds, k) })} className={chip(filters.kinds.includes(k))}>
								{KIND_LABEL[k]} {data.counts.byKind[k] ?? 0}
							</button>
						))}
					</fieldset>
					<fieldset className="flex flex-wrap items-center gap-1.5 min-w-0 border-0 p-0 m-0" aria-label="Triage">
						{TRIAGE_VIEWS.map((v) => {
							const n = v === "discussed" ? data.counts.byTriage.discussed : v === "deferred" ? data.counts.byTriage.deferred : null;
							return (
								<button key={v} type="button" aria-pressed={filters.triage === v} onClick={() => update({ triage: v })} className={chip(filters.triage === v)}>
									{TRIAGE_VIEW_LABEL[v]}{n === null ? "" : ` ${n}`}
								</button>
							);
						})}
						<button type="button" aria-pressed={filters.needsComputer} onClick={() => update({ needsComputer: !filters.needsComputer })} className={chip(filters.needsComputer)}>
							Needs computer {data.counts.byTriage.needsComputer}
						</button>
					</fieldset>
					<fieldset className="flex flex-wrap items-center gap-1.5 min-w-0 border-0 p-0 m-0" aria-label="Filter by urgency">
						{INBOX_URGENCIES.filter((u) => data.counts.byUrgency[u] || filters.urgency === u).map((u) => (
							<button key={u} type="button" aria-pressed={filters.urgency === u} onClick={() => update({ urgency: filters.urgency === u ? null : u })} className={chip(filters.urgency === u)}>
								{u === "blocking" ? "Blocking" : u === "normal" ? "Normal" : "Low"} {data.counts.byUrgency[u] ?? 0}
							</button>
						))}
					</fieldset>
					<div className="flex flex-wrap gap-2">
						{/* Selects, not chip rows: the account has dozens of instances (see Diagnostics). */}
						<select aria-label="Instance" value={filters.instances[0] ?? ""} onChange={(e) => update({ instances: e.target.value ? [e.target.value] : [] })} className="min-w-0 max-w-full bg-panel border border-line rounded-lg px-2 py-1 text-xs text-ink">
							<option value="">Every instance</option>
							{data.counts.byInstance.map((i) => <option key={i.instanceId} value={i.instanceId}>{i.name ?? i.instanceId} ({i.count})</option>)}
						</select>
						<select aria-label="Agent" value={filters.agent ?? ""} onChange={(e) => update({ agent: e.target.value || null })} className="min-w-0 max-w-full bg-panel border border-line rounded-lg px-2 py-1 text-xs text-ink">
							<option value="">Every agent</option>
							{data.counts.byAgent.map((a) => <option key={a.slug} value={a.slug}>{a.slug} ({a.count})</option>)}
						</select>
						{anyFilter && <button type="button" onClick={() => setSearch(filtersToQuery({ ...filters, kinds: [], instances: [], agent: null, urgency: null, triage: "review", needsComputer: false }), { replace: true })} className="text-xs text-accent font-semibold">Clear filters</button>}
					</div>
				</div>
			)}

			{actionErr && <div role="alert" className="mb-3 p-3 rounded-lg border border-danger text-sm text-danger break-words">{actionErr}</div>}
			{failed.length > 0 && (
				<div role="alert" className="mb-3 p-3 rounded-lg border border-danger text-sm text-danger break-words" data-testid="inbox-partial">
					Could not read {failed.map((k) => KIND_LABEL[k].toLowerCase()).join(", ")}. What is listed may be missing items. <button type="button" onClick={() => void load()} className="underline font-semibold">Retry</button>
				</div>
			)}
			{truncated.length > 0 && (
				<div className="mb-3 text-xs text-muted-soft break-words">More are waiting than are listed for {truncated.map((k) => KIND_LABEL[k].toLowerCase()).join(", ")}; answer these first.</div>
			)}

			{!data && !loadErr ? (
				<p className="text-center py-8 text-muted text-sm">Loading...</p>
			) : !data ? (
				<LoadFailed what="what is waiting on you" detail={loadErr} onRetry={load} testId="inbox-load-failed" />
			) : data.items.length === 0 ? (
				failed.length > 0 ? null : <p className="text-center py-8 text-muted-soft text-sm">{anyFilter ? "Nothing matches these filters." : "Nothing is waiting on you."}</p>
			) : (
				<ul className="flex flex-col gap-2 list-none p-0 m-0">
					{data.items.map((it) => {
						const exp = expiryLabel(it.expiresAt, now);
						const t = it.triage;
						return (
							<li key={it.id}>
								<Link to={it.route} className="block p-3 bg-panel border border-line rounded-lg no-underline text-ink hover:border-accent [overflow-wrap:anywhere]">
									<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
										<span className={`font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${it.urgency === "blocking" ? "bg-danger text-white" : "bg-accent-soft text-accent"}`}>{KIND_LABEL[it.kind]}</span>
										{it.instanceName && <span className="text-muted font-semibold">{it.instanceName}</span>}
										<span className="text-muted-soft">{ageLabel(it.createdAt, now)}</span>
										{exp && <span className="text-muted-soft">{exp}</span>}
										{t && t.status === "discussed" && <span className="text-muted font-semibold">Discussed</span>}
										{t && t.status === "deferred" && <span className="text-muted font-semibold">{deferLabel(t, now)}</span>}
										{t?.needsComputer && <span className="font-semibold text-accent">Needs computer</span>}
									</div>
									<div className="font-semibold text-sm mt-1">{it.title}</div>
									{it.summary && <div className="text-sm text-muted mt-0.5">{it.summary}</div>}
								</Link>
								{t && (
									<div className="flex flex-wrap items-center gap-1.5 mt-1" data-testid="inbox-triage-actions">
										{t.status !== "discussed" && <button type="button" disabled={busy === it.id} onClick={() => void triage(it, { status: "discussed" })} className={chip(false)}>Mark discussed</button>}
										{t.status !== "deferred" && <button type="button" disabled={busy === it.id} onClick={() => void triage(it, { status: "deferred" })} className={chip(false)}>Defer</button>}
										<label className="text-xs text-muted flex items-center gap-1">
											Defer until
											<input
												type="date"
												min={new Date(now + 86_400_000).toISOString().slice(0, 10)}
												disabled={busy === it.id}
												onChange={(e) => e.target.value && void triage(it, { status: "deferred", defer_until: new Date(`${e.target.value}T09:00:00`).toISOString() })}
												className="bg-panel border border-line rounded-lg px-1.5 py-0.5 text-xs text-ink"
											/>
										</label>
										<button type="button" aria-pressed={t.needsComputer} disabled={busy === it.id} onClick={() => void triage(it, { needs_computer: !t.needsComputer })} className={chip(t.needsComputer)}>Needs computer</button>
										{t.status !== "new" && <button type="button" disabled={busy === it.id} onClick={() => void triage(it, { status: "new" })} className="text-xs text-accent font-semibold">Back to New</button>}
									</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</Page>
	);
}
