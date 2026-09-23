import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { AlertTriangle, RefreshCw } from "lucide-react";
import Page from "../components/Page";
import Card from "../components/Card";
import Button from "../components/Button";
import LoadFailed from "../components/LoadFailed";
import {
	describeFacets,
	describeRecurrence,
	filterSignatures,
	instancesIn,
	headline,
	recurrenceOf,
	sourcesOf,
	totalsOf,
	triageOrder,
	type DiagnosticsFilter,
	type ErrorSignature,
	type ErrorSummaryResponse,
} from "../lib/diagnostics";
import { MY_INSTANCES_WITH_PAUSED } from "../lib/instancePause";

/**
 * What is recurring across this account, and how long nobody has fixed it (#823).
 *
 * The durable error log has been readable since #424 — but only through the `list_errors` MCP
 * tool, on demand, as a flat feed. Nothing surfaced it, so a commit-close-watch warning failing
 * hourly for days across two repos was invisible unless somebody happened to poll for it. That is
 * what this page is for, and it is why the DEFAULT ORDER is triage rather than recency: a thing
 * that has been broken for four days must not sit below whatever happened most recently, which is
 * exactly how the flat feed buried it.
 *
 * Reads `/v1/errors/summary`, which groups by normalized signature. All the judgement —
 * persistence, activity, ordering, wording — is pure in `lib/diagnostics.ts` and tested there.
 */

const RANGES = [1, 7, 30] as const;

