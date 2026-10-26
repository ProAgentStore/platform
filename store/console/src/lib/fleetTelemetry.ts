/**
 * Live fleet telemetry (#1259) — everything the page decides, as pure functions, so every rule and every coordinate is tested.
 *
 * The console has no component-testing harness on purpose (#282): the interesting part of a chart is its projection and the interesting
 * part of a status pill is its rule, so both live here and the components are dumb renderers over what they return.
 *
 * Three rules this file exists to hold, each with a test:
 *
 *   1. **A missing reading is a gap, never a zero.** A null (Windows has no load average, #1258; a runner that reports no relay time)
 *      breaks the line; so does a silence longer than the expected interval. A zero is drawn only where the machine said zero.
 *   2. **A silent machine stops where it stopped.** A machine whose newest sample is old (`stale`) ends its line at its last point and is
 *      labelled stale — the line is never extended to "now" as if it were still reporting.
 *   3. **A log axis never shows a zero.** Load and relay time span orders of magnitude, so they are log charts; a real 0 sits on the floor
 *      of the axis (and the tooltip still says 0), it is not dropped.
 */

// ── The wire shape (workers/api/src/lib/fleet-resources.ts) ──────────────────────────────────────────

export interface FleetPoint {
	at: string;
	loadPerCpu: number | null;
	memUsedPct: number;
	diskUsedPct: number | null;
	relayRttMs: number | null;
	starts24h: number | null;
	sessionCount: number | null;
}

export interface FleetLatest {
	sampledAt: string;
	cpus: number;
	loadPerCpu: number | null;
	memTotalBytes: number;
	memUsedPct: number;
	platform: string;
	activeSessions: number | null;
	recommendedMaxSessions: number;
	diskUsedPct: number | null;
	diskTotalBytes: number | null;
	relayRttMs: number | null;
	uptimeSec: number | null;
	starts24h: number | null;
	supervisor: "service" | "launcher" | "none" | null;
	gateState: string;
	warnings: string[];
}

export interface FleetSummary {
	buckets: number;
	loadAvg: number | null;
	loadPeak: number | null;
	relayP50Ms: number | null;
	restarts: number | null;
}

export interface FleetMachine {
	key: string;
	machineId: string | null;
	name: string;
	node: string;
	aka: string[];
	lastSeenAt: string | null;
	sampledAt: string | null;
	stale: boolean;
	sampleAgeSec: number | null;
	latest: FleetLatest | null;
	points: FleetPoint[];
	summary24h?: FleetSummary | null;
}

export interface FleetResponse {
	tier: "dense" | "coarse";
	from: string;
	to: string;
	now: string;
	cursor: string | null;
	truncated: boolean;
	machines: FleetMachine[];
}

export type FleetTier = FleetResponse["tier"];
export const TIER_WINDOW_MS: Record<FleetTier, number> = { dense: 2 * 3600_000, coarse: 24 * 3600_000 };
/** A heartbeat every ~30s (dense) or a 5-minute bucket (coarse); a hole of 2.5 intervals is a gap, not a slow beat. */
export const TIER_GAP_MS: Record<FleetTier, number> = { dense: 75_000, coarse: 750_000 };
/** How often the page asks for what is new — about one heartbeat. */
export const POLL_MS = 30_000;

// ── Status rules (from the prototype: disk ≥90 warn, ≥95 bad; load/core ≥1.5 warn, ≥3 bad; sessions over the recommended max) ──

export const DISK_WARN = 90;
export const DISK_BAD = 95;
export const LOAD_WARN = 1.5;
export const LOAD_BAD = 3;

export type FleetStatus = "healthy" | "disk-low" | "overloaded" | "too-many-sessions" | "offline";
export type StatusTone = "success" | "warning" | "danger" | "muted";

export interface StatusVerdict {
	status: FleetStatus;
	label: string;
	tone: StatusTone;
	/** Every rule that fired, worst first — the pill shows the first, the tooltip all of them. */
	issues: string[];
}

const LABEL: Record<FleetStatus, string> = { healthy: "healthy", "disk-low": "disk low", overloaded: "overloaded", "too-many-sessions": "too many sessions", offline: "offline" };

/**
 * One machine's status pill. `offline` means SILENT (no sample, or a stale one) — the page cannot see a socket, only a heartbeat — and it
 * outranks everything: the other numbers are then the last thing the machine said. Otherwise the worst severity wins, with load before
 * disk at equal severity (an overloaded machine drops work now; a full disk fails the next clone).
 */
