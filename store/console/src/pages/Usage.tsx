import { useState, useCallback, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import Page from "../components/Page";
import Button from "../components/Button";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { AlertTriangle, BarChart3, Info, RefreshCw, Shield } from "lucide-react";
import Card from "../components/Card";
import { CHARGED_COVERAGE_NOTE, CHARGED_LEGEND, chargedCell, chargedCoverageNote, dayTokens, hasChargedFigures, showsInstanceBreakdown, tokenSplitLabel, unknownPayerRemedy } from "../lib/usageFigures";
/**
 * The response shape, imported from the module that PRODUCES it (#608).
 *
 * This page used to declare its own — a "Bucket", a "Day", an "Unmetered" and a "UsageData" whose
 * `totals` marked `cacheReadTokens`/`cacheWriteTokens` optional. The API had returned them on
 * every response since #547 and `UsageSummary["totals"]` did not declare them at all, so the page
 * was reading real fields through a guess, and the compiler could not tell either side. The
 * parallel declaration was the tell, not the workaround.
 *
 * A deep relative path rather than a package import because `@proagentstore/sdk` is published and
 * the API Worker deliberately does not depend on it (`lib/normalize-speech.ts` records why). This
 * is `import type` — esbuild erases it, so it adds no bundle byte and no runtime edge; the only
 * thing that crosses is the contract, in the one direction that cannot make the Worker's deploy
 * depend on the console's.
 */
import type { UnmeteredUsageSummary, UsageBucket, UsageDay, UsageResponse } from "../../../../workers/api/src/lib/usage-shape";

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

/**
 * A dead-simple, dependency-free SVG bar chart (one bar per day). Value is chosen by `metric`.
 *
 * The token metric counts all four columns — the same quantity the daily circuit breaker counts
 * (#547). It counted `input + output` while the ceiling counted cache too, and cache is 98% of
 * that on an account with a coding engine: the day a 250M-token ceiling tripped at 268M drew as a
 * 4.2M bar. A chart that cannot show the quantity being enforced cannot be used to calibrate it.
 */
function DailyChart({ daily, metric }: { daily: UsageDay[]; metric: "cost" | "tokens" }) {
	const vals = daily.map((d) => (metric === "cost" ? d.costMicros : dayTokens(d)));
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
								{/* The composition, not just the magnitude: "4.2M I/O + 850M cache". A reader
								    comparing one number to a ceiling has to be able to see what it is made of. */}
								<title>{`${d.date}: ${metric === "cost" ? usd(d.costMicros) : tokenSplitLabel(d, tok)} · ${d.calls} calls`}</title>
							</rect>
						</g>
					);
				})}
			</svg>
			{daily.length > 0 && (
				<div className="flex justify-between text-2xs text-muted-soft px-1">
					<span>{daily[0].date.slice(5)}</span>
					<span>{daily[daily.length - 1].date.slice(5)}</span>
				</div>
			)}
		</div>
	);
}

/**
 * Token display for a breakdown row.
 *
 * For rows with cache tokens (always present on engine rows; sometimes on chat/apply)
 * we show the TOTAL that the cost figure was computed on — input + output + cache read
 * + cache write — because dividing cost by only input+output gives a nonsense per-token
 * rate (the "40x list price" symptom in #479). A small "+cache" badge makes the column
 * header honest: the reader can see the number includes more than plain I/O.
 */
