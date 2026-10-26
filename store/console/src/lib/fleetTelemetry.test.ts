import { describe, expect, it } from "vitest";
import {
	CHARTS,
	type ChartOpts,
	chartDomain,
	chartGeometry,
	chartOmissions,
	type FleetLatest,
	type FleetMachine,
	type FleetPoint,
	type FleetResponse,
	fleetRow,
	machineStatus,
	mergeFleet,
	niceTicks,
	placeLabels,
	seriesColor,
	sortedRows,
	TIER_GAP_MS,
	TIER_WINDOW_MS,
	tooltipAt,
	xFor,
	yFor,
} from "./fleetTelemetry";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();
const point = (secAgo: number, over: Partial<FleetPoint> = {}): FleetPoint => ({ at: at(secAgo), loadPerCpu: 1, memUsedPct: 50, diskUsedPct: 50, relayRttMs: 100, starts24h: 0, sessionCount: 1, ...over });
const latest = (over: Partial<FleetLatest> = {}): FleetLatest => ({ sampledAt: at(5), cpus: 8, loadPerCpu: 0.4, memTotalBytes: 16 * 1024 ** 3, memUsedPct: 40, platform: "linux", activeSessions: 1, recommendedMaxSessions: 4, diskUsedPct: 50, diskTotalBytes: 1e11, relayRttMs: 100, uptimeSec: 3600, starts24h: 0, supervisor: "service", gateState: "accepting", warnings: [], ...over });
const machine = (name: string, over: Partial<FleetMachine> = {}): FleetMachine => ({ key: `machine-${name}`, machineId: `machine-${name}`, name, node: name, aka: [], lastSeenAt: at(5), sampledAt: at(5), stale: false, sampleAgeSec: 5, latest: latest(), points: [point(60), point(30), point(5)], ...over });
const OPTS: ChartOpts = { width: 640, height: 200, nowMs: NOW, windowMs: TIER_WINDOW_MS.dense, gapMs: TIER_GAP_MS.dense, labelWidth: 110 };
const spec = (id: string) => {
	const s = CHARTS.find((c) => c.id === id);
	if (!s) throw new Error(id);
	return s;
};

describe("status rules (the prototype's thresholds)", () => {
	it("healthy: nothing fires", () => {
		expect(machineStatus(machine("a"))).toMatchObject({ status: "healthy", label: "healthy", tone: "success", issues: [] });
	});

	it.each([
		[{ diskUsedPct: 89.9 }, "healthy"],
		[{ diskUsedPct: 90 }, "disk-low"],
		[{ diskUsedPct: 95 }, "disk-low"],
		[{ loadPerCpu: 1.49 }, "healthy"],
		[{ loadPerCpu: 1.5 }, "overloaded"],
		[{ loadPerCpu: 3 }, "overloaded"],
		[{ activeSessions: 4 }, "healthy"],
		[{ activeSessions: 5 }, "too-many-sessions"],
	] as const)("%j → %s", (over, status) => {
		expect(machineStatus(machine("a", { latest: latest(over) })).status).toBe(status);
	});

	it("tone: warn from the first threshold, danger from the second (disk 95, load 3)", () => {
		expect(machineStatus(machine("a", { latest: latest({ diskUsedPct: 93 }) })).tone).toBe("warning");
		expect(machineStatus(machine("a", { latest: latest({ diskUsedPct: 97 }) })).tone).toBe("danger");
		expect(machineStatus(machine("a", { latest: latest({ loadPerCpu: 2 }) })).tone).toBe("warning");
		expect(machineStatus(machine("a", { latest: latest({ loadPerCpu: 7.6 }) })).tone).toBe("danger");
		expect(machineStatus(machine("a", { latest: latest({ activeSessions: 9 }) })).tone).toBe("warning");
	});

	it("the pink-laptop of the issue: disk 97%, load 7.6/core, 4 sessions against 2 — overloaded, with every rule listed worst first", () => {
		const v = machineStatus(machine("pink", { latest: latest({ diskUsedPct: 97, loadPerCpu: 7.6, activeSessions: 4, recommendedMaxSessions: 2 }) }));
		expect(v.status).toBe("overloaded");
		expect(v.issues).toEqual(["load 7.6/core (≥ 3)", "disk 97% (≥ 95)", "4 sessions against a recommended 2"]);
	});

	it("offline outranks everything: a stale machine's numbers are the last thing it said", () => {
		const v = machineStatus(machine("a", { stale: true, latest: latest({ diskUsedPct: 99, loadPerCpu: 9 }) }));
		expect(v).toMatchObject({ status: "offline", tone: "muted" });
		expect(machineStatus(machine("b", { latest: null, stale: true })).issues).toEqual(["has not reported a sample"]);
	});

	it("a Windows machine (null load) is never overloaded, and disk still counts", () => {
		expect(machineStatus(machine("w", { latest: latest({ platform: "win32", loadPerCpu: null }) })).status).toBe("healthy");
		expect(machineStatus(machine("w", { latest: latest({ platform: "win32", loadPerCpu: null, diskUsedPct: 96 }) })).status).toBe("disk-low");
	});
});