export function machineStatus(m: Pick<FleetMachine, "stale" | "latest">): StatusVerdict {
	const l = m.latest;
	if (m.stale || !l) return { status: "offline", label: LABEL.offline, tone: "muted", issues: [m.latest ? "no heartbeat for over 3 minutes" : "has not reported a sample"] };
	const found: Array<{ rank: number; status: FleetStatus; issue: string }> = [];
	if (l.loadPerCpu !== null && l.loadPerCpu >= LOAD_BAD) found.push({ rank: 5, status: "overloaded", issue: `load ${l.loadPerCpu}/core (≥ ${LOAD_BAD})` });
	if (l.diskUsedPct !== null && l.diskUsedPct >= DISK_BAD) found.push({ rank: 4, status: "disk-low", issue: `disk ${l.diskUsedPct}% (≥ ${DISK_BAD})` });
	if (l.loadPerCpu !== null && l.loadPerCpu >= LOAD_WARN && l.loadPerCpu < LOAD_BAD) found.push({ rank: 3, status: "overloaded", issue: `load ${l.loadPerCpu}/core (≥ ${LOAD_WARN})` });
	if (l.diskUsedPct !== null && l.diskUsedPct >= DISK_WARN && l.diskUsedPct < DISK_BAD) found.push({ rank: 2, status: "disk-low", issue: `disk ${l.diskUsedPct}% (≥ ${DISK_WARN})` });
	if (l.activeSessions !== null && l.activeSessions > l.recommendedMaxSessions) found.push({ rank: 1, status: "too-many-sessions", issue: `${l.activeSessions} sessions against a recommended ${l.recommendedMaxSessions}` });
	found.sort((a, b) => b.rank - a.rank);
	if (!found.length) return { status: "healthy", label: LABEL.healthy, tone: "success", issues: [] };
	const top = found[0];
	return { status: top.status, label: LABEL[top.status], tone: top.rank >= 4 ? "danger" : "warning", issues: found.map((f) => f.issue) };
}

// ── Live updates ─────────────────────────────────────────────────────────────────────────────────

/**
 * Fold an incremental answer (`since=`) into what the page holds: points are de-duplicated by time (a retried poll is harmless), kept
 * oldest first, and aged out of the window. Everything else about a machine — latest reading, stale flag, name — is the newest answer's.
 * A machine that is new appears; the 24h summary (sent only on a full load) is kept. A different tier replaces the whole state.
 */
export function mergeFleet(prev: FleetResponse | null, next: FleetResponse, nowMs: number): FleetResponse {
	if (!prev || prev.tier !== next.tier) return next;
	const floor = nowMs - TIER_WINDOW_MS[next.tier];
	const before = new Map(prev.machines.map((m) => [m.key, m]));
	const machines = next.machines.map((m): FleetMachine => {
		const old = before.get(m.key);
		const byAt = new Map<string, FleetPoint>();
		for (const p of [...(old?.points ?? []), ...m.points]) byAt.set(p.at, p);
		const points = [...byAt.values()].filter((p) => Date.parse(p.at) >= floor).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
		return { ...m, points, summary24h: m.summary24h !== undefined ? m.summary24h : old?.summary24h };
	});
	return { ...next, from: prev.from, cursor: next.cursor ?? prev.cursor, machines };
}

// ── Chart definitions ────────────────────────────────────────────────────────────────────────────

export interface ChartSpec {
	id: "load" | "disk" | "relay" | "restarts" | "sessions" | "memory";
	title: string;
	unit: string;
	scale: "linear" | "log";
	/** A fixed top for a bounded quantity (a percentage); otherwise the data decides. */
	fixedMax?: number;
	/** A reference line for the whole fleet (the overload line, the disk-low line). */
	threshold?: { value: number; label: string };
	value: (p: FleetPoint) => number | null;
	/** Whether this machine belongs on the chart at all. */
	include?: (m: FleetMachine) => boolean;
	/** A per-machine limit drawn as a dashed line in that machine's colour (sessions against the recommended maximum). */
	limit?: (m: FleetMachine) => number | null;
	/** Why a machine this chart leaves out (`include` is false) is left out — said under the chart, so an omitted machine is never silent (#1380). */
	excludedWhy?: (m: FleetMachine) => string;
	/** Why a machine that reports, but never this figure, has no line (Windows has no load average). */
	nullWhy?: (m: FleetMachine) => string | null;
	/** Said under the chart when it explains what is NOT shown. */
	note?: string;
}

