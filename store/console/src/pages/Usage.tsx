import { useState, useCallback, useEffect } from "react";
import Page from "../components/Page";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { AlertTriangle, BarChart3, Info, RefreshCw } from "lucide-react";

interface Bucket { key: string; label?: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costMicros: number; calls: number }
interface Day { date: string; inputTokens: number; outputTokens: number; costMicros: number; calls: number }
/**
 * What the dollars above LEAVE OUT, counted (#348).
 *
 * A coding CLI driven through the terminal connector — tmux, kitty, iTerm2 — writes no ledger row,
 * because a pane carries rendered text and not the CLI's own usage record. Before this the page
 * simply showed a smaller total, and a smaller total reads as cheaper. It is not cheaper, it is
 * invisible: the same binary on the same repo sends the same thing to the API either way.
 *
 * `windowDays` matters because the trace this is counted from prunes at 14 days, so the count can
 * cover a shorter period than the dollars beside it. The page says which rather than implying they
 * line up.
 */
interface Unmetered {
	drives: number;
	aiCliDrives: number;
	instances: number;
	lastAt: number | null;
	windowDays: number;
}
interface UsageData {
	range: string;
	totals: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costMicros: number; chargedCostMicros?: number; calls: number };
	daily: Day[];
	byModel: Bucket[];
	byKind: Bucket[];
	byAgent: Bucket[];
	/** Sessions whose cost could not be read at all (#348) — absent, never zero. */
	unmetered?: Unmetered;
	/** Value split by who pays it (#346). Absent from an older API — the page degrades to totals. */
	byPayer?: Bucket[];
}

/**
 * What each payer means for the reader's money. The `unknown` note is the honest one and the one
 * that matters most: `machine-login` is the most common way a coding engine signs in, and it does
 * not tell us whether a subscription or an API key is behind it.
 */