describe("live updates merge", () => {
	const resp = (machines: FleetMachine[], over: Partial<FleetResponse> = {}): FleetResponse => ({ tier: "dense", from: at(7200), to: at(0), now: at(0), cursor: null, truncated: false, machines, ...over });

	it("appends new points, de-duplicates a retried poll, and keeps oldest first", () => {
		const first = resp([machine("a", { points: [point(90), point(60)] })]);
		const next = resp([machine("a", { points: [point(60), point(30)] })], { cursor: at(30) });
		const merged = mergeFleet(first, next, NOW);
		expect(merged.machines[0].points.map((p) => p.at)).toEqual([at(90), at(60), at(30)]);
		expect(merged.cursor).toBe(at(30));
		expect(mergeFleet(merged, next, NOW).machines[0].points).toHaveLength(3); // the same answer twice changes nothing
	});

	it("ages points out of the window, and takes the newest latest/stale from the answer", () => {
		const old = point(TIER_WINDOW_MS.dense / 1000 + 600);
		const first = resp([machine("a", { points: [old, point(60)] })]);
		const next = resp([machine("a", { points: [], stale: true, latest: latest({ loadPerCpu: 9 }) })]);
		const merged = mergeFleet(first, next, NOW).machines[0];
		expect(merged.points.map((p) => p.at)).toEqual([at(60)]);
		expect(merged.stale).toBe(true);
		expect(merged.latest?.loadPerCpu).toBe(9);
	});

	it("keeps the 24h summary an incremental answer does not carry, and adds a machine that appears", () => {
		const first = resp([machine("a", { summary24h: { buckets: 5, loadAvg: 1, loadPeak: 2, relayP50Ms: 100, restarts: 0 } })]);
		const next = resp([machine("a"), machine("b")]);
		const merged = mergeFleet(first, next, NOW);
		expect(merged.machines.map((m) => m.name)).toEqual(["a", "b"]);
		expect(merged.machines[0].summary24h?.loadPeak).toBe(2);
	});

	it("a different tier replaces everything", () => {
		const first = resp([machine("a")]);
		const coarse = resp([machine("b")], { tier: "coarse" });
		expect(mergeFleet(first, coarse, NOW)).toBe(coarse);
		expect(mergeFleet(null, first, NOW)).toBe(first);
	});
});

