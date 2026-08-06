import { useState, useCallback, useEffect } from "react";
import Page from "../components/Page";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { BarChart3, Info, RefreshCw } from "lucide-react";

interface Bucket { key: string; label?: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costMicros: number; calls: number }
interface Day { date: string; inputTokens: number; outputTokens: number; costMicros: number; calls: number }
interface UsageData {
	range: string;
	totals: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costMicros: number; calls: number };
	daily: Day[];
	byModel: Bucket[];
	byKind: Bucket[];
	byAgent: Bucket[];
}

const RANGES = [
	{ id: "7d", label: "7 days" },
	{ id: "30d", label: "30 days" },
	{ id: "90d", label: "90 days" },
	{ id: "all", label: "All time" },
] as const;

/** micros of USD → "$1.23" (or "<$0.01" for tiny non-zero, "$0.00" for zero). */
function usd(micros: number): string {
	const v = (micros || 0) / 1_000_000;
	if (v === 0) return "$0.00";
	if (v < 0.01) return "<$0.01";
	if (v < 1000) return `$${v.toFixed(2)}`;
	return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Compact token count: 1234 → "1.2K", 3_400_000 → "3.4M". */
function tok(n: number): string {
	const x = n || 0;
	if (x < 1000) return String(x);
	if (x < 1_000_000) return `${(x / 1000).toFixed(x < 10_000 ? 1 : 0)}K`;
	return `${(x / 1_000_000).toFixed(x < 10_000_000 ? 1 : 0)}M`;
}

const KIND_LABEL: Record<string, string> = {
	chat: "Chat", apply: "Job apply", coding: "Coding (Pilot)", copilot: "Co-pilot",
	overseer: "Overseer", run: "Direct run", resume: "Résumé parse", translate: "Translation", voice: "Voice",
	// The coding CLI itself, reporting its own cost (#267). Named apart from "coding" — which is
	// only the cloud-side Pilot choosing the next instruction — because the two differ by an
	// order of magnitude and a single "coding" row made the Engine's spend look like all of it.
	engine: "Coding engine (measured)",
};

/** A dead-simple, dependency-free SVG bar chart (one bar per day). Value is chosen by `metric`. */
function DailyChart({ daily, metric }: { daily: Day[]; metric: "cost" | "tokens" }) {
	const vals = daily.map((d) => (metric === "cost" ? d.costMicros : d.inputTokens + d.outputTokens));
	const max = Math.max(1, ...vals);
	const W = 640, H = 140, pad = 4;
	const n = Math.max(1, daily.length);
	const bw = (W - pad * 2) / n;
	return (
		<div className="overflow-x-auto">
			<svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[420px]" style={{ height: 150 }} preserveAspectRatio="none" role="img" aria-label="Daily usage">
				{daily.map((d, i) => {
					const v = vals[i];
					const h = Math.round((v / max) * (H - 24));
					const x = pad + i * bw;
					return (
						<g key={d.date}>
							<rect x={x + bw * 0.12} y={H - h - 16} width={bw * 0.76} height={Math.max(v > 0 ? 2 : 0, h)} rx={1.5}
								className="fill-accent" opacity={0.85}>
								<title>{`${d.date}: ${metric === "cost" ? usd(d.costMicros) : `${tok(d.inputTokens + d.outputTokens)} tokens`} · ${d.calls} calls`}</title>
							</rect>
						</g>
					);
				})}
			</svg>
			{daily.length > 0 && (
				<div className="flex justify-between text-[0.65rem] text-muted-soft px-1">
					<span>{daily[0].date.slice(5)}</span>
					<span>{daily[daily.length - 1].date.slice(5)}</span>
				</div>
			)}
		</div>
	);
}

/** Horizontal breakdown bars, biggest first, sized by cost (falls back to tokens when all-free). */
function Breakdown({ rows, labelOf }: { rows: Bucket[]; labelOf: (b: Bucket) => string }) {
	const useCost = rows.some((r) => r.costMicros > 0);
	const val = (r: Bucket) => (useCost ? r.costMicros : r.inputTokens + r.outputTokens);
	const max = Math.max(1, ...rows.map(val));
	if (rows.length === 0) return <p className="text-sm text-muted-soft py-2">No usage yet.</p>;
	return (
		<div className="flex flex-col gap-1.5">
			{rows.map((r) => (
				<div key={r.key} className="flex items-center gap-2 text-sm">
					<span className="w-28 sm:w-36 truncate shrink-0" title={labelOf(r)}>{labelOf(r)}</span>
					<div className="flex-1 h-4 bg-line/40 rounded overflow-hidden min-w-0">
						<div className="h-full bg-accent/70 rounded" style={{ width: `${Math.max(2, (val(r) / max) * 100)}%` }} />
					</div>
					<span className="w-16 text-right shrink-0 tabular-nums text-muted">{usd(r.costMicros)}</span>
					<span className="w-14 text-right shrink-0 tabular-nums text-muted-soft text-xs">{tok(r.inputTokens + r.outputTokens)}</span>
				</div>
			))}
		</div>
	);
}

export default function Usage() {
	const [range, setRange] = useState<string>("30d");
	const [data, setData] = useState<UsageData | null>(null);
	const [loading, setLoading] = useState(true);
	const [metric, setMetric] = useState<"cost" | "tokens">("cost");

	const load = useCallback(async () => {
		try {
			const d = await api<UsageData>(`/v1/usage?range=${encodeURIComponent(range)}`);
			setData(d);
		} catch { /* keep last good */ }
		setLoading(false);
	}, [range]);

	// The poll hook ONLY fires on the interval — it keeps `fn` in a ref and its effect deps are
	// [ms, enabled], so without this the page sat on "Loading…" for a full 30s on every visit,
	// and switching the range kept rendering the old range's numbers (with no spinner) until the
	// next tick. `load` changes identity with `range`, so one effect covers both.
	useEffect(() => {
		void load();
	}, [load]);
	// No busy tier, deliberately (#272). Usage aggregates a ledger written by work happening
	// somewhere else entirely — there is no local signal that says spend is accruing right now,
	// and inventing one (e.g. "the totals moved") would just be the poll watching itself. So both
	// tiers stay at the existing 30s and the only change is that a backgrounded tab stops
	// re-aggregating the last 30 days of usage twice a minute, then catches up on return.
	useTieredPolling(load, { activeMs: 30000, passiveMs: 30000 }, false);

	const totals = data?.totals;
	// null when there is nothing to report on — no calls, or only pre-0074 rows where the split was
	// never recorded. Showing "0%" then would claim the cache is failing when we simply don't know.
	const cacheHitRate = (() => {
		const read = totals?.cacheReadTokens ?? 0;
		const fresh = totals?.inputTokens ?? 0;
		return read + fresh > 0 && read > 0 ? read / (read + fresh) : null;
	})();
	const empty = !!data && totals && totals.calls === 0;
	// Only worth explaining the engine caveat to someone who actually codes with an agent.
	const hasCodingUsage = !!data?.byKind.some((b) => b.key === "engine" || b.key === "coding" || b.key === "copilot");

	return (
		<Page width={1040}>
			<div className="flex justify-between items-center mb-1">
				<div className="flex items-center gap-2.5">
					<BarChart3 size={20} className="text-accent" />
					<h1 className="font-display text-xl font-bold">Usage</h1>
				</div>
				<button type="button" onClick={load} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold hover:border-accent hover:text-accent">
					<RefreshCw size={13} /> Refresh
				</button>
			</div>
			<p className="text-sm text-muted mb-2">
				Token usage and cost across all your agents. Most rows are <b>estimated</b> from list prices on your own key (BYOK) — not a bill. Coding-engine rows are the exception: the CLI reports what it actually spent. History starts when tracking was enabled.
			</p>
			<Scope />

			{/* Range selector */}
			<div className="flex gap-1 mb-4">
				{RANGES.map((r) => (
					<button key={r.id} type="button" onClick={() => setRange(r.id)}
						className={`text-xs px-3 py-1.5 rounded-lg border font-semibold transition-colors ${range === r.id ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-ink"}`}>
						{r.label}
					</button>
				))}
			</div>

			{loading && !data ? (
				<p className="text-center py-8 text-muted text-sm">Loading…</p>
			) : empty ? (
				<div className="text-center py-10 px-4 bg-panel border border-line rounded-xl">
					<BarChart3 size={28} className="mx-auto text-muted-soft mb-2" />
					<div className="font-semibold text-sm">No usage in this range</div>
					<div className="text-sm text-muted mt-1">Chat with an agent or run a task — usage shows up here.</div>
				</div>
			) : data && totals ? (
				<>
					{/* Headline totals */}
					<div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mb-4">
						<Stat label="Est. cost" value={usd(totals.costMicros)} accent />
						<Stat label="Total tokens" value={tok(totals.inputTokens + totals.outputTokens)} />
						<Stat label="Input · Output" value={`${tok(totals.inputTokens)} · ${tok(totals.outputTokens)}`} />
						{/* Cache hit rate — read ÷ (input + read). The number that says whether prompt
						    caching is actually working; a read costs a tenth of a fresh input token,
						    so this is where the money is. Hidden until there is cache data, since
						    rows written before migration 0074 genuinely do not know. */}
						{cacheHitRate === null ? (
							<Stat label="AI calls" value={totals.calls.toLocaleString()} />
						) : (
							<Stat label="Prompt cache hit" value={`${Math.round(cacheHitRate * 100)}%`} />
						)}
					</div>
					{cacheHitRate !== null && (
						<div className="text-xs text-muted-soft -mt-2 mb-4">
							{totals.calls.toLocaleString()} AI calls · {tok(totals.cacheReadTokens || 0)} tokens served from cache at a tenth of the input price.
						</div>
					)}

					{/* Daily chart */}
					<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-4">
						<div className="flex justify-between items-center mb-2">
							<h3 className="text-sm font-bold">Over time</h3>
							<div className="flex gap-1">
								{(["cost", "tokens"] as const).map((m) => (
									<button key={m} type="button" onClick={() => setMetric(m)}
										className={`text-[0.7rem] px-2 py-1 rounded border font-semibold capitalize ${metric === m ? "border-accent text-accent" : "border-line text-muted-soft"}`}>{m}</button>
								))}
							</div>
						</div>
						<DailyChart daily={data.daily} metric={metric} />
					</div>

					{/* Breakdowns */}
					<div className="grid md:grid-cols-2 gap-4">
						<div className="bg-panel border border-line rounded-xl p-3 sm:p-4">
							<h3 className="text-sm font-bold mb-2">By agent</h3>
							<Breakdown rows={data.byAgent} labelOf={(b) => b.label || b.key} />
						</div>
						<div className="bg-panel border border-line rounded-xl p-3 sm:p-4">
							<h3 className="text-sm font-bold mb-2">By model</h3>
							<Breakdown rows={data.byModel} labelOf={(b) => b.key} />
						</div>
						<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 md:col-span-2">
							<h3 className="text-sm font-bold mb-2">By activity</h3>
							<Breakdown rows={data.byKind} labelOf={(b) => KIND_LABEL[b.key] || b.key} />
							{/* Two rows here read as the same thing and differ by an order of magnitude.
							    Naming them apart in the legend is not enough — the reason has to be at
							    the point of comparison, or "Coding (Pilot)" looks like the cost of
							    coding. The fuller caveat lives in <Scope />; this is the one line that
							    stops the two rows being misread as duplicates. */}
							{hasCodingUsage && (
								<p className="text-xs text-muted-soft mt-3 pt-3 border-t border-line">
									<b>Coding (Pilot)</b> is the cloud deciding what to tell the engine to do. <b>Coding engine</b> is the CLI
									doing it, priced by the CLI itself. Codex and Grok report nothing, so they appear here at all only via the Pilot.
								</p>
							)}
						</div>
					</div>
				</>
			) : (
				<p className="text-center py-8 text-muted text-sm">Couldn’t load usage.</p>
			)}
		</Page>
	);
}

/**
 * What the number on this page covers — and, more usefully, what it leaves out.
 *
 * "Estimated, not a bill" was already stated, but not in which DIRECTION it is wrong. #270 said
 * the coding Engine's spend was missing entirely; #267 then made Claude Code report it, so that
 * bullet has been replaced by the figure it was standing in for — which is what its own comment
 * asked for. The exclusion did not vanish, it SHRANK: engines with no structured output (Codex,
 * Grok) still cannot be measured, and they now deserve the plain statement, because a page that
 * says "engine spend is included" without qualifying it is a new version of the same
 * looks-complete problem.
 */
function Scope() {
	return (
		<details className="mb-3 group">
			<summary className="flex items-center gap-1.5 text-xs text-muted-soft cursor-pointer hover:text-muted list-none [&::-webkit-details-marker]:hidden">
				<Info size={13} />
				<span className="underline decoration-dotted underline-offset-2">What this includes — and what it doesn’t</span>
			</summary>
			<div className="mt-2 bg-panel border border-line rounded-xl p-3 text-sm">
				<div className="font-semibold text-xs uppercase tracking-wide text-muted-soft">Included</div>
				<ul className="mt-1 space-y-0.5 text-muted">
					<li>· Calls the platform makes on your key — chat, voice, translation, and the Pilot, Co-pilot and Overseer decisions behind a coding session.</li>
					<li>
						· <b className="text-ink">The Claude Code engine’s own spend</b>, shown as “Coding engine (measured)”.
						It runs on your machine, so the CLI reports what each turn cost and that figure is used as-is — the one
						line here that is a measurement rather than an estimate.
					</li>
				</ul>
				<div className="font-semibold text-xs uppercase tracking-wide text-muted-soft mt-3">Not included</div>
				<ul className="mt-1 space-y-0.5 text-muted">
					<li>
						· <b className="text-ink">Other coding engines.</b> Codex and Grok report no usage, so their spend
						appears nowhere here — deliberately absent rather than shown as zero. If you run a coding session on
						one of them, your real spend is higher than the figure above.
					</li>
				</ul>
				<p className="text-xs text-muted-soft mt-3">
					Apart from the measured engine rows, everything here is priced from published list prices at the time of
					the call, so it is an estimate — never a provider bill. Check your provider’s dashboard for the
					authoritative number.
				</p>
			</div>
		</details>
	);
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
	return (
		<div className="bg-panel border border-line rounded-xl px-3 py-2.5">
			<div className="text-[0.7rem] uppercase tracking-wide text-muted-soft">{label}</div>
			<div className={`text-lg font-bold tabular-nums ${accent ? "text-accent" : ""}`}>{value}</div>
		</div>
	);
}
