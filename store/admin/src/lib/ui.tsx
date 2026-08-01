import type { ReactNode } from "react";

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
