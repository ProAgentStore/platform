import { useState, type ReactNode } from "react";
import { RUNTIME_LABELS, runtimeStatus } from "./runtime-status";

export function Panel({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
	return (
		<div className="bg-panel border border-line rounded-xl p-4 mb-4">
			{(title || right) && (
				/**
				 * `flex-wrap`, because this row set the minimum width of the whole page (#435).
				 *
				 * A non-wrapping flex row's min-content is the SUM of its items', and a Panel title
				 * is often a repo slug or an id: `ProAgentStore/platform history` beside a
				 * `2026-08-08T00:00` stamp came to 280px of min-content, so the Panel could not be
				 * narrower than 312px, so `<main>` panned 8px at 320px on /admin/github-issues.
				 * Wrapping makes the min-content the MAX of the items instead of the sum, and the
				 * stamp drops to its own line only when it has to.
				 *
				 * Worth recording because it was twice attributed elsewhere — #435 to the table (it
				 * is already in a scroller) and #414 to "a Stat card in the grid-cols-2 header".
				 * Measured: neither. The two offenders were both `Panel`, and nothing inside either
				 * of them overflowed.
				 */
				<div className="flex flex-wrap items-center justify-between gap-2 mb-3">
					{title && <h2 className="font-display text-lg font-bold break-words">{title}</h2>}
					{right}
				</div>
			)}
			{children}
		</div>
	);
}

export function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
	return (
		<div className="bg-panel border border-line rounded-xl p-4 text-center">
			<div className={`text-2xl font-bold ${accent ? "text-accent" : ""}`}>{value}</div>
			<div className="text-xs text-muted mt-1">{label}</div>
		</div>
	);
}

export function Loading({ label = "Loading…" }: { label?: string }) {
	return <div className="text-muted text-sm py-6">{label}</div>;
}

export function ErrorBox({ message }: { message: string }) {
	return <div className="text-danger text-sm py-6">{message}</div>;
}

export function Empty({ label }: { label: string }) {
	return <div className="text-muted-soft text-sm py-6">{label}</div>;
}

/**
 * Live runtime status, honestly — a pure renderer over `runtime-status.ts`.
 *
 * `connected` comes from the RelayDO (which holds the actual socket), NOT from
 * `instance_runtime_nodes.status` — that column is never cleared on an unclean
 * disconnect and reads "online" for machines that have been off for days.
 *
 * The four-state derivation and the wording both live in the pure module so they can be
 * tested (#280/#282). This function decides nothing: an operator acting on "that runner
 * is down" when it was merely unchecked is the failure being prevented, and it must not
 * be reachable by editing JSX.
 */
export function LiveDot({ connected, noRunner }: { connected: boolean | null | undefined; noRunner?: boolean }) {
	const label = RUNTIME_LABELS[runtimeStatus({ connected, nodes: noRunner ? 0 : 1 })];
	return (
		<span className={`text-xs ${label.textClass}`} title={label.title}>
			<span className={label.markClass}>{label.mark}</span> {label.text}
		</span>
	);
}

/** A horizontal two-segment bar: platform-paid vs BYOK share. */
export function SplitBar({ platform, byok }: { platform: number; byok: number }) {
	const total = platform + byok || 1;
	const pPct = Math.round((platform / total) * 100);
	return (
		<div>
			<div className="flex h-3 rounded-full overflow-hidden bg-line">
				<div className="bg-accent" style={{ width: `${pPct}%` }} title={`Platform-paid ${pPct}%`} />
				<div className="bg-info" style={{ width: `${100 - pPct}%` }} title={`BYOK ${100 - pPct}%`} />
			</div>
			<div className="flex justify-between text-xs text-muted mt-1.5">
				<span><span className="text-accent">■</span> Platform-paid {pPct}%</span>
				<span><span className="text-info">■</span> BYOK {100 - pPct}%</span>
			</div>
		</div>
	);
}

/**
 * Interactive daily bar chart with exact values: hover a bar to read its date +
 * value (+ optional secondary metric) in the caption; shows the peak by default,
 * plus total, a y-axis max label, and the first/last date on the x-axis.
 */
export function BarChart({
	points,
	format,
	height = 150,
	secondaryLabel,
	secondaryFormat,
}: {
	points: Array<{ date: string; value: number; secondary?: number }>;
	format: (n: number) => string;
	height?: number;
	secondaryLabel?: string;
	secondaryFormat?: (n: number) => string;
}) {
	const [hi, setHi] = useState<number | null>(null);
	if (!points.length) return <Empty label="No data in this window." />;
	const max = Math.max(1, ...points.map((p) => p.value));
	const total = points.reduce((s, p) => s + p.value, 0);
	const peak = points.reduce((b, p, i, a) => (p.value > a[b].value ? i : b), 0);
	const sel = points[hi ?? peak];
	const md = (d: string) => (d || "").slice(5); // MM-DD
	const secTxt = sel.secondary != null && secondaryLabel ? ` · ${(secondaryFormat ?? String)(sel.secondary)} ${secondaryLabel}` : "";
	return (
		<div>
			<div className="flex items-baseline justify-between mb-2 text-sm">
				<span><span className="text-muted">{md(sel.date)}</span> <span className="font-semibold">{format(sel.value)}</span><span className="text-muted-soft">{secTxt}</span>{hi == null ? <span className="text-muted-soft"> (peak)</span> : null}</span>
				<span className="text-xs text-muted-soft">total {format(total)}</span>
			</div>
			<div className="relative flex items-end gap-px border-l border-b border-line pl-1" style={{ height }}>
				<span className="absolute -top-0.5 right-1 text-2xs text-muted-soft">{format(max)}</span>
				{points.map((p, i) => (
					// biome-ignore lint/a11y/noStaticElementInteractions: hover-only chart-bar highlight, no click action; the same value is exposed natively via the inner bar's title attribute
					<div key={p.date} className="flex-1 flex items-end h-full min-w-0" onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}>
						<div
							className={`w-full rounded-t-sm ${i === (hi ?? peak) ? "bg-accent" : "bg-accent/55 hover:bg-accent"}`}
							style={{ height: `${Math.max(2, (p.value / max) * 100)}%` }}
							title={`${p.date}: ${format(p.value)}${secTxt}`}
						/>
					</div>
				))}
			</div>
			<div className="flex justify-between text-2xs text-muted-soft mt-1">
				<span>{md(points[0].date)}</span>
				<span>{md(points[points.length - 1].date)}</span>
			</div>
		</div>
	);
}

/** Minimal SVG sparkline/bar chart of a daily cost series (micros). */
export function TrendBars({ points }: { points: Array<{ date: string; costMicros: number }> }) {
	if (!points.length) return <Empty label="No data in this window." />;
	const max = Math.max(1, ...points.map((p) => p.costMicros));
	return (
		<div className="flex items-end gap-0.5 h-24">
			{points.map((p) => (
				<div
					key={p.date}
					className="flex-1 bg-accent/70 hover:bg-accent rounded-sm"
					style={{ height: `${Math.max(2, (p.costMicros / max) * 100)}%` }}
					title={`${p.date}: ${(p.costMicros / 1e6).toFixed(4)} USD`}
				/>
			))}
		</div>
	);
}
