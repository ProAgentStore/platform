import type { ReactNode } from "react";
import { AlertTriangle, X } from "lucide-react";
import { barPercents, sharePercent, sparklineGeometry, xForIndex } from "../lib/stats-chart";
import { dayLabel, formatValue, gapNote, isAllGaps, partialNote } from "../lib/stats-format";
import type { StatsCardKind, StatsCardValue, StatsData, StatsUnit } from "../lib/stats-types";

/**
 * One stats card (#311) — a DUMB renderer over what the API already decided.
 *
 * ## Three states, kept apart
 *
 * `error` and `data` never arrive together, so "this card failed" and "this card has nothing yet"
 * are distinguishable without the console guessing — and they are drawn differently on purpose.
 * A failed query rendered as an empty chart is how #243 and #252 became confusing: the surface
 * looked fine and the number was simply wrong.
 *
 * ## The caveat is not optional chrome
 *
 * Every source ships a sentence saying what its number does NOT count, served by
 * `GET /v1/stats/sources` and carried on the card itself. It is rendered in full, always, beside
 * the value — the Usage page's discipline ("estimated, not a bill", and what it excludes) applied
 * per card. A number shown without it is a confident figure with its uncertainty stripped off.
 *
 * ## Adding a kind
 *
 * Add an entry to KIND_RENDERERS and nothing else in the console changes — the issue's own
 * acceptance criterion. The kinds are a closed set validated server-side, so an unknown one is a
 * version skew rather than user input, and it says so rather than rendering blank.
 */

export interface StatsCardProps {
	card: StatsCardValue;
	/** The catalog's label for the card's source, e.g. "Collection size". Absent while the source
	 *  catalog is still loading — the card renders fine without it. */
	sourceLabel?: string;
	/** Remove this card from MY view. Absent in read-only contexts. */
	onRemove?: () => void;
	busy?: boolean;
}

export default function StatsCard({ card, sourceLabel, onRemove, busy }: StatsCardProps) {
	const subtitle = [sourceLabel, ...Object.entries(card.params ?? {}).filter(([k]) => k !== "limit").map(([, v]) => String(v))]
		.filter(Boolean)
		.join(" · ");

	return (
		<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 flex flex-col gap-2 min-w-0">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<h3 className="text-sm font-bold truncate" title={card.title}>
						{card.title}
					</h3>
					{subtitle && <p className="text-[0.7rem] text-muted-soft truncate">{subtitle}</p>}
				</div>
				{onRemove && (
					<button
						type="button"
						onClick={onRemove}
						disabled={busy}
						className="text-muted-soft hover:text-red shrink-0 disabled:opacity-40"
						// Removing an INHERITED card hides it rather than deleting it — a subscriber
						// cannot edit the agent every other subscriber gets. Stated here because the
						// two outcomes are indistinguishable from the button.
						title="Remove from your view (a card that came with the agent is hidden, not deleted)"
						aria-label={`Remove ${card.title}`}
					>
						<X size={14} />
					</button>
				)}
			</div>

			{card.error ? <CardError reason={card.error} /> : <CardBody card={card} />}

			{/* Shown for any card that actually renders a number. On an error card there is no figure
			    for it to qualify, and printing it there would read as a caveat about the failure. */}
			{!card.error && card.caveat && <p className="text-[0.7rem] leading-snug text-muted-soft border-t border-line pt-2">{card.caveat}</p>}
		</div>
	);
}

/** A failed card says WHAT failed. Never an empty chart — an empty chart is a claim. */
function CardError({ reason }: { reason: string }) {
	return (
		<div className="flex items-start gap-2 text-xs text-red py-2">
			<AlertTriangle size={14} className="shrink-0 mt-0.5" />
			<div className="min-w-0">
				<div className="font-semibold">Couldn’t be read</div>
				<div className="text-muted break-words">{reason}</div>
			</div>
		</div>
	);
}

function Empty({ children }: { children: ReactNode }) {
	return <p className="text-xs text-muted-soft py-3">{children}</p>;
}

function CardBody({ card }: { card: StatsCardValue }) {
	const data = card.data;
	if (!data) return <Empty>Nothing recorded in this window yet.</Empty>;
	const render = KIND_RENDERERS[card.kind];
	// A kind the server validates but this build has never seen: version skew, not user input.
	if (!render) return <Empty>This build can’t draw a “{card.kind}” card yet.</Empty>;
	return <>{render(card, data)}</>;
}

type KindRenderer = (card: StatsCardValue, data: StatsData) => ReactNode;

/** THE renderer table. A new card kind is one entry here. */
const KIND_RENDERERS: Record<StatsCardKind, KindRenderer> = {
	number: (card, data) =>
		data.type === "scalar" ? <ScalarValue value={data.value} unit={data.unit} /> : <Mismatch card={card} data={data} />,
	line: (card, data) =>
		data.type === "series" ? <TrendChart card={card} points={data.points} unit={data.unit ?? "count"} /> : <Mismatch card={card} data={data} />,
	bar: (card, data) => (data.type === "groups" ? <Groups data={data} bars /> : <Mismatch card={card} data={data} />),
	table: (card, data) => (data.type === "groups" ? <Groups data={data} /> : <Mismatch card={card} data={data} />),
};

/** The data does not fit the kind. Said out loud rather than crashing the tab or drawing nothing. */
function Mismatch({ card, data }: { card: StatsCardValue; data: StatsData }) {
	return (
		<Empty>
			This card is a “{card.kind}” but the server sent “{data.type}” data. Nothing is drawn rather than guessing.
		</Empty>
	);
}