export const CHARTS: readonly ChartSpec[] = [
	{ id: "load", title: "Load per core", unit: "", scale: "log", threshold: { value: LOAD_WARN, label: "1.5 overload" }, value: (p) => p.loadPerCpu, nullWhy: (m) => (m.latest?.platform === "win32" ? "Windows has no load average" : null), note: "Log scale. A Windows machine has no load average and draws no line — it is not reported, not idle." },
	{ id: "disk", title: "Disk used (checkout volume)", unit: "%", scale: "linear", fixedMax: 100, threshold: { value: DISK_WARN, label: "90% low" }, value: (p) => p.diskUsedPct },
	{ id: "relay", title: "Relay round trip", unit: " ms", scale: "log", value: (p) => p.relayRttMs, note: "Log scale. Over about 1 s a machine answers its relay late." },
	{ id: "restarts", title: "Runner starts in 24 h", unit: "", scale: "linear", value: (p) => p.starts24h, note: "A rising line is a crash loop." },
	{ id: "sessions", title: "Sessions against the recommended maximum", unit: "", scale: "linear", value: (p) => p.sessionCount, limit: (m) => m.latest?.recommendedMaxSessions ?? null, note: "Dashed: each machine's recommended maximum." },
	{
		id: "memory",
		title: "Memory used",
		unit: "%",
		scale: "linear",
		fixedMax: 100,
		value: (p) => p.memUsedPct,
		// macOS counts cache as used, so a healthy Mac reads 95% (machineHealth.ts); only machines where the figure means something are drawn.
		include: (m) => m.latest?.platform === "linux" || m.latest?.platform === "win32",
		excludedWhy: (m) => (m.latest?.platform === "darwin" ? "macOS counts cache as used" : "memory is not drawn for this platform"),
		note: "Linux and Windows only: macOS counts cache as used, so its figure would read as pressure on a healthy machine.",
	},
];

/** The series colours, as CSS variables a theme can override (index.css) — never a literal colour in a component. */
export const SERIES_COLORS = 8;
export const seriesColor = (index: number): string => `var(--color-series-${(index % SERIES_COLORS) + 1})`;

// ── What a chart leaves out, and why (#1380) ───────────────────────────────────────────────────────

export interface Omission {
	key: string;
	name: string;
	colorIndex: number;
	reason: string;
}

/**
 * Every machine the fleet has that a chart does NOT draw, with the reason in words. The owner saw telemetry for two of five machines and
 * read the other three as "not reporting"; they were reporting, and the chart left them out without saying so. A machine is omitted for
 * exactly one of three reasons: the chart does not apply to its platform (`excludedWhy`), the machine reports no such figure (`nullWhy`),
 * or it has no reading in this window — and when that machine is silent the reason says when it last spoke.
 */
export function chartOmissions(spec: ChartSpec, machines: readonly FleetMachine[]): Omission[] {
	const out: Omission[] = [];
	machines.forEach((m, i) => {
		const base = { key: m.key, name: m.name, colorIndex: i };
		if (spec.include && !spec.include(m)) {
			out.push({ ...base, reason: spec.excludedWhy?.(m) ?? "not reported on this platform" });
			return;
		}
		const drawn = m.points.some((p) => {
			const v = spec.value(p);
			return v !== null && Number.isFinite(v);
		});
		if (drawn) return;
		const why = spec.nullWhy?.(m);
		if (why) out.push({ ...base, reason: why });
		else if (m.stale) out.push({ ...base, reason: m.points.length ? `offline — last sample ${ageText(m.sampleAgeSec)}` : `offline — no samples in this range, last sample ${ageText(m.sampleAgeSec)}` });
		else out.push({ ...base, reason: "no reading in this range yet" });
	});
	return out;
}

// ── Chart geometry ───────────────────────────────────────────────────────────────────────────────

export interface ChartOpts {
	width: number;
	height: number;
	nowMs: number;
	windowMs: number;
	gapMs: number;
	/** Room on the right for the direct labels. */
	labelWidth: number;
	padL?: number;
	padT?: number;
	padB?: number;
}

export interface Mark {
	x: number;
	y: number;
	value: number;
	atMs: number;
}

export interface SeriesGeometry {
	key: string;
	name: string;
	colorIndex: number;
	/** `points` strings, one per contiguous run of ≥2 readings. A run never spans a gap. */
	runs: string[];
	/** Readings with no neighbour inside the gap bound — a one-point polyline would draw nothing. */
	dots: Mark[];
	marks: Mark[];
	last: Mark | null;
	stale: boolean;
	/** Where a silent machine's line stops (x of its last point), for the stale marker. */
	staleAtX: number | null;
	/** The recommended-maximum line, when the chart has one. */
	limitY: number | null;
	gapCount: number;
}