describe("axes", () => {
	it("xFor: the window ends at now; out-of-window times clamp to the edges", () => {
		expect(xFor(NOW, NOW, 1000, 40, 540)).toBe(540);
		expect(xFor(NOW - 1000, NOW, 1000, 40, 540)).toBe(40);
		expect(xFor(NOW - 500, NOW, 1000, 40, 540)).toBe(290);
		expect(xFor(NOW - 5000, NOW, 1000, 40, 540)).toBe(40);
		expect(xFor(NOW + 5000, NOW, 1000, 40, 540)).toBe(540);
	});

	it("niceTicks: 1-2-5 steps from zero, covering the max", () => {
		expect(niceTicks(100)).toEqual([0, 50, 100]);
		const t = niceTicks(87);
		expect(t[0]).toBe(0);
		expect(t[t.length - 1]).toBeGreaterThanOrEqual(87);
		expect(niceTicks(0)).toEqual([0, 1]);
	});

	it("log domain: whole decades that hold the data and the 1.5 line", () => {
		expect(chartDomain(spec("load"), [0.3, 85])).toEqual({ min: 0.1, max: 100 });
		expect(chartDomain(spec("load"), [])).toEqual({ min: 1, max: 10 }); // nothing to draw still gets a sane axis, around the overload line
		expect(chartDomain(spec("relay"), [])).toEqual({ min: 0.1, max: 10 });
		expect(chartDomain(spec("relay"), [90, 2400])).toEqual({ min: 10, max: 10000 });
	});

	it("linear domains: a percentage is 0-100 whatever the data; counts start at zero and cover the data", () => {
		expect(chartDomain(spec("disk"), [12])).toEqual({ min: 0, max: 100 });
		const d = chartDomain(spec("restarts"), [0, 3]);
		expect(d.min).toBe(0);
		expect(d.max).toBeGreaterThanOrEqual(3);
	});

	it("yFor: the top of the domain is the top of the plot, the floor the bottom; a log axis puts decades evenly", () => {
		const d = { min: 0.1, max: 100 };
		expect(yFor(100, spec("load"), d, 8, 182)).toBe(8);
		expect(yFor(0.1, spec("load"), d, 8, 182)).toBe(182);
		expect(yFor(1, spec("load"), d, 8, 182)).toBeCloseTo(8 + (182 - 8) / 3 * 2, 6);
		expect(yFor(0, spec("load"), d, 8, 182)).toBe(182); // a real 0 sits on the floor of a log axis, not off the chart
		expect(yFor(50, spec("disk"), { min: 0, max: 100 }, 0, 100)).toBe(50);
	});

	it("placeLabels: never overlapping, in order, inside the plot", () => {
		const out = placeLabels([50, 51, 52, 150], 12, 8, 182);
		const sorted = [...out].sort((a, b) => a - b);
		for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(12 - 1e-9);
		expect(Math.min(...out)).toBeGreaterThanOrEqual(8);
		expect(Math.max(...out)).toBeLessThanOrEqual(182);
		expect(out[3]).toBe(150); // a label with room stays at its line's end
		expect(placeLabels([], 12, 0, 100)).toEqual([]);
		// crowded at the bottom: shifted up, not pushed off the chart
		const crowded = placeLabels([180, 181, 182], 12, 8, 182);
		expect(Math.max(...crowded)).toBeLessThanOrEqual(182);
		expect(new Set(crowded).size).toBe(3);
	});

	it("series colours come from theme variables, cycle after eight, and are never literal colours", () => {
		expect(seriesColor(0)).toBe("var(--color-series-1)");
		expect(seriesColor(8)).toBe("var(--color-series-1)");
		expect(seriesColor(3)).toBe("var(--color-series-4)");
	});
});

