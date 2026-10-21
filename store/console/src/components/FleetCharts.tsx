import { useEffect, useRef, useState } from "react";
import { CHARTS, type ChartOpts, type ChartSpec, chartGeometry, type FleetMachine, type FleetTier, seriesColor, TIER_GAP_MS, TIER_WINDOW_MS, tooltipAt } from "../lib/fleetTelemetry";
import Card from "./Card";

/**
 * The fleet's charts (#1259) — a DUMB renderer over `chartGeometry` (lib/fleetTelemetry.ts), which decides every coordinate, gap,
 * label position and tooltip row. Hand-drawn SVG like the Stats cards; no chart library.
 *
 * Theme: nothing here writes a colour. Lines use `--color-series-N`, furniture uses the same tokens as the rest of the console, so a
 * theme restyles the charts by overriding variables. Phone: the SVG is laid out at the container's real width (not scaled down), the
 * end labels get a narrower gutter, and the charts stack in one column.
 */

/** The width of an element, following it as it resizes. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
	const ref = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(640);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const read = () => setWidth(Math.max(240, Math.round(el.getBoundingClientRect().width)));
		read();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(read);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return [ref, width];
}

function Chart({ spec, machines, tier, nowMs, width }: { spec: ChartSpec; machines: readonly FleetMachine[]; tier: FleetTier; nowMs: number; width: number }) {
	const narrow = width < 480;
	const height = narrow ? 170 : 200;
	const opts: ChartOpts = { width, height, nowMs, windowMs: TIER_WINDOW_MS[tier], gapMs: TIER_GAP_MS[tier], labelWidth: narrow ? 92 : 128, padL: narrow ? 32 : 40 };
	const geom = chartGeometry(spec, machines, opts);
	const [hoverX, setHoverX] = useState<number | null>(null);
	const tip = hoverX === null ? null : tooltipAt(geom, hoverX, opts, spec);
	const summary = geom.empty ? `${spec.title}: no readings` : `${spec.title}: ${geom.labels.map((l) => l.text).join("; ")}`;

	return (
		<Card className="min-w-0">
			<h3 className="text-sm font-bold">{spec.title}</h3>
			{geom.empty ? (
				<p className="text-2xs text-muted-soft py-6">{spec.note?.startsWith("Linux") ? spec.note : "No machine is reporting this yet."}</p>
			) : (
				<div className="relative">
					<svg
						width={width}
						height={height}
						viewBox={`0 0 ${width} ${height}`}
						role="img"
						aria-label={summary}
						className="block max-w-full"
						onPointerMove={(e) => setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left)}
						onPointerLeave={() => setHoverX(null)}
					>
						{geom.yTicks.map((t) => (
							<g key={`y${t.y}`}>
								<line x1={geom.plot.x0} x2={geom.plot.x1} y1={t.y} y2={t.y} stroke="var(--color-line)" strokeWidth={1} />
								<text x={geom.plot.x0 - 4} y={t.y + 3} textAnchor="end" className="text-2xs" fill="var(--color-muted-soft)">
									{t.label}
								</text>
							</g>
						))}
						{geom.xTicks.map((t) => (
							<text key={`x${t.x}`} x={t.x} y={height - 4} textAnchor="middle" className="text-2xs" fill="var(--color-muted-soft)">
								{t.label}
							</text>
						))}
						{geom.threshold && (
							<g>
								<line x1={geom.plot.x0} x2={geom.plot.x1} y1={geom.threshold.y} y2={geom.threshold.y} stroke="var(--color-warning)" strokeWidth={1} strokeDasharray="4 3" />
								<text x={geom.plot.x0 + 3} y={geom.threshold.y - 3} className="text-2xs" fill="var(--color-warning)">
									{geom.threshold.label}
								</text>
							</g>
						)}
						{geom.series.map((s) => (
							<g key={s.key} opacity={s.stale ? 0.55 : 1}>
								{s.limitY !== null && <line x1={geom.plot.x0} x2={geom.plot.x1} y1={s.limitY} y2={s.limitY} stroke={seriesColor(s.colorIndex)} strokeWidth={1} strokeDasharray="2 3" opacity={0.6} />}
								{s.runs.map((run) => (
									<polyline key={run} points={run} fill="none" stroke={seriesColor(s.colorIndex)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
								))}
								{s.dots.map((d) => (
									<circle key={d.atMs} cx={d.x} cy={d.y} r={2.5} fill={seriesColor(s.colorIndex)} />
								))}
								{/* A silent machine's line ends here: a hollow ring and a short vertical tick, not a line carried on to "now". */}
								{s.staleAtX !== null && s.last && (
									<g>
										<circle cx={s.last.x} cy={s.last.y} r={4} fill="none" stroke={seriesColor(s.colorIndex)} strokeWidth={1.5} />
										<line x1={s.last.x} x2={s.last.x} y1={geom.plot.y0} y2={geom.plot.y1} stroke={seriesColor(s.colorIndex)} strokeWidth={1} strokeDasharray="1 3" opacity={0.5} />
									</g>
								)}
							</g>
						))}
						{geom.labels.map((l) => (
							<text key={l.key} x={l.x} y={l.y + 3} className="text-2xs" fill={seriesColor(l.colorIndex)} opacity={l.stale ? 0.7 : 1}>
								{l.text}
							</text>
						))}
						{hoverX !== null && hoverX >= geom.plot.x0 && hoverX <= geom.plot.x1 && <line x1={hoverX} x2={hoverX} y1={geom.plot.y0} y2={geom.plot.y1} stroke="var(--color-line-strong)" strokeWidth={1} />}
					</svg>
					{tip && (
						<div
							className="pointer-events-none absolute top-1 z-10 rounded-md border border-line bg-panel px-2 py-1 text-2xs shadow"
							style={{ left: Math.min(Math.max(0, (hoverX ?? 0) + 10), Math.max(0, width - 170)) }}
						>
							<div className="text-muted-soft">{new Date(tip.atMs).toLocaleTimeString()}</div>
							{tip.rows.map((r) => (
								<div key={r.key} className="flex gap-2 justify-between">
									<span style={{ color: seriesColor(r.colorIndex) }}>{r.name}</span>
									<span className="text-ink">{r.text}</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}
			{spec.note && !geom.empty && <p className="text-2xs text-muted-soft leading-snug mt-1">{spec.note}</p>}
		</Card>
	);
}

/** Every chart, each with all machines as series — or, on a machine's own page, just that machine. */
export default function FleetCharts({ machines, tier, nowMs, charts = CHARTS }: { machines: readonly FleetMachine[]; tier: FleetTier; nowMs: number; charts?: readonly ChartSpec[] }) {
	const [ref, width] = useWidth();
	// Two columns on a wide page; each chart takes half the container, one chart per row on a phone.
	const cols = width >= 900 ? 2 : 1;
	const chartWidth = cols === 2 ? Math.floor((width - 16) / 2) - 32 : width - 32;
	return (
		<div ref={ref} className={`grid gap-4 ${cols === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
			{charts.map((spec) => (
				<Chart key={spec.id} spec={spec} machines={machines} tier={tier} nowMs={nowMs} width={Math.max(240, chartWidth)} />
			))}
		</div>
	);
}