function TokenCell({ r }: { r: UsageBucket }) {
	const cache = (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
	const total = r.inputTokens + r.outputTokens + cache;
	if (cache === 0) {
		return <span className="w-16 sm:w-20 text-right shrink-0 tabular-nums text-muted-soft text-xs">{tok(total)}</span>;
	}
	return (
		<span className="w-16 sm:w-20 text-right shrink-0 text-xs flex flex-col items-end leading-tight">
			<span className="tabular-nums text-muted-soft">{tok(total)}</span>
			<span className="text-2xs text-muted-soft/60">+cache</span>
		</span>
	);
}

/**
 * A row's money, as TWO figures (#543).
 *
 * The top line is notional value; the line under it is the part of that value someone is actually
 * charged. Stacked rather than given its own column because the row already carries four fixed
 * slots at 320px and a fifth does not fit — and because the two belong together: the reader's
 * question is the ratio between them.
 *
 * The charged line is dimmed at zero and absent when the API did not report it, which is the
 * difference between "none of this was charged" and "we do not know" — the states that read
 * identically before, and the reason a $9,566.69 row sat beside a $36.35 headline unexplained.
 */
function CostCell({ r }: { r: UsageBucket }) {
	const charged = chargedCell(r);
	return (
		<span className="w-14 sm:w-20 text-right shrink-0 text-xs flex flex-col items-end leading-tight">
			<span className="tabular-nums text-muted">{usd(r.costMicros)}</span>
			{charged.kind === "charged" && <span className="text-2xs tabular-nums text-accent">{usd(charged.micros)}</span>}
			{charged.kind === "none" && <span className="text-2xs tabular-nums text-muted-soft/70">$0.00</span>}
		</span>
	);
}

/**
 * Horizontal breakdown bars, biggest first, sized by cost (falls back to tokens when all-free).
 *
 * The three fixed column widths (`w-24`/`w-14`/`w-16`, widening at `sm:`) are written out at each
 * call site rather than shared through a constant, on purpose: `truncation.test.ts` reads these
 * class strings as SOURCE TEXT to prove a `truncate shrink-0` element is bounded, and an
 * interpolated constant hides the width from it. They are narrower below `sm:` than they were
 * because at 320px the row did not fit — 112 + 64 + 80 of fixed width plus three 8px gaps is 280
 * inside a 272px card, and the bar between them is `min-w-0` so it absorbed nothing; the four
 * cards escaped their grid by 10px. That was already true before this page grew a second money
 * figure. It had never been measured: `/v1/usage` was not mocked, so the route was not in the
 * mobile sweep. Both are, now (#543).
 */
function Breakdown({ rows, labelOf }: { rows: UsageBucket[]; labelOf: (b: UsageBucket) => string }) {
	// Sized by NOTIONAL, on purpose. Sizing by charged would render the agent that did 99% of the
	// account's work as a 2%-wide stub, which is a worse lie than the one being fixed. Two
	// numbers, one bar.
	const useCost = rows.some((r) => r.costMicros > 0);
	const val = (r: UsageBucket) => (useCost ? r.costMicros : r.inputTokens + r.outputTokens);
	const max = Math.max(1, ...rows.map(val));
	const twoFigures = hasChargedFigures(rows);
	if (rows.length === 0) return <p className="text-sm text-muted-soft py-2">No usage yet.</p>;
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 sm:gap-2 text-2xs uppercase tracking-wide text-muted-soft">
				<span className="w-24 sm:w-36 shrink-0" />
				<span className="flex-1 min-w-0" />
				{/* Stacked to mirror the cell under it, so each word sits directly above the number
				    it names — and because "Value / charged" on one line does not fit the money
				    column on a 320px phone. */}
				<span className="w-14 sm:w-20 text-right shrink-0 flex flex-col items-end leading-tight" data-testid="usage-cost-header">
					<span>Value</span>
					{twoFigures && <span className="text-accent/70">charged</span>}
				</span>
				<span className="w-16 sm:w-20 text-right shrink-0">Tokens</span>
			</div>
			{rows.map((r) => (
				<div key={r.key} className="flex items-center gap-1.5 sm:gap-2 text-sm">
					<span className="w-24 sm:w-36 truncate shrink-0" title={labelOf(r)}>{labelOf(r)}</span>
					<div className="flex-1 h-4 bg-line/40 rounded overflow-hidden min-w-0">
						<div className="h-full bg-accent/70 rounded" style={{ width: `${Math.max(2, (val(r) / max) * 100)}%` }} />
					</div>
					<CostCell r={r} />
					<TokenCell r={r} />
				</div>
			))}
		</div>
	);
}