describe("chart geometry: gaps are gaps", () => {
	it("a continuous series is one run and ends at the right edge when current", () => {
		const g = chartGeometry(spec("disk"), [machine("a", { points: [point(90), point(60), point(30), point(5)] })], OPTS);
		const s = g.series[0];
		expect(s.runs).toHaveLength(1);
		expect(s.runs[0].split(" ")).toHaveLength(4);
		expect(s.dots).toEqual([]);
		expect(s.last?.x).toBeGreaterThan(g.plot.x1 - 6);
		expect(g.empty).toBe(false);
	});

	it("a silence longer than the gap bound BREAKS the line — and the hole is not closed up", () => {
		const m = machine("a", { points: [point(1800), point(1770), point(300), point(270)] });
		const s = chartGeometry(spec("disk"), [m], OPTS).series[0];
		expect(s.runs).toHaveLength(2);
		const xs = s.marks.map((k) => k.x);
		expect(xs[2] - xs[1]).toBeGreaterThan(5 * (xs[1] - xs[0])); // the gap occupies its width
	});

	it("a null reading breaks the line even when its neighbours are close in time (Windows load, a missing relay time)", () => {
		const m = machine("w", { points: [point(120), point(90, { loadPerCpu: null }), point(60), point(30)] });
		const s = chartGeometry(spec("load"), [m], OPTS).series[0];
		expect(s.gapCount).toBe(1);
		expect(s.marks).toHaveLength(3);
		expect(s.dots).toHaveLength(1); // the lone reading before the hole
		expect(s.runs).toHaveLength(1); // the two after it
	});

	it("an all-null series draws nothing and the chart knows it is empty — it never draws a flat line at zero", () => {
		const m = machine("win", { points: [point(60, { loadPerCpu: null }), point(30, { loadPerCpu: null })] });
		const g = chartGeometry(spec("load"), [m], OPTS);
		expect(g.series[0].runs).toEqual([]);
		expect(g.series[0].marks).toEqual([]);
		expect(g.labels).toEqual([]);
		expect(g.empty).toBe(true);
	});

	it("a real 0 IS drawn, on the floor (contrast with a gap)", () => {
		const g = chartGeometry(spec("restarts"), [machine("a", { points: [point(60, { starts24h: 0 }), point(30, { starts24h: 0 })] })], OPTS);
		expect(g.series[0].marks.map((k) => k.y)).toEqual([g.plot.y1, g.plot.y1]);
		expect(g.series[0].runs).toHaveLength(1);
	});

	it("a stale machine's line stops where the machine stopped, is labelled stale, and is NOT extended to now", () => {
		const m = machine("quiet", { stale: true, sampleAgeSec: 1200, points: [point(1500), point(1470), point(1260)] });
		const g = chartGeometry(spec("disk"), [m], OPTS);
		const s = g.series[0];
		expect(s.stale).toBe(true);
		expect(s.staleAtX).toBe(s.last?.x);
		expect(s.last?.x).toBeLessThan(g.plot.x1 - 30);
		expect(Math.max(...s.marks.map((k) => k.x))).toBe(s.last?.x);
		expect(g.labels[0].text).toMatch(/· stale$/);
		expect(g.labels[0].stale).toBe(true);
	});

	it("a machine with no points yet has a series with nothing drawn and no label", () => {
		const g = chartGeometry(spec("disk"), [machine("new", { points: [], latest: null, stale: true })], OPTS);
		expect(g.series[0].last).toBeNull();
		expect(g.labels).toEqual([]);
	});
});

