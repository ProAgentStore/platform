import { useState, useCallback } from "react";
import { api } from "@proagentstore/sdk/client";
import { usePolling } from "@proagentstore/sdk/hooks";
import { BarChart3, RefreshCw } from "lucide-react";

interface Bucket { key: string; label?: string; inputTokens: number; outputTokens: number; costMicros: number; calls: number }
interface Day { date: string; inputTokens: number; outputTokens: number; costMicros: number; calls: number }
interface UsageData {
	range: string;
	totals: { inputTokens: number; outputTokens: number; costMicros: number; calls: number };
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
	chat: "Chat", apply: "Job apply", coding: "Coding", copilot: "Co-pilot",
	overseer: "Overseer", run: "Direct run", resume: "Résumé parse", translate: "Translation", voice: "Voice",
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

	usePolling(load, 30000, true);

	const totals = data?.totals;
	const empty = !!data && totals && totals.calls === 0;

	return (
		<div className="max-w-[1040px] mx-auto px-3 py-3 sm:px-6 sm:py-5">
			<div className="flex justify-between items-center mb-1">
				<div className="flex items-center gap-2.5">
					<BarChart3 size={20} className="text-accent" />
					<h1 className="font-display text-xl font-bold">Usage</h1>
				</div>
				<button type="button" onClick={load} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-semibold hover:border-accent hover:text-accent">
					<RefreshCw size={13} /> Refresh
				</button>
			</div>
			<p className="text-sm text-muted mb-3">
				Token usage and <b>estimated</b> cost across all your agents. Cost is estimated from list prices on your own key (BYOK) — not a bill. History starts when tracking was enabled.
			</p>

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
						<Stat label="AI calls" value={totals.calls.toLocaleString()} />
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
						</div>
					</div>
				</>
			) : (
				<p className="text-center py-8 text-muted text-sm">Couldn’t load usage.</p>
			)}
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