export interface ChartGeometry {
	plot: { x0: number; x1: number; y0: number; y1: number };
	domain: { min: number; max: number };
	scale: ChartSpec["scale"];
	series: SeriesGeometry[];
	yTicks: Array<{ y: number; label: string }>;
	xTicks: Array<{ x: number; label: string }>;
	threshold: { y: number; label: string } | null;
	labels: Array<{ key: string; x: number; y: number; text: string; stale: boolean; colorIndex: number }>;
	/** Whether anything at all is drawn. False → the page says so instead of showing empty axes as if they were data. */
	empty: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** X for a time: the window ends at `now`, so a live machine's last point sits near the right edge. */
export function xFor(atMs: number, nowMs: number, windowMs: number, x0: number, x1: number): number {
	const t = (atMs - (nowMs - windowMs)) / windowMs;
	return x0 + Math.min(1, Math.max(0, t)) * (x1 - x0);
}

/** 1, 2, 5 × 10ⁿ ticks for a linear axis from 0 to ≥ max. */
export function niceTicks(max: number, count = 4): number[] {
	if (!(max > 0)) return [0, 1];
	const raw = max / count;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
	const out: number[] = [];
	for (let v = 0; v <= max + step * 0.999; v += step) out.push(r2(v));
	return out;
}

/** The domain of a chart: fixed (a percentage), linear from 0, or whole decades for a log axis that must hold the threshold too. */
export function chartDomain(spec: ChartSpec, values: readonly number[]): { min: number; max: number } {
	const extra = spec.threshold ? [spec.threshold.value] : [];
	if (spec.scale === "log") {
		const pos = [...values, ...extra].filter((v) => v > 0);
		if (!pos.length) return { min: 0.1, max: 10 };
		const lo = 10 ** Math.floor(Math.log10(Math.min(...pos)));
		const hi = 10 ** Math.ceil(Math.log10(Math.max(...pos) * 1.0001));
		return { min: lo, max: hi > lo ? hi : lo * 10 };
	}
	if (spec.fixedMax) return { min: 0, max: spec.fixedMax };
	const top = Math.max(0, ...values, ...extra);
	const ticks = niceTicks(top > 0 ? top : 1);
	return { min: 0, max: ticks[ticks.length - 1] };
}

/** Y for a value. On a log axis a value at or below the floor sits ON the floor (a real 0 is still drawn, never dropped). */
export function yFor(value: number, spec: ChartSpec, domain: { min: number; max: number }, y0: number, y1: number): number {
	const t =
		spec.scale === "log"
			? (Math.log10(Math.max(value, domain.min)) - Math.log10(domain.min)) / (Math.log10(domain.max) - Math.log10(domain.min))
			: (value - domain.min) / (domain.max - domain.min);
	return y1 - Math.min(1, Math.max(0, t)) * (y1 - y0);
}

/**
 * Spread end labels so none overlaps another: keep the order of their natural y, push apart by `minGap`, and keep them inside
 * `[lo, hi]`. Pure; the labels land as close to their line ends as the gap allows.
 */
export function placeLabels(ys: readonly number[], minGap: number, lo: number, hi: number): number[] {
	const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
	const out = order.map((o) => Math.min(hi, Math.max(lo, o.y)));
	for (let k = 1; k < out.length; k++) if (out[k] < out[k - 1] + minGap) out[k] = out[k - 1] + minGap;
	// If pushing down ran past the bottom, shift the tail back up.
	for (let k = out.length - 1; k >= 0; k--) {
		const cap = k === out.length - 1 ? hi : out[k + 1] - minGap;
		if (out[k] > cap) out[k] = cap;
	}
	const placed = new Array<number>(ys.length);
	order.forEach((o, k) => {
		placed[o.i] = out[k];
	});
	return placed;
}

const fmt = (v: number): string => (v >= 100 ? String(Math.round(v)) : v >= 10 ? String(r2(v)) : String(r2(v)));

/** The label for an axis tick: powers of ten plainly, others to two places. */
export function tickLabel(v: number, unit: string): string {
	return `${v >= 1000 ? `${v / 1000}k` : fmt(v)}${unit}`;
}

function timeLabel(ms: number, windowMs: number): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return windowMs > 6 * 3600_000 ? `${hh}:00` : `${hh}:${mm}`;
}