export default function Usage() {
	const [range, setRange] = useState<string>("30d");
	const [data, setData] = useState<UsageResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [metric, setMetric] = useState<"cost" | "tokens">("cost");

	const load = useCallback(async () => {
		try {
			const d = await api<UsageResponse>(`/v1/usage?range=${encodeURIComponent(range)}`);
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
				<Button onClick={load}>
					<RefreshCw size={13} /> Refresh
				</Button>
			</div>
			<p className="text-sm text-muted mb-2">
				Token usage across all your agents. Every dollar figure here is <b>estimated from published list
				prices</b> — ours for platform calls, Claude Code’s own arithmetic for coding-engine rows. Neither is a
				bill. What differs between rows is <b>who pays</b>. History starts when tracking was enabled.
			</p>
			<Scope unmetered={unmetered} />

			{/* Budget enforcement is intentionally OFF (observe-only) until paid launch — see #485.
			    Visible on purpose so we get reminded it can be switched back on. */}
			<div className="flex items-start gap-2 text-xs text-muted bg-panel border border-line rounded-lg px-3 py-2 mb-4">
				<Info size={14} className="text-accent shrink-0 mt-0.5" />
				<span>
					<b>Budget limits are off (observe-only).</b> Usage is metered here but never blocks a run — the daily
					spend/token circuit breakers are switched off until paid launch. Structural caps (loop, delegation depth)
					still apply.
				</span>
			</div>

			{/* Range selector */}
			<div className="flex gap-1 mb-4">
				{RANGES.map((r) => (
					<button key={r.id} type="button" onClick={() => setRange(r.id)}
						className={`text-xs px-3 py-1.5 rounded-lg border font-semibold transition-colors ${range === r.id ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-ink"}`}>
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
						{/* Total tokens: include cache when present so the headline matches what cost
						    was computed on. Engine rows include cache read/write in their cost_micros
						    (#479), so showing only I/O here made "tokens" and "cost" irreconcilable. */}
						<Stat label="Total tokens" value={tok(totals.inputTokens + totals.outputTokens + (totals.cacheReadTokens || 0) + (totals.cacheWriteTokens || 0))} />
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
							<>{totals.calls.toLocaleString()} AI calls · token total includes {tok(totals.cacheReadTokens || 0)} cache-read + {tok(totals.cacheWriteTokens || 0)} cache-write (counted separately because cache reads cost a tenth of a fresh input token). </>
						)}
						{/* The two figures are never added together, and this line is where that is
						    said. Total list value is the answer to "what would this have cost on the
						    API?" — a genuinely useful number, and not one anybody owes. */}
						{totals.chargedCostMicros !== undefined && totals.chargedCostMicros !== totals.costMicros && (
							<>{usd(totals.costMicros)} of list-price value in total (<b>value</b> = notional list price of all AI; <b>charged</b> = real payer money), of which {usd(totals.chargedCostMicros)} is charged to someone.{" "}
								{/* The counts when the API can supply them (#544), the prose hedge when it cannot.
								    "A longer range understates it" was the truthful minimum while the page could
								    not compute the gap; it can now, and $36.42 of value across 2,351 calls is a
								    different sentence from "understates". */}
								<span data-testid="usage-coverage-note">{chargedCoverageNote(data.payerCoverage, usd) ?? CHARGED_COVERAGE_NOTE}</span>
							</>
						)}
					</div>

					{/* Daily chart */}
					<Card className="mb-4">
						<div className="flex justify-between items-center mb-2">
							<h3 className="text-sm font-bold">Over time</h3>
							<div className="flex gap-1">
								{(["cost", "tokens"] as const).map((m) => (
									<button key={m} type="button" onClick={() => setMetric(m)}
										className={`text-2xs px-2 py-1 rounded border font-semibold capitalize ${metric === m ? "border-accent text-accent" : "border-line text-muted-soft"}`}>{m}</button>
								))}
							</div>
						</div>
						<DailyChart daily={data.daily} metric={metric} />
					</Card>

					{/* Breakdowns */}
					{/* The legend for the second figure every breakdown below now carries (#543).
					    Stated once, above all four cards, because it is one rule and repeating it
					    per card would make it noise the reader learns to skip — and it is the
					    sentence that stops "$0.00 charged" beside a five-figure value being read
					    as "this agent was free". */}
					{hasChargedFigures(data.byAgent) && (
						<p className="text-xs text-muted-soft mb-3" data-testid="usage-charged-legend">{CHARGED_LEGEND}</p>
					)}
					<div className="grid md:grid-cols-2 gap-4">
						{/* Who pays (#346) — first, and full width, because it is the axis that decides
						    how to read every other card on this page. Without it the reader has one
						    undifferentiated total and no way to tell which part of it is money. */}
						{!!data.byPayer?.length && (
							<Card className="md:col-span-2">
								<h3 className="text-sm font-bold mb-2">Who pays</h3>
								<Breakdown rows={data.byPayer} labelOf={(b) => b.label || b.key} />
								<ul className="mt-3 pt-3 border-t border-line space-y-1 text-xs text-muted-soft">
									{data.byPayer.map((b) => PAYER_NOTE[b.key] && (
										<li key={b.key}><b>{b.label || b.key}</b> — {PAYER_NOTE[b.key]}</li>
									))}
								</ul>
								{/* The note above says why the bucket is unknown. This says what to do about
								    it (#551) — the platform can make it knowable, it takes one stored token,
								    and no surface said so while 99.6% of this account's value sat in that
								    bucket. Rendered only for an account that HAS the gap, and given the
								    accent border the payer notes do not have, because it is an action rather
								    than a caveat. */}
								{unknownPayerRemedy(data.byPayer, usd) && (
									<p className="mt-3 pt-3 border-t border-line text-xs text-muted" data-testid="usage-unknown-remedy">
										<b className="text-ink">Make this attributable.</b>{" "}
										{unknownPayerRemedy(data.byPayer, usd)}{" "}
										<Link to="/profile" className="text-accent font-semibold underline underline-offset-2">Go to Profile → API Keys</Link>.
									</p>
								)}
							</Card>
						)}
						{/* Per instance (#526) — full width and directly under "Who pays", because it is
						    the axis the owner's actual question is asked on. "By agent" answers what a
						    TEMPLATE cost across every copy of it; seven Repo Coders on seven
						    repositories are one row there and seven here, under the names he gave
						    them. Rendered only when there is more than one instance to compare, since
						    with one the two cards are the same rows twice. */}
						{showsInstanceBreakdown(data.byInstance) && (
							<Card className="md:col-span-2">
								<h3 className="text-sm font-bold mb-2">By agent instance</h3>
								<Breakdown rows={data.byInstance ?? []} labelOf={(b) => b.label || b.key} />
								<p className="text-xs text-muted-soft mt-3 pt-3 border-t border-line">
									Your own copies of an agent, named as you named them. <b>By agent</b> below groups every copy of
									the same template together — so a row here is what one workspace cost, and a row there is what
									the template cost across all of them.
								</p>
							</Card>
						)}
						<Card>
							<h3 className="text-sm font-bold mb-2">By agent</h3>
							<Breakdown rows={data.byAgent} labelOf={(b) => b.label || b.key} />
						</Card>
						<Card>
							<h3 className="text-sm font-bold mb-2">By model</h3>
							<Breakdown rows={data.byModel} labelOf={(b) => b.key} />
						</Card>
						<Card className="md:col-span-2">
							<h3 className="text-sm font-bold mb-2">By activity</h3>
							<Breakdown rows={data.byKind} labelOf={(b) => KIND_LABEL[b.key] || b.key} />
							{/* Two rows here read as the same thing and differ by an order of magnitude.
							    Naming them apart in the legend is not enough — the reason has to be at
							    the point of comparison, or "Coding (Pilot)" looks like the cost of
							    coding. The fuller caveat lives in <Scope />; this is the one line that
							    stops the two rows being misread as duplicates.
							    The costing-method note (#479): engine cost is CLI-reported and INCLUDES
							    cache read/write tokens, so the per-token rate looks high when "Tokens"
							    only showed I/O. The token column now shows total (I/O + cache) for rows
							    that have cache data, with a "+cache" badge. The note below makes the
							    two costing methods legible side by side. */}
							{hasCodingUsage && (
								<p className="text-xs text-muted-soft mt-3 pt-3 border-t border-line">
									<b>Coding (Pilot)</b> is the cloud deciding what to tell the engine to do. <b>Coding engine</b> is the CLI
									doing it — cost is <b>CLI-reported (includes cache read/write tokens)</b>, which is why its token
									count shows "+cache". All other rows are <b>list-price estimated</b> from the tokens the platform
									counted. Both are estimates; neither is a bill.
									{" "}Codex and Grok report nothing, so they appear here only via the Pilot.
								</p>
							)}
						</Card>
					</div>
				</>
			) : (
				<p className="text-center py-8 text-muted text-sm">Couldn’t load usage.</p>
			)}

			{/* Budget limits — always shown below the usage data regardless of range / empty state */}
			<BudgetPanel />
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
function Scope({ unmetered }: { unmetered?: UnmeteredUsageSummary }) {
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
function UnmeteredNotice({ unmetered }: { unmetered?: UnmeteredUsageSummary }) {
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
			<div className="text-2xs uppercase tracking-wide text-muted-soft">{label}</div>
			<div className={`text-lg font-bold tabular-nums ${accent ? "text-accent" : ""}`}>{value}</div>
		</div>
	);
}

// ── Budget limits panel ─────────────────────────────────────────────────────

interface BudgetData {
	stored: {
		chargedMicrosCeiling: number | null;
		tokenCeiling: number | null;
		perTreeCostMicros: number | null;
		perTreeDelegations: number | null;
		perTreeMaxDepth: number | null;
		loopMaxIterations: number | null;
	};
	effective: {
		chargedMicrosCeiling: number;
		chargedMicrosCeilingTier: "account" | "platform" | "env" | "default";
		tokenCeiling: number;
		tokenCeilingTier: "account" | "platform" | "env" | "default";
		perTreeCostMicros: number;
		perTreeCostMicrosTier: "account" | "platform" | "env" | "default";
		perTreeDelegations: number;
		perTreeDelegationsTier: "account" | "platform" | "env" | "default";
		perTreeMaxDepth: number;
		perTreeMaxDepthTier: "account" | "platform" | "env" | "default";
		loopMaxIterations: number;
		loopMaxIterationsTier: "account" | "platform" | "env" | "default";
	};
	consumption: { chargedMicros: number; tokens: number };
	remaining: { chargedMicros: number; tokens: number };
	maxOverride: {
		chargedMicrosCeiling: number;
		tokenCeiling: number;
		perTreeCostMicros: number;
		perTreeDelegations: number;
		perTreeMaxDepth: number;
		loopMaxIterations: number;
	};
	/** Whether the daily circuit breakers are currently enforced. False = observe-only (BUDGET_ENFORCE off). */
	enforced: boolean;
}

const TIER_LABEL: Record<string, string> = {
	account: "Your override",
	platform: "Platform default",
	env: "Server config",
	default: "Built-in default",
};

/** Gauge bar showing current consumption as a fraction of the ceiling. */
function CeilingGauge({ consumed, ceiling }: { consumed: number; ceiling: number }) {
	const pct = ceiling > 0 ? Math.min(100, (consumed / ceiling) * 100) : 0;
	const warn = pct >= 80;
	const tripped = pct >= 100;
	// Use design-system semantic tokens: danger (≥100%), warning (≥80%), accent otherwise.
	const barClass = tripped ? "bg-danger" : warn ? "bg-warning" : "bg-accent/70";
	return (
		<div className="h-2 bg-line/40 rounded-full overflow-hidden mt-1">
			<div
				className={`h-full rounded-full transition-all ${barClass}`}
				style={{ width: `${Math.max(pct > 0 ? 1 : 0, pct)}%` }}
			/>
		</div>
	);
}

/**
 * Budget limits card — shows the 24h circuit-breaker ceilings + per-tree run knobs alongside
 * current rolling consumption, and lets the user raise or lower their own overrides.
 *
 * Null stored override = inheriting from the platform/env/default tier; the field
 * shows the effective value with a "(inherited)" label.
 */
function BudgetPanel() {
	const [data, setData] = useState<BudgetData | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const chargedRef = useRef<HTMLInputElement>(null);

	// Edit state — empty string = clear override (inherit)
	const [editCharged, setEditCharged] = useState<string>("");
	const [editTokens, setEditTokens] = useState<string>("");
	const [editPerTreeCost, setEditPerTreeCost] = useState<string>("");
	const [editPerTreeDelegations, setEditPerTreeDelegations] = useState<string>("");
	const [editPerTreeDepth, setEditPerTreeDepth] = useState<string>("");
	const [editLoopMaxIter, setEditLoopMaxIter] = useState<string>("");

	const loadData = useCallback(async () => {
		try {
			const d = await api<BudgetData>("/v1/budget/limits");
			setData(d);
			setEditCharged(d.stored.chargedMicrosCeiling !== null ? String(d.stored.chargedMicrosCeiling / 1_000_000) : "");
			setEditTokens(d.stored.tokenCeiling !== null ? String(d.stored.tokenCeiling / 1_000_000) : "");
			setEditPerTreeCost(d.stored.perTreeCostMicros !== null ? String(d.stored.perTreeCostMicros / 1_000_000) : "");
			setEditPerTreeDelegations(d.stored.perTreeDelegations !== null ? String(d.stored.perTreeDelegations) : "");
			setEditPerTreeDepth(d.stored.perTreeMaxDepth !== null ? String(d.stored.perTreeMaxDepth) : "");
			setEditLoopMaxIter(d.stored.loopMaxIterations !== null ? String(d.stored.loopMaxIterations) : "");
		} catch {
			// Keep last good data.
		}
		setLoading(false);
	}, []);

	useEffect(() => { void loadData(); }, [loadData]);

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const parseUsd = (s: string) => s.trim() === "" ? null : Math.round(parseFloat(s.trim()) * 1_000_000);
			const parseTokM = (s: string) => s.trim() === "" ? null : Math.round(parseFloat(s.trim()) * 1_000_000);
			const parseInt_ = (s: string) => s.trim() === "" ? null : Math.floor(parseFloat(s.trim()));

			const body = {
				chargedMicrosCeiling: parseUsd(editCharged),
				tokenCeiling: parseTokM(editTokens),
				perTreeCostMicros: parseUsd(editPerTreeCost),
				perTreeDelegations: parseInt_(editPerTreeDelegations),
				perTreeMaxDepth: parseInt_(editPerTreeDepth),
				loopMaxIterations: parseInt_(editLoopMaxIter),
			};

			// Client-side validation — reject NaN or negative inputs before a round trip.
			for (const [k, v] of Object.entries(body)) {
				if (v !== null && (Number.isNaN(v) || v < 0)) {
					setError(`Enter a positive number for ${k} or leave blank to inherit.`);
					setSaving(false);
					return;
				}
			}

			const d = await api<BudgetData>("/v1/budget/limits", { method: "PUT", body: JSON.stringify(body) });
			setData(d);
			setEditing(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to save.");
		}
		setSaving(false);
	};

	if (loading) return null;

	return (
		<Card className="mt-6">
			<div className="flex items-center gap-2 mb-3">
				<Shield size={15} className="text-accent shrink-0" />
				<h3 className="text-sm font-bold">Budget limits</h3>
			</div>
			<p className="text-xs text-muted mb-4">
				Daily circuit breakers protect against runaway account spend. Per-tree limits cap what a single
				autonomous run may do. All fields inherit from the platform default when left blank.
			</p>

			{data && !data.enforced && (
				<div className="flex items-start gap-2 text-xs text-muted bg-panel border border-line rounded-lg px-3 py-2 mb-4">
					<Info size={13} className="text-accent shrink-0 mt-0.5" />
					<span>
						<b>Observe-only — not currently enforced.</b> Daily spend and token ceilings are metered but
						never block a run. Per-run structural caps still apply.
					</span>
				</div>
			)}

			{data && (
				<>
					{/* ── Daily circuit breakers ───────────────────────────────────── */}
					<div className="text-2xs uppercase tracking-wide text-muted-soft mb-2 font-semibold">Daily circuit breakers (rolling 24h)</div>
					<div className="grid sm:grid-cols-2 gap-4 mb-4">
						<div>
							<div className="flex justify-between items-baseline mb-0.5">
								<span className="text-xs font-semibold">Charged spend</span>
								<span className="text-2xs text-muted-soft">{TIER_LABEL[data.effective.chargedMicrosCeilingTier]}</span>
							</div>
							<div className="flex justify-between items-baseline text-xs text-muted">
								<span>{usd(data.consumption.chargedMicros)} used</span>
								<span className="tabular-nums">{usd(data.effective.chargedMicrosCeiling)} ceiling</span>
							</div>
							<CeilingGauge consumed={data.consumption.chargedMicros} ceiling={data.effective.chargedMicrosCeiling} />
							<div className="text-2xs text-muted-soft mt-1">{usd(data.remaining.chargedMicros)} remaining</div>
						</div>
						<div>
							<div className="flex justify-between items-baseline mb-0.5">
								<span className="text-xs font-semibold">Tokens</span>
								<span className="text-2xs text-muted-soft">{TIER_LABEL[data.effective.tokenCeilingTier]}</span>
							</div>
							<div className="flex justify-between items-baseline text-xs text-muted">
								<span>{tok(data.consumption.tokens)} used</span>
								<span className="tabular-nums">{tok(data.effective.tokenCeiling)} ceiling</span>
							</div>
							<CeilingGauge consumed={data.consumption.tokens} ceiling={data.effective.tokenCeiling} />
							<div className="text-2xs text-muted-soft mt-1">{tok(data.remaining.tokens)} remaining</div>
						</div>
					</div>

					{/* ── Per-tree run knobs ───────────────────────────────────────── */}
					<div className="text-2xs uppercase tracking-wide text-muted-soft mb-2 font-semibold">Per-run limits (single delegation tree)</div>
					<div className="grid sm:grid-cols-2 gap-4 mb-4">
						<RunKnob
							label="Spend budget"
							value={usd(data.effective.perTreeCostMicros)}
							tier={data.effective.perTreeCostMicrosTier}
							note="Max a single tree may spend in AI calls."
						/>
						<RunKnob
							label="Delegations"
							value={String(data.effective.perTreeDelegations)}
							tier={data.effective.perTreeDelegationsTier}
							note="Max sub-tasks a tree may hand off to child agents."
						/>
						<RunKnob
							label="Max depth"
							value={String(data.effective.perTreeMaxDepth)}
							tier={data.effective.perTreeMaxDepthTier}
							note="How many supervisor hops deep a chain may go."
						/>
						<RunKnob
							label="Loop max iterations"
							value={String(data.effective.loopMaxIterations)}
							tier={data.effective.loopMaxIterationsTier}
							note="Max turns an autonomous Loop may run before stopping."
						/>
					</div>
				</>
			)}

			{!editing ? (
				<Button
					variant="secondary"
					size="md"
					onClick={() => { setEditing(true); setTimeout(() => chargedRef.current?.focus(), 50); }}
				>
					Adjust my limits
				</Button>
			) : (
				<div className="border-t border-line pt-4 mt-2">
					<p className="text-xs text-muted mb-3">
						Leave any field blank to inherit from the platform default. All values are clamped to the
						platform maximum on save.
					</p>

					<div className="text-2xs uppercase tracking-wide text-muted-soft mb-2 font-semibold">Daily circuit breakers</div>
					<div className="grid sm:grid-cols-2 gap-3 mb-4">
						<div>
							<label className="text-xs font-semibold block mb-1" htmlFor="budget-charged">
								Charged spend ceiling (USD / 24h)
							</label>
							<input
								ref={chargedRef}
								id="budget-charged"
								type="number"
								min={0}
								step={1}
								placeholder={data ? `${(data.effective.chargedMicrosCeiling / 1_000_000).toFixed(0)} (inherited)` : ""}
								value={editCharged}
								onChange={(e) => setEditCharged(e.target.value)}
								className="w-full text-sm px-3 py-1.5 rounded-lg border border-line bg-panel focus:outline-none focus:border-accent"
							/>
						</div>
						<div>
							<label className="text-xs font-semibold block mb-1" htmlFor="budget-tokens">
								Token ceiling (millions / 24h)
							</label>
							<input
								id="budget-tokens"
								type="number"
								min={0}
								step={1}
								placeholder={data ? `${(data.effective.tokenCeiling / 1_000_000).toFixed(0)} (inherited)` : ""}
								value={editTokens}
								onChange={(e) => setEditTokens(e.target.value)}
								className="w-full text-sm px-3 py-1.5 rounded-lg border border-line bg-panel focus:outline-none focus:border-accent"
							/>
						</div>
					</div>

					<div className="text-2xs uppercase tracking-wide text-muted-soft mb-2 font-semibold">Per-run limits</div>
					<div className="grid sm:grid-cols-2 gap-3 mb-3">
						<div>
							<label className="text-xs font-semibold block mb-1" htmlFor="budget-pertree-cost">
								Spend budget per run (USD)
							</label>
							<input
								id="budget-pertree-cost"
								type="number"
								min={0}
								step={1}
								placeholder={data ? `${(data.effective.perTreeCostMicros / 1_000_000).toFixed(0)} (inherited)` : ""}
								value={editPerTreeCost}
								onChange={(e) => setEditPerTreeCost(e.target.value)}
								className="w-full text-sm px-3 py-1.5 rounded-lg border border-line bg-panel focus:outline-none focus:border-accent"
							/>
						</div>
						<div>
							<label className="text-xs font-semibold block mb-1" htmlFor="budget-pertree-delegations">
								Delegations per run
							</label>
							<input
								id="budget-pertree-delegations"
								type="number"
								min={0}
								step={1}
								placeholder={data ? String(data.effective.perTreeDelegations) + " (inherited)" : ""}
								value={editPerTreeDelegations}
								onChange={(e) => setEditPerTreeDelegations(e.target.value)}
								className="w-full text-sm px-3 py-1.5 rounded-lg border border-line bg-panel focus:outline-none focus:border-accent"
							/>
						</div>
						<div>
							<label className="text-xs font-semibold block mb-1" htmlFor="budget-pertree-depth">
								Max delegation depth
							</label>
							<input
								id="budget-pertree-depth"
								type="number"
								min={0}
								step={1}
								placeholder={data ? String(data.effective.perTreeMaxDepth) + " (inherited)" : ""}
								value={editPerTreeDepth}
								onChange={(e) => setEditPerTreeDepth(e.target.value)}
								className="w-full text-sm px-3 py-1.5 rounded-lg border border-line bg-panel focus:outline-none focus:border-accent"
							/>
						</div>
						<div>
							<label className="text-xs font-semibold block mb-1" htmlFor="budget-loop-max-iter">
								Loop max iterations
							</label>
							<input
								id="budget-loop-max-iter"
								type="number"
								min={0}
								step={1}
								placeholder={data ? String(data.effective.loopMaxIterations) + " (inherited)" : ""}
								value={editLoopMaxIter}
								onChange={(e) => setEditLoopMaxIter(e.target.value)}
								className="w-full text-sm px-3 py-1.5 rounded-lg border border-line bg-panel focus:outline-none focus:border-accent"
							/>
						</div>
					</div>

					{error && <p className="text-xs text-danger mb-2">{error}</p>}
					<div className="flex gap-2">
						<Button variant="primary" size="md" onClick={save} disabled={saving}>
							{saving ? "Saving…" : "Save"}
						</Button>
						<Button variant="secondary" size="md" onClick={() => { setEditing(false); setError(null); }}>
							Cancel
						</Button>
					</div>
				</div>
			)}
		</Card>
	);
}

/** Display a single read-only run-knob with its tier label and a note. */
function RunKnob({ label, value, tier, note }: { label: string; value: string; tier: string; note: string }) {
	return (
		<div>
			<div className="flex justify-between items-baseline mb-0.5">
				<span className="text-xs font-semibold">{label}</span>
				<span className="text-2xs text-muted-soft">{TIER_LABEL[tier] ?? tier}</span>
			</div>
			<div className="text-sm font-bold tabular-nums">{value}</div>
			<div className="text-2xs text-muted-soft mt-0.5">{note}</div>
		</div>
	);
}