describe("chart geometry: many machines, one set of axes", () => {
	const fleet = [
		machine("pink-laptop", { points: [point(120, { loadPerCpu: 85 }), point(60, { loadPerCpu: 7.6 }), point(5, { loadPerCpu: 7.6 })] }),
		machine("rl-laptop", { points: [point(120, { loadPerCpu: 0.2 }), point(60, { loadPerCpu: 0.3 }), point(5, { loadPerCpu: 0.3 })] }),
		machine("mini", { points: [point(120, { loadPerCpu: 0.25 }), point(60, { loadPerCpu: 0.3 }), point(5, { loadPerCpu: 0.31 })] }),
	];

	it("shares one scale, keeps each machine's colour index, and labels each line directly at its end without overlap", () => {
		const g = chartGeometry(spec("load"), fleet, OPTS);
		expect(g.series.map((s) => s.colorIndex)).toEqual([0, 1, 2]);
		expect(g.labels).toHaveLength(3);
		const ys = g.labels.map((l) => l.y).sort((a, b) => a - b);
		for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(12 - 1e-9);
		for (const l of g.labels) expect(l.x).toBe(g.plot.x1 + 6);
		expect(g.labels[0].text).toBe("pink-laptop 7.6");
		// every point sits inside the plot
		for (const s of g.series) for (const k of s.marks) {
			expect(k.y).toBeGreaterThanOrEqual(g.plot.y0);
			expect(k.y).toBeLessThanOrEqual(g.plot.y1);
			expect(k.x).toBeGreaterThanOrEqual(g.plot.x0);
			expect(k.x).toBeLessThanOrEqual(g.plot.x1);
		}
	});

	it("draws the 1.5 overload line between the quiet machines and the loaded one", () => {
		const g = chartGeometry(spec("load"), fleet, OPTS);
		expect(g.threshold?.label).toBe("1.5 overload");
		const pink = g.series[0].last as { y: number };
		const rl = g.series[1].last as { y: number };
		expect(pink.y).toBeLessThan(g.threshold?.y ?? 0);
		expect(rl.y).toBeGreaterThan(g.threshold?.y ?? 0);
	});

	it("log axis ticks are decades with plain labels", () => {
		const g = chartGeometry(spec("load"), fleet, OPTS);
		expect(g.yTicks.map((t) => t.label)).toEqual(["0.1", "1", "10", "100"]);
	});

	it("sessions: each machine's recommended maximum is a line at its own height; the memory chart leaves out macOS", () => {
		const m = [machine("a", { latest: latest({ recommendedMaxSessions: 2 }) }), machine("b", { latest: latest({ recommendedMaxSessions: 4 }) })];
		const s = chartGeometry(spec("sessions"), m, OPTS).series;
		expect(s[0].limitY).toBeGreaterThan(s[1].limitY ?? 0);
		const mixed = [machine("lin", { latest: latest({ platform: "linux" }) }), machine("mac", { latest: latest({ platform: "darwin" }) }), machine("win", { latest: latest({ platform: "win32" }) })];
		expect(chartGeometry(spec("memory"), mixed, OPTS).series.map((x) => x.name)).toEqual(["lin", "win"]);
	});

	it("fits a phone: a 320px chart has a plot, in-range labels and ticks", () => {
		const phone = chartGeometry(spec("load"), fleet, { ...OPTS, width: 320, height: 180, labelWidth: 84 });
		expect(phone.plot.x1 - phone.plot.x0).toBeGreaterThan(150);
		for (const l of phone.labels) {
			expect(l.y).toBeGreaterThanOrEqual(phone.plot.y0);
			expect(l.y).toBeLessThanOrEqual(phone.plot.y1);
		}
		expect(phone.xTicks).toHaveLength(5);
		const narrowest = chartGeometry(spec("load"), fleet, { ...OPTS, width: 60, labelWidth: 84 });
		expect(narrowest.plot.x1).toBeGreaterThan(narrowest.plot.x0); // never inverted, however small
	});
});

describe("tooltip", () => {
	it("gives each machine's nearest reading, and 'no reading' where it has none near — never a number from long ago", () => {
		const fleet = [machine("a", { points: [point(300, { diskUsedPct: 40 }), point(270, { diskUsedPct: 41 })] }), machine("b", { stale: true, points: [point(3000, { diskUsedPct: 60 })] })];
		const g = chartGeometry(spec("disk"), fleet, OPTS);
		const x = g.series[0].marks[1].x;
		const t = tooltipAt(g, x, OPTS, spec("disk"));
		expect(t?.rows[0]).toMatchObject({ name: "a", text: "41%" });
		expect(t?.rows[1].text).toBe("stale — no reading");
		const far = tooltipAt(g, g.plot.x1 - 1, OPTS, spec("disk"));
		expect(far?.rows[0].text).toBe("no reading");
		expect(tooltipAt(g, g.plot.x0 - 5, OPTS, spec("disk"))).toBeNull();
	});
});