const shortName = (n: string, max = 14) => (n.length > max ? `${n.slice(0, max - 1)}…` : n);

/**
 * Project a chart: every machine a series on shared time and value axes, directly labelled at its line end.
 * The machines' colour index is their position in `machines`, so a machine keeps its colour across every chart on the page.
 */
export function chartGeometry(spec: ChartSpec, machines: readonly FleetMachine[], o: ChartOpts): ChartGeometry {
	const padL = o.padL ?? 38;
	const padT = o.padT ?? 8;
	const padB = o.padB ?? 18;
	const plot = { x0: padL, x1: Math.max(padL + 10, o.width - o.labelWidth), y0: padT, y1: Math.max(padT + 10, o.height - padB) };
	const used = machines.map((m, i) => ({ m, i })).filter(({ m }) => !spec.include || spec.include(m));
	const values: number[] = [];
	for (const { m } of used) for (const p of m.points) {
		const v = spec.value(p);
		if (v !== null && Number.isFinite(v)) values.push(v);
	}
	for (const { m } of used) {
		const lim = spec.limit?.(m);
		if (typeof lim === "number") values.push(lim);
	}
	const domain = chartDomain(spec, values);

	const series: SeriesGeometry[] = used.map(({ m, i }) => {
		const marks: Mark[] = [];
		let gapCount = 0;
		for (const p of m.points) {
			const v = spec.value(p);
			const atMs = Date.parse(p.at);
			if (v === null || !Number.isFinite(v) || !Number.isFinite(atMs)) {
				gapCount++;
				continue;
			}
			marks.push({ x: r2(xFor(atMs, o.nowMs, o.windowMs, plot.x0, plot.x1)), y: r2(yFor(v, spec, domain, plot.y0, plot.y1)), value: v, atMs });
		}
		// Split wherever two consecutive readings are further apart than the gap bound — a hole in the data is drawn as a hole.
		const runs: string[] = [];
		const dots: Mark[] = [];
		let cur: Mark[] = [];
		const flush = () => {
			if (cur.length >= 2) runs.push(cur.map((k) => `${k.x},${k.y}`).join(" "));
			else if (cur.length === 1) dots.push(cur[0]);
			cur = [];
		};
		// A null between two readings is itself a break even when the two are close in time: the points are skipped, so compare to the
		// neighbouring PROJECTED reading's time AND to the raw series order.
		const times = new Set(marks.map((k) => k.atMs));
		const raw = m.points.map((p) => Date.parse(p.at));
		let prevIdx = -1;
		for (const k of marks) {
			const idx = raw.indexOf(k.atMs);
			const brokeByNull = prevIdx >= 0 && idx !== prevIdx + 1 && raw.slice(prevIdx + 1, idx).some((t) => !times.has(t));
			if (cur.length && (k.atMs - cur[cur.length - 1].atMs > o.gapMs || brokeByNull)) flush();
			cur.push(k);
			prevIdx = idx;
		}
		flush();
		const last = marks.length ? marks[marks.length - 1] : null;
		const lim = spec.limit?.(m);
		return {
			key: m.key,
			name: m.name,
			colorIndex: i,
			runs,
			dots,
			marks,
			last,
			stale: m.stale,
			staleAtX: m.stale && last ? last.x : null,
			limitY: typeof lim === "number" ? r2(yFor(lim, spec, domain, plot.y0, plot.y1)) : null,
			gapCount,
		};
	});

	const yTicks =
		spec.scale === "log"
			? Array.from({ length: Math.round(Math.log10(domain.max / domain.min)) + 1 }, (_, k) => domain.min * 10 ** k).map((v) => ({ y: r2(yFor(v, spec, domain, plot.y0, plot.y1)), label: tickLabel(v, spec.unit) }))
			: niceTicks(domain.max).filter((v) => v <= domain.max).map((v) => ({ y: r2(yFor(v, spec, domain, plot.y0, plot.y1)), label: tickLabel(v, spec.unit) }));
	const xTicks = Array.from({ length: 5 }, (_, k) => {
		const at = o.nowMs - o.windowMs + (o.windowMs * k) / 4;
		return { x: r2(xFor(at, o.nowMs, o.windowMs, plot.x0, plot.x1)), label: timeLabel(at, o.windowMs) };
	});
	const withEnd = series.filter((s) => s.last);
	const ys = placeLabels(withEnd.map((s) => (s.last as Mark).y), 12, plot.y0 + 4, plot.y1);
	const labels = withEnd.map((s, k) => ({
		key: s.key,
		x: plot.x1 + 6,
		y: r2(ys[k]),
		text: `${shortName(s.name)} ${tickLabel((s.last as Mark).value, spec.unit)}${s.stale ? " · stale" : ""}`,
		stale: s.stale,
		colorIndex: s.colorIndex,
	}));
	return {
		plot,
		domain,
		scale: spec.scale,
		series,
		yTicks,
		xTicks,
		threshold: spec.threshold ? { y: r2(yFor(spec.threshold.value, spec, domain, plot.y0, plot.y1)), label: spec.threshold.label } : null,
		labels,
		empty: withEnd.length === 0,
	};
}