function ScalarValue({ value, unit }: { value: number; unit: StatsUnit }) {
	return (
		<div className="py-1">
			<div className="text-2xl font-bold tabular-nums">{formatValue(value, unit)}</div>
			{/*
			  No delta against the previous window, deliberately.
			  The API has no `previous` field — `computeStats` resolves ONE window — so any delta
			  shown here would be computed from something other than the previous window's value.
			  The nearest thing available is the trend series, which may have gaps, and differencing
			  across a gap invents the very number the whole feature refuses to invent. When the
			  server grows a shifted second window, the delta belongs right here.
			*/}
		</div>
	);
}

/**
 * The trend chart — inline SVG, no charting dependency (the issue's explicit decision).
 *
 * The gap rule lives in `sparklineGeometry`, which is unit-tested; this only draws what it
 * returns. A gap gets a faint vertical tick, so a missing day is visibly a missing day rather than
 * an accident of the stroke, and the sentence underneath says which it is.
 */
function TrendChart({ card, points, unit }: { card: StatsCardValue; points: Array<{ day: string; value: number | null }>; unit: StatsUnit }) {
	const W = 320;
	const H = 64;
	const g = sparklineGeometry(points, { width: W, height: H, padY: 6 });
	const gaps = points.map((p, i) => (p.value === null ? xForIndex(i, points.length, W) : null)).filter((x): x is number => x !== null);
	const last = g.marks[g.marks.length - 1];
	const note = gapNote(points);

	if (!points.length) return <Empty>No days in this window yet.</Empty>;
	if (isAllGaps(points)) {
		// Not a flat line on the axis. "Nothing was recorded" and "the agent recorded zero every
		// day" are different facts, and only one of them is true here.
		return <Empty>No days in this window have a recorded value — nothing ran, or the rollup has not reached them.</Empty>;
	}

	return (
		<div className="min-w-0">
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="w-full h-auto"
				role="img"
				aria-label={`${card.title}: ${g.recordedCount} days recorded, ${g.gapCount} days missing, peak ${formatValue(g.max, unit)}`}
			>
				<line x1={0} y1={g.baselineY} x2={W} y2={g.baselineY} className="stroke-line" strokeWidth={1} />
				{gaps.map((x) => (
					<line key={`gap-${x}`} x1={x} y1={4} x2={x} y2={g.baselineY} className="stroke-line-strong" strokeWidth={1} strokeDasharray="2 3" />
				))}
				{g.runs.map((pts) => (
					<polyline key={pts.slice(0, 24)} points={pts} fill="none" className="stroke-accent" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
				))}
				{g.dots.map((d) => (
					<circle key={`dot-${d.index}`} cx={d.x} cy={d.y} r={2.2} className="fill-accent" />
				))}
				{g.marks.map((m) => (
					<circle key={`m-${m.index}`} cx={m.x} cy={m.y} r={1.6} className="fill-accent" opacity={0.9}>
						<title>{`${m.day}: ${formatValue(m.value, unit)}`}</title>
					</circle>
				))}
			</svg>
			<div className="flex justify-between text-[0.65rem] text-muted-soft">
				<span>{dayLabel(points[0].day)}</span>
				{last && <span className="text-muted tabular-nums">last {formatValue(last.value, unit)}</span>}
				<span>{dayLabel(points[points.length - 1].day)}</span>
			</div>
			{note && <p className="text-[0.7rem] text-yellow/90 mt-1">{note}</p>}
		</div>
	);
}

/** `bar` and `table` over the same grouped rows: bars are the comparison, the table is the numbers. */
function Groups({ data, bars }: { data: Extract<StatsData, { type: "groups" }>; bars?: boolean }) {
	const rows = data.rows ?? [];
	if (!rows.length) return <Empty>No rows in this window yet.</Empty>;
	const widths = barPercents(rows.map((r) => r.value));
	const total = rows.reduce((sum, r) => sum + r.value, 0);
	const partial = data.partial ? partialNote(data.scanned, data.total) : null;

	return (
		<div className="min-w-0">
			<div className="flex flex-col gap-1">
				{rows.map((r, i) => (
					<div key={r.label} className="flex items-center gap-2 text-xs min-w-0">
						<span className="w-20 sm:w-28 truncate shrink-0" title={r.label}>
							{r.label}
						</span>
						{bars ? (
							<div className="flex-1 h-3 bg-line/50 rounded overflow-hidden min-w-0">
								{/* width 0 for a zero row: no sliver, because "none" is not "a little". */}
								<div className="h-full bg-accent/70 rounded" style={{ width: `${widths[i]}%` }} />
							</div>
						) : (
							<div className="flex-1 min-w-0" />
						)}
						<span className="tabular-nums text-muted shrink-0">{r.value.toLocaleString()}</span>
						{!bars && <Share value={r.value} total={total} />}
					</div>
				))}
			</div>
			{partial && <p className="text-[0.7rem] text-yellow/90 mt-2">{partial}</p>}
		</div>
	);
}

function Share({ value, total }: { value: number; total: number }) {
	const pct = sharePercent(value, total);
	// Nothing counted ⇒ no share to state. "0%" everywhere would be a proportion nobody measured.
	return <span className="w-10 text-right tabular-nums text-muted-soft shrink-0">{pct === null ? "—" : `${Math.round(pct)}%`}</span>;
}
