import { useState, type ReactNode } from "react";

export function Panel({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
	return (
		<div className="bg-panel border border-line rounded-xl p-4 mb-4">
			{(title || right) && (
				<div className="flex items-center justify-between mb-3">
					{title && <h2 className="font-display text-lg font-bold">{title}</h2>}
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
	return <div className="text-red text-sm py-6">{message}</div>;
}

export function Empty({ label }: { label: string }) {
	return <div className="text-muted-soft text-sm py-6">{label}</div>;
}

/** A horizontal two-segment bar: platform-paid vs BYOK share. */
export function SplitBar({ platform, byok }: { platform: number; byok: number }) {
	const total = platform + byok || 1;
	const pPct = Math.round((platform / total) * 100);
	return (
		<div>
			<div className="flex h-3 rounded-full overflow-hidden bg-line">
				<div className="bg-accent" style={{ width: `${pPct}%` }} title={`Platform-paid ${pPct}%`} />
				<div className="bg-blue" style={{ width: `${100 - pPct}%` }} title={`BYOK ${100 - pPct}%`} />
			</div>
			<div className="flex justify-between text-xs text-muted mt-1.5">
				<span><span className="text-accent">■</span> Platform-paid {pPct}%</span>
				<span><span className="text-blue">■</span> BYOK {100 - pPct}%</span>
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
				<span className="absolute -top-0.5 right-1 text-[10px] text-muted-soft">{format(max)}</span>
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
			<div className="flex justify-between text-[10px] text-muted-soft mt-1">
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