describe("summary table", () => {
	it("a row says what the machine reports and n/a / a dash for what it does not", () => {
		const r = fleetRow(machine("pink", { summary24h: { buckets: 200, loadAvg: 7.6, loadPeak: 85, relayP50Ms: 630, restarts: 3 }, latest: latest({ activeSessions: 4, recommendedMaxSessions: 2, diskUsedPct: 97, supervisor: "launcher" }) }));
		expect(r).toMatchObject({ hardware: "8 cores · 16 GiB · linux", sessions: "4 / 2", disk: "97%", load24h: "7.6 avg · 85 peak", relayP50: "630 ms", restarts: "3", supervisor: "launcher" });
		const win = fleetRow(machine("dell", { summary24h: { buckets: 10, loadAvg: null, loadPeak: null, relayP50Ms: null, restarts: null }, latest: latest({ platform: "win32", loadPerCpu: null, starts24h: 1 }) }));
		expect(win.load24h).toBe("n/a (Windows)");
		expect(win.relayP50).toBe("—");
		expect(win.restarts).toBe("1");
		const none = fleetRow(machine("new", { latest: null, stale: true, sampleAgeSec: null }));
		expect(none).toMatchObject({ hardware: "—", sessions: "—", disk: "—", supervisor: "—", lastSample: "never" });
	});

	it("sorts the machine that needs you to the top", () => {
		const rows = sortedRows([machine("b-ok"), machine("a-disk", { latest: latest({ diskUsedPct: 92 }) }), machine("z-off", { stale: true }), machine("c-load", { latest: latest({ loadPerCpu: 5 }) })]);
		expect(rows.map((r) => r.name)).toEqual(["z-off", "c-load", "a-disk", "b-ok"]);
	});

	it("the age of the last sample reads in the right unit", () => {
		expect(fleetRow(machine("a", { sampleAgeSec: 20 })).lastSample).toBe("20s ago");
		expect(fleetRow(machine("a", { sampleAgeSec: 600 })).lastSample).toBe("10m ago");
		expect(fleetRow(machine("a", { sampleAgeSec: 7200 })).lastSample).toBe("2h ago");
		expect(fleetRow(machine("a", { sampleAgeSec: 3 * 86400 })).lastSample).toBe("3d ago");
	});
});

describe("a chart says which machines it is not drawing, and why (#1380)", () => {
	// The owner's fleet: three Macs reporting, a Windows machine, and a Mac that went quiet hours ago.
	const rl = machine("rl-laptop", { latest: latest({ platform: "darwin" }) });
	const mini = machine("mac-mini", { latest: latest({ platform: "darwin" }) });
	const dell = machine("dell-laptop", { latest: latest({ platform: "win32", loadPerCpu: null }), points: [point(60, { loadPerCpu: null }), point(5, { loadPerCpu: null })] });
	const pink = machine("pink-laptop", { stale: true, sampleAgeSec: 200, latest: latest({ platform: "darwin" }) });
	const tiny = machine("tiny-laptop", { stale: true, sampleAgeSec: 3 * 3600, latest: latest({ platform: "darwin" }), points: [] });
	const fleet = [rl, mini, dell, pink, tiny];

	it("the memory chart names every macOS machine it leaves out, with the reason", () => {
		const out = chartOmissions(spec("memory"), fleet);
		expect(out.filter((o) => o.reason === "macOS counts cache as used").map((o) => o.name)).toEqual(["rl-laptop", "mac-mini", "pink-laptop", "tiny-laptop"]);
		expect(out.some((o) => o.name === "dell-laptop")).toBe(false);
	});

	it("the load chart says a Windows machine has no load average, not that it is missing", () => {
		const out = chartOmissions(spec("load"), fleet);
		expect(out.find((o) => o.name === "dell-laptop")?.reason).toBe("Windows has no load average");
	});

	it("a machine silent for the whole range is listed as offline with when it last spoke, not dropped", () => {
		const out = chartOmissions(spec("disk"), fleet);
		expect(out).toEqual([expect.objectContaining({ name: "tiny-laptop", colorIndex: 4, reason: "offline — no samples in this range, last sample 3h ago" })]);
	});

	it("an online machine with no reading yet is told apart from an offline one", () => {
		const fresh = machine("new-mac", { points: [] });
		expect(chartOmissions(spec("disk"), [fresh])[0].reason).toBe("no reading in this range yet");
	});

	it("every machine is accounted for: drawn on the chart or listed as omitted, never neither", () => {
		for (const c of CHARTS) {
			const geom = chartGeometry(c, fleet, OPTS);
			const accounted = new Set([...geom.series.filter((s) => s.marks.length).map((s) => s.name), ...chartOmissions(c, fleet).map((o) => o.name)]);
			expect([...accounted].sort(), c.id).toEqual(fleet.map((m) => m.name).sort());
		}
	});

	it("keeps a machine's colour index across charts, so its omission line matches its dot in the table", () => {
		expect(chartOmissions(spec("memory"), fleet).map((o) => [o.name, o.colorIndex])).toContainEqual(["tiny-laptop", 4]);
	});
});