const PAYER_NOTE: Record<string, string> = {
	"byok-api": "Real money on your provider account. Estimated at list prices — your provider's dashboard has the bill.",
	subscription: "No per-token charge. It draws your plan's allowance, which is measured in tokens over a rolling window, not in dollars. If you are past that allowance and drawing on usage credits, you ARE being charged and we cannot see it.",
	platform: "Our Workers AI and platform models. Costs you nothing.",
	unknown: "A coding engine signed in with a login stored on your machine. That may be a subscription or an API key configured inside the CLI — we can't tell from here, so we don't guess.",
};

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
	// The coding CLI itself (#267). Named apart from "coding" — which is only the cloud-side Pilot
	// choosing the next instruction — because the two differ by an order of magnitude and a single
	// "coding" row made the Engine's spend look like all of it.
	//
	// It said "(measured)" until #347. It is not: Claude Code computes its figure locally from
	// token counts at standard list rates, exactly as we do, and it is the row LEAST likely to
	// correspond to a charge, because a subscription login is the normal way an engine signs in.
	// The label is retired rather than softened — the payer column now carries the real answer.
	engine: "Coding engine",
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
	const unmetered = data?.unmetered;
	const hasUnmetered = (unmetered?.drives ?? 0) > 0;
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
				Token usage across all your agents. Every dollar figure here is <b>estimated from published list
				prices</b> — ours for platform calls, Claude Code’s own arithmetic for coding-engine rows. Neither is a
				bill. What differs between rows is <b>who pays</b>. History starts when tracking was enabled.
			</p>
			<Scope unmetered={unmetered} />

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
				<>
					{/* "No usage" is a claim, and it is false when the work done this range went through a
					    path that cannot be measured. An account that drove Claude Code in tmux all week
					    would otherwise be told it did nothing — the $0 lie in its purest form. */}
					<UnmeteredNotice unmetered={unmetered} />
					<div className="text-center py-10 px-4 bg-panel border border-line rounded-xl">
						<BarChart3 size={28} className="mx-auto text-muted-soft mb-2" />
						<div className="font-semibold text-sm">{hasUnmetered ? "No measured usage in this range" : "No usage in this range"}</div>
						<div className="text-sm text-muted mt-1">
							{hasUnmetered
								? "Everything your agents did this range ran on a path the platform cannot meter — so this page has nothing to total, not nothing to report."
								: "Chat with an agent or run a task — usage shows up here."}
						</div>
					</div>
				</>
			) : data && totals ? (
				<>
					<UnmeteredNotice unmetered={unmetered} />
					{/* Headline totals */}
					<div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mb-4">
						{/* The headline is CHARGED value, not total value (#346). "Est. cost" over an
						    undifferentiated sum is what taught everyone — the product included — to
						    read this page as a bill, and then to enforce one. The full list value is
						    still shown, one line down, where it cannot be mistaken for what is owed. */}
						<Stat label="Est. billed" value={usd(totals.chargedCostMicros ?? totals.costMicros)} accent />
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
					<div className="text-xs text-muted-soft -mt-2 mb-4">
						{cacheHitRate !== null && (
							<>{totals.calls.toLocaleString()} AI calls · {tok(totals.cacheReadTokens || 0)} tokens served from cache at a tenth of the input price. </>
						)}
						{/* The two figures are never added together, and this line is where that is
						    said. Total list value is the answer to "what would this have cost on the
						    API?" — a genuinely useful number, and not one anybody owes. */}
						{totals.chargedCostMicros !== undefined && totals.chargedCostMicros !== totals.costMicros && (
							<>{usd(totals.costMicros)} of list-price value in total, of which {usd(totals.chargedCostMicros)} is charged to someone.</>
						)}
					</div>

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
						{/* Who pays (#346) — first, and full width, because it is the axis that decides
						    how to read every other card on this page. Without it the reader has one
						    undifferentiated total and no way to tell which part of it is money. */}
						{!!data.byPayer?.length && (
							<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 md:col-span-2">
								<h3 className="text-sm font-bold mb-2">Who pays</h3>
								<Breakdown rows={data.byPayer} labelOf={(b) => b.label || b.key} />
								<ul className="mt-3 pt-3 border-t border-line space-y-1 text-xs text-muted-soft">
									{data.byPayer.map((b) => PAYER_NOTE[b.key] && (
										<li key={b.key}><b>{b.label || b.key}</b> — {PAYER_NOTE[b.key]}</li>
									))}
								</ul>
							</div>
						)}
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
									doing it, priced by the CLI at list rates — an estimate like the rest, and usually one nobody is charged.
									Codex and Grok report nothing, so they appear here at all only via the Pilot.
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
 * What the number on this page covers, what it leaves out — and what KIND of number it is.
 *
 * The third one is the correction (#347). This block used to say the coding-engine row was "the
 * one line here that is a measurement rather than an estimate". Anthropic's docs say the opposite:
 * Claude Code "computes the dollar figure locally from token counts priced at standard list
 * rates … and may differ from your actual bill", and for Max/Pro subscribers "the session cost
 * figure isn't relevant for billing purposes" (https://code.claude.com/docs/en/costs).
 *
 * That is the same construction as our own estimate, computed by a different process — and it is
 * the row LEAST likely to correspond to a charge, because signing in with a subscription is the
 * normal way a coding engine runs. The irony worth remembering: #270's complaint was that engine
 * spend was invisible, and the fix surfaced it AND promoted it to "measured". A page built to be
 * more honest became less so, and a circuit breaker was then built on the promotion (#343).
 *
 * The correct caveat that was already here — Codex and Grok report nothing — is kept verbatim.
 */
function Scope({ unmetered }: { unmetered?: Unmetered }) {
	const drives = unmetered?.drives ?? 0;
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
						· <b className="text-ink">The Claude Code engine’s own turns</b>, shown as “Coding engine”. The CLI
						reports its own dollar figure, but it computes that the same way we do — token counts at standard
						list rates — so it is an estimate too, and Anthropic’s docs say it may differ from your bill.
					</li>
				</ul>
				<div className="font-semibold text-xs uppercase tracking-wide text-muted-soft mt-3">Not included</div>
				<ul className="mt-1 space-y-0.5 text-muted">
					<li>
						· <b className="text-ink">Other coding engines.</b> Codex and Grok report no usage, so their spend
						appears nowhere here — deliberately absent rather than shown as zero. If you run a coding session on
						one of them, your real spend is higher than the figure above.
					</li>
					<li>
						· <b className="text-ink">Anything driven through a terminal.</b> When an agent types into a tmux,
						kitty or iTerm2 pane, all the platform gets back is the rendered text — not the CLI’s own record of
						what the turn cost. That holds even for Claude Code: the same binary is measured when the Pilot runs
						it directly and unmeasured through a pane, so a terminal-driven session is not cheaper than a Pilot
						one, it is invisible.
						{drives > 0 && (
							<>
								{" "}
								<b className="text-ink">
									{drives.toLocaleString()} such {drives === 1 ? "drive" : "drives"}
								</b>{" "}
								{drives === 1 ? "was" : "were"} recorded in the last {unmetered?.windowDays ?? 14} days
								{(unmetered?.aiCliDrives ?? 0) > 0 && <> — {unmetered?.aiCliDrives} with an AI coding CLI running in the pane</>}.
							</>
						)}
					</li>
				</ul>
				<p className="text-xs text-muted-soft mt-3">
					Nothing on this page is a bill. If a coding session signed in with your Claude subscription, that row cost
					you nothing in dollars — it is shown because the tokens are real and they draw your plan’s allowance. For
					what you were actually charged, see{" "}
					<a className="underline hover:text-accent" href="https://platform.claude.com/usage" target="_blank" rel="noreferrer">
						the Claude Console
					</a>{" "}
					for API spend, or claude.ai for subscription plan usage.
				</p>
			</div>
		</details>
	);
}

/**
 * The one thing on this page that must not be behind a disclosure triangle.
 *
 * `<Scope />` is a collapsed `<details>`, which is right for "these numbers are estimates" — a
 * standing caveat a reader can take on trust. It is wrong for "the headline is short by an unknown
 * amount", because that changes what the headline MEANS, and a reader comparing two agents will
 * never open it in time. So the count sits next to the total, visible, and only when there is
 * something to say — an account that never drives a terminal sees nothing.
 *
 * It states a COUNT and refuses to state a cost. There is no honest dollar figure to put here:
 * inventing one from a token estimate, or scraping it out of pane output, would replace a known
 * gap with a confident wrong number, which is the failure this whole thing exists to undo.
 */
function UnmeteredNotice({ unmetered }: { unmetered?: Unmetered }) {
	if (!unmetered || unmetered.drives <= 0) return null;
	const { drives, aiCliDrives, windowDays } = unmetered;
	return (
		<div className="mb-4 flex gap-2 items-start bg-panel border border-line rounded-xl px-3 py-2.5 text-sm">
			<AlertTriangle size={15} className="text-accent shrink-0 mt-0.5" />
			<div>
				<b>This total is incomplete.</b>{" "}
				{drives.toLocaleString()} {drives === 1 ? "drive" : "drives"} through a terminal
				{aiCliDrives > 0 && <> ({aiCliDrives} with an AI coding CLI running)</>} in the last {windowDays} days
				could not be measured — a pane returns rendered text, not the CLI’s usage record.
				<div className="text-xs text-muted-soft mt-0.5">
					Their real cost is unknown, not zero. No estimate is shown because there is nothing honest to estimate from.
				</div>
			</div>
		</div>
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