export default function Diagnostics() {
	const [signatures, setSignatures] = useState<ErrorSignature[] | null>(null);
	const [truncated, setTruncated] = useState(false);
	const [days, setDays] = useState<(typeof RANGES)[number]>(7);
	const [filter, setFilter] = useState<DiagnosticsFilter>({});
	const [failed, setFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	// Captured once per load, not read per render: `Date.now()` inside the render would make every
	// span and every "N minutes ago" shift underneath the reader between paints.
	const [now, setNow] = useState(() => Date.now());
	const [names, setNames] = useState<Record<string, string>>({});
	// The instance lives in the REQUEST, not in `filter`: the window is 2000 rows of the whole
	// account, so filtering a fetched page client-side would let a quiet agent's failures fall
	// outside it and render as "nothing wrong with this agent" (#823's per-agent bullet).
	const [instanceId, setInstanceId] = useState<string>("");

	const load = useCallback(async () => {
		setBusy(true);
		try {
			const qs = new URLSearchParams({ days: String(days) });
			if (instanceId) qs.set("instance_id", instanceId);
			const d = await api<ErrorSummaryResponse>(`/v1/errors/summary?${qs.toString()}`);
			setSignatures(d.signatures ?? []);
			setTruncated(Boolean(d.truncated));
			setNow(Date.now());
			setFailed(false);
		} catch {
			// The list is the page. A failure here has to say so — rendering an empty state would
			// claim a clean account, which is the one wrong answer a diagnostics page can give.
			setFailed(true);
		} finally {
			setBusy(false);
		}
	}, [days, instanceId]);

	useEffect(() => {
		void load();
	}, [load]);

	useEffect(() => {
		void (async () => {
			try {
				const d = await api<{ instances?: Array<{ id: string; name?: string; agent_name?: string }> }>(MY_INSTANCES_WITH_PAUSED);
				setNames(Object.fromEntries((d.instances || []).map((i) => [i.id, i.name || i.agent_name || i.id])));
			} catch {
				// IGNORABLE: these are LABELS on rows that render fine without them, and the list
				// reports its own read failure. An error here would claim the diagnostics failed.
			}
		})();
	}, []);

	const totals = useMemo(() => totalsOf(signatures ?? [], now), [signatures, now]);
	const sources = useMemo(() => sourcesOf(signatures ?? []), [signatures]);
	const shown = useMemo(
		() => filterSignatures(signatures ?? [], filter, now).sort((a, b) => triageOrder(a, b, now)),
		[signatures, filter, now],
	);
	const lead = headline(totals);
	const instanceOptions = useMemo(() => instancesIn(signatures ?? []), [signatures]);
	const nameOf = useCallback((id: string) => names[id] ?? `${id.slice(0, 8)}…`, [names]);

	if (failed) return <Page><LoadFailed what="diagnostics" onRetry={load} /></Page>;

	return (
		<Page width={1040}>
			<div className="flex items-center justify-between gap-3 mb-4">
				<h1 className="text-xl font-semibold text-ink-strong">Diagnostics</h1>
				<Button variant="ghost" size="icon" onClick={() => void load()} disabled={busy} aria-label="Refresh" data-testid="diagnostics-refresh">
					<RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />
				</Button>
			</div>

			{/* The lead is silent unless something has been recurring for a day or more. A banner
			    that always says something is a banner nobody reads — the failure one level up. */}
			{lead && (
				// Not a `Card`: its tones are `panel`/`paper`, and layering a background over one is a
				// Tailwind conflict rather than an override. Widening a shared primitive for one
				// banner is the wrong trade.
				<div
					className="mb-4 flex items-start gap-2 rounded-xl p-3 sm:p-4 bg-warning-soft border border-warning-line"
					data-testid="diagnostics-headline"
				>
					<AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
					<p className="text-sm text-ink">{lead}</p>
				</div>
			)}

			<div className="flex flex-wrap items-center gap-2 mb-4">
				<fieldset className="flex border border-line rounded-lg overflow-hidden" aria-label="Time range">
					{RANGES.map((d) => (
						<button
							key={d}
							type="button"
							onClick={() => setDays(d)}
							aria-pressed={days === d}
							className={`px-2.5 py-1 text-xs font-bold whitespace-nowrap ${days === d ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel-hover"}`}
						>
							{d === 1 ? "24h" : `${d}d`}
						</button>
					))}
				</fieldset>

				<fieldset className="flex border border-line rounded-lg overflow-hidden" aria-label="Filter by severity">
					{([
						["All", undefined],
						["Errors", "error"],
						["Warnings", "warn"],
					] as const).map(([label, level]) => (
						<button
							key={label}
							type="button"
							onClick={() => setFilter((f) => ({ ...f, level: level as DiagnosticsFilter["level"] }))}
							aria-pressed={filter.level === level}
							className={`px-2.5 py-1 text-xs font-bold whitespace-nowrap ${filter.level === level ? "bg-accent-soft text-accent" : "text-muted hover:bg-panel-hover"}`}
						>
							{label}
							{level === "error" && totals.errors > 0 ? ` (${totals.errors})` : ""}
							{level === "warn" && totals.warnings > 0 ? ` (${totals.warnings})` : ""}
						</button>
					))}
				</fieldset>

				{/* Only offered when there IS something persistent — a filter that can only ever
				    return nothing is a control that teaches people the page is empty. */}
				{totals.persistent > 0 && (
					<fieldset className="flex border border-warning-line rounded-lg overflow-hidden" aria-label="Filter by persistence">
						<button
							type="button"
							onClick={() => setFilter((f) => ({ ...f, persistentOnly: !f.persistentOnly }))}
							aria-pressed={Boolean(filter.persistentOnly)}
							data-testid="diagnostics-persistent-filter"
							className={`px-2.5 py-1 text-xs font-bold whitespace-nowrap ${filter.persistentOnly ? "bg-warning-soft text-warning" : "text-muted hover:bg-panel-hover"}`}
						>
							Recurring 1d+ ({totals.persistent})
						</button>
					</fieldset>
				)}
			</div>

			{/* One agent's health at a glance (#823). A <select> rather than chips: the account has
			    thirty-odd instances and a chip row of that length is a filter nobody uses. Kept
			    visible even when the current answer names none, so the control does not appear and
			    vanish as the data changes underneath it. */}
			{(instanceOptions.length > 0 || instanceId) && (
				<div className="flex items-center gap-2 mb-4">
					<label htmlFor="diag-instance" className="text-xs text-muted">Agent</label>
					<select
						id="diag-instance"
						value={instanceId}
						onChange={(e) => setInstanceId(e.target.value)}
						data-testid="diagnostics-instance"
						className="bg-panel border border-line rounded-lg px-2 py-1 text-xs text-ink"
					>
						<option value="">Every agent</option>
						{/* The selected one is kept in the list even if the filtered answer no longer
						    names it — otherwise choosing an agent with one quiet failure removes its
						    own option and the control resets itself. */}
						{[...new Set([...instanceOptions, ...(instanceId ? [instanceId] : [])])].sort().map((id) => (
							<option key={id} value={id}>{nameOf(id)}</option>
						))}
					</select>
					{instanceId && (
						<span className="text-2xs text-muted-soft">
							Only failures whose retained sample names this agent — a lower bound.
						</span>
					)}
				</div>
			)}

			{sources.length > 1 && (
				<fieldset className="flex flex-wrap items-center border border-line rounded-lg overflow-hidden mb-4" aria-label="Filter by source">
					<button
						type="button"
						onClick={() => setFilter((f) => ({ ...f, source: undefined }))}
						aria-pressed={!filter.source}
						className={`px-2 py-1 text-2xs font-bold ${!filter.source ? "bg-accent-soft text-accent" : "text-muted-soft hover:bg-panel-hover"}`}
					>
						All sources
					</button>
					{sources.map((s2) => (
						<button
							key={s2.source}
							type="button"
							onClick={() => setFilter((f) => ({ ...f, source: f.source === s2.source ? undefined : s2.source }))}
							aria-pressed={filter.source === s2.source}
							className={`px-2 py-1 text-2xs font-mono ${filter.source === s2.source ? "bg-accent-soft text-accent" : "text-muted-soft hover:bg-panel-hover"}`}
						>
							{s2.source}
						</button>
					))}
				</fieldset>
			)}

			{signatures === null ? (
				<p className="text-sm text-muted">Loading…</p>
			) : shown.length === 0 ? (
				<Card className="text-center py-8">
					<p className="text-sm text-muted">
						{signatures.length === 0
							? `Nothing recorded${instanceId ? ` for ${nameOf(instanceId)}` : ""} in the last ${days === 1 ? "24 hours" : `${days} days`}.`
							: "Nothing matches these filters."}
					</p>
					{(signatures.length > 0 || instanceId) && (
						<button
							type="button"
							onClick={() => {
								setFilter({});
								setInstanceId("");
							}}
							className="mt-2 text-xs text-accent hover:underline"
						>
							Clear filters
						</button>
					)}
				</Card>
			) : (
				<div className="flex flex-col gap-2" data-testid="diagnostics-list">
					{shown.map((s) => {
						const r = recurrenceOf(s, now);
						const isError = (s.level ?? "error") !== "warn";
						return (
							<Card key={s.key} className="flex flex-col gap-1.5" data-testid="diagnostics-row">
								<div className="flex items-start gap-2 flex-wrap">
									<span
										className={`px-1.5 py-0.5 rounded text-2xs font-semibold uppercase shrink-0 ${isError ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning"}`}
									>
										{isError ? "error" : "warn"}
									</span>
									<span className="px-1.5 py-0.5 rounded text-2xs font-mono text-muted border border-line shrink-0">{s.source}</span>
									{r.kind === "persistent" && (
										<span
											data-testid="diagnostics-persistent-badge"
											className="px-1.5 py-0.5 rounded text-2xs font-semibold bg-warning-soft text-warning border border-warning-line shrink-0"
										>
											{r.active ? "recurring 1d+" : "unaddressed"}
										</span>
									)}
									{s.lastStatus != null && <span className="text-2xs text-muted-soft shrink-0">HTTP {s.lastStatus}</span>}
								</div>
								<p className="text-sm text-ink break-words">{s.sample}</p>
								{/* What it touched: instance, repo, failure class, resumed-vs-ended — #823's
								    coding-crash bullet, which turned out to live in this same feed. */}
								{describeFacets(s, nameOf) && (
									<p className="text-2xs text-muted-soft" data-testid="diagnostics-facets">{describeFacets(s, nameOf)}</p>
								)}
								<p className="text-xs text-muted">
									{describeRecurrence(s, now)}
									{/* `rows` beside `count` is the collapse working, stated rather than implied:
									    far apart means repeats are folding; equal means each occurrence still
									    has its own row. */}
									{s.rows !== s.count && <span className="text-muted-soft"> ({s.rows} log {s.rows === 1 ? "entry" : "entries"})</span>}
								</p>
							</Card>
						);
					})}
					{truncated && (
						<p className="text-xs text-muted-soft px-1" data-testid="diagnostics-truncated">
							The window was full — there is more than this in the last {days === 1 ? "24 hours" : `${days} days`}. Narrow by source or shorten the range.
						</p>
					)}
				</div>
			)}
		</Page>
	);
}