/**
 * The hover tooltip at a pixel x: the moment under the cursor, and for each machine its reading nearest in time — but only when that
 * reading is within the gap bound, so a silent or gapped machine shows "no reading" rather than a number from long ago.
 */
export function tooltipAt(geom: ChartGeometry, px: number, o: Pick<ChartOpts, "nowMs" | "windowMs" | "gapMs">, spec: Pick<ChartSpec, "unit">): { atMs: number; rows: Array<{ key: string; name: string; colorIndex: number; text: string }> } | null {
	const { x0, x1 } = geom.plot;
	if (px < x0 || px > x1) return null;
	const atMs = o.nowMs - o.windowMs + ((px - x0) / (x1 - x0)) * o.windowMs;
	const rows = geom.series.map((s) => {
		let best: Mark | null = null;
		for (const k of s.marks) if (!best || Math.abs(k.atMs - atMs) < Math.abs(best.atMs - atMs)) best = k;
		const near = best && Math.abs(best.atMs - atMs) <= o.gapMs;
		return { key: s.key, name: s.name, colorIndex: s.colorIndex, text: near && best ? `${fmt(best.value)}${spec.unit}` : s.stale ? "stale — no reading" : "no reading" };
	});
	return { atMs, rows };
}

// ── The summary table ────────────────────────────────────────────────────────────────────────────

export interface FleetRow {
	key: string;
	name: string;
	status: StatusVerdict;
	hardware: string;
	sessions: string;
	disk: string;
	load24h: string;
	relayP50: string;
	restarts: string;
	supervisor: string;
	lastSample: string;
}

const GIB = 1024 ** 3;

function ageText(sec: number | null): string {
	if (sec === null) return "never";
	if (sec < 90) return `${sec}s ago`;
	if (sec < 5400) return `${Math.round(sec / 60)}m ago`;
	if (sec < 172_800) return `${Math.round(sec / 3600)}h ago`;
	return `${Math.round(sec / 86_400)}d ago`;
}

/** One row per machine: every cell says "n/a" (or a dash) for a figure the machine does not report — never a 0 it did not measure. */
export function fleetRow(m: FleetMachine): FleetRow {
	const l = m.latest;
	const s = m.summary24h;
	const win = l?.platform === "win32";
	return {
		key: m.key,
		name: m.name,
		status: machineStatus(m),
		hardware: l ? `${l.cpus} cores · ${Math.round(l.memTotalBytes / GIB)} GiB · ${l.platform}` : "—",
		sessions: l && l.activeSessions !== null ? `${l.activeSessions} / ${l.recommendedMaxSessions}` : "—",
		disk: l && l.diskUsedPct !== null ? `${l.diskUsedPct}%` : "—",
		load24h: s && s.loadAvg !== null ? `${s.loadAvg} avg · ${s.loadPeak} peak` : win ? "n/a (Windows)" : "—",
		relayP50: s && s.relayP50Ms !== null ? `${s.relayP50Ms} ms` : "—",
		restarts: s && s.restarts !== null ? String(s.restarts) : l && l.starts24h !== null ? String(l.starts24h) : "—",
		supervisor: l?.supervisor ?? "—",
		lastSample: ageText(m.sampleAgeSec),
	};
}

/** Worst first, so the machine that needs you is at the top; ties by name. */
export function sortedRows(machines: readonly FleetMachine[]): FleetRow[] {
	const rank: Record<FleetStatus, number> = { offline: 4, overloaded: 3, "disk-low": 2, "too-many-sessions": 1, healthy: 0 };
	return machines
		.map(fleetRow)
		.sort((a, b) => rank[b.status.status] - rank[a.status.status] || (b.status.tone === "danger" ? 1 : 0) - (a.status.tone === "danger" ? 1 : 0) || a.name.localeCompare(b.name));
}
