import { describe, expect, it } from "vitest";
import {
	activityFor,
	healthCounts,
	HEALTH_DOT,
	indexActivity,
	lastActiveAt,
	outcomeLine,
	parseHealthFilter,
	statusRank,
	type ActivityResponse,
	type InstanceActivity,
} from "./instanceActivity";
import type { Instance } from "./types";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function inst(over: Partial<Instance> = {}): Instance {
	return { id: "i1", agent_id: "a1", slug: "s", name: "One", status: "active", created_at: "", ...over } as Instance;
}
function act(over: Partial<InstanceActivity> = {}): InstanceActivity {
	return { instanceId: "i1", health: "idle", queueDepth: 0, lastOutcome: null, ...over };
}

describe("indexActivity / activityFor — absence means idle, by contract with the endpoint", () => {
	it("indexes the response by instance id", () => {
		const res: ActivityResponse = { asOf: NOW, instances: [act({ instanceId: "a", health: "working" })] };
		expect(indexActivity(res).get("a")?.health).toBe("working");
	});

	it("survives a null or empty response", () => {
		expect(indexActivity(null).size).toBe(0);
		expect(indexActivity({ asOf: NOW, instances: [] }).size).toBe(0);
	});

	it("gives a MISSING instance the idle record, not a fifth unknown state", () => {
		// The endpoint omits instances with no run and no queue so its cost stays flat. Reading
		// that as "unknown" would invent a state the server deliberately does not have.
		expect(activityFor(new Map(), "ghost")).toEqual({ instanceId: "ghost", health: "idle", queueDepth: 0, lastOutcome: null });
	});
});

describe("HEALTH_DOT — only working pulses, only stalled is danger", () => {
	it("pulses for working and nothing else", () => {
		expect(HEALTH_DOT.working).toContain("animate-pulse");
		for (const h of ["waiting", "stalled", "idle"] as const) expect(HEALTH_DOT[h]).not.toContain("animate-pulse");
	});

	it("gives waiting a muted tone, not a warning — a park is correct", () => {
		expect(HEALTH_DOT.waiting).toContain("muted");
		expect(HEALTH_DOT.waiting).not.toContain("danger");
	});

	it("reserves the danger token for stalled, the only state that asks for a human", () => {
		expect(HEALTH_DOT.stalled).toContain("danger");
	});
});

describe("outcomeLine — a fact about the last run, never a verdict on the instance", () => {
	it("says nothing while the instance is working or waiting", () => {
		const last = { runId: "r", status: "failed", stopReason: "failed", finishedAt: NOW - MIN, startedAt: NOW - 2 * MIN, lastAliveAt: null };
		expect(outcomeLine(act({ health: "working", lastOutcome: last }), NOW)).toBeNull();
		expect(outcomeLine(act({ health: "waiting", lastOutcome: last }), NOW)).toBeNull();
	});

	it("says nothing for an instance that has never run", () => {
		expect(outcomeLine(act({ health: "idle" }), NOW)).toBeNull();
	});

	it("prefers the stop reason over the status — 'raise the cap' vs 'the objective is wrong'", () => {
		const line = outcomeLine(
			act({ health: "idle", lastOutcome: { runId: "r", status: "failed", stopReason: "max_iterations", finishedAt: NOW - 30 * MIN, startedAt: NOW - 60 * MIN, lastAliveAt: null } }),
			NOW,
		);
		expect(line).toBe("Last run: hit its step limit 30m ago");
		expect(line).not.toContain("failed");
	});

	it("still speaks for a STALLED instance, where the open run is the thing that went wrong", () => {
		expect(
			outcomeLine(act({ health: "stalled", lastOutcome: { runId: "r", status: "running", stopReason: null, finishedAt: null, startedAt: NOW - 90 * MIN, lastAliveAt: NOW - 80 * MIN } }), NOW),
		).toContain("1h ago");
	});

	it("falls back through finishedAt → lastAliveAt → startedAt for the age", () => {
		expect(outcomeLine(act({ health: "idle", lastOutcome: { runId: "r", status: "cancelled", stopReason: null, finishedAt: null, lastAliveAt: null, startedAt: NOW - 3 * MIN } }), NOW)).toBe("Last run: was stopped 3m ago");
	});
});

describe("lastActiveAt — the corrected definition, not `last_activity_at` alone", () => {
	it("takes the run's heartbeat when the owner has not touched the instance", () => {
		// The exact case the "Recently used" label existed to avoid claiming: a Pilot working
		// unattended for two hours, which last_activity_at does not move.
		const a = act({ health: "working", lastOutcome: { runId: "r", status: "running", stopReason: null, finishedAt: null, startedAt: NOW - 120 * MIN, lastAliveAt: NOW - MIN } });
		expect(lastActiveAt(inst({ lastActivityAt: null }), a)).toBe(NOW - MIN);
	});

	it("takes the owner's own activity when it is the more recent", () => {
		const own = new Date(NOW - MIN).toISOString();
		const a = act({ lastOutcome: { runId: "r", status: "failed", stopReason: null, finishedAt: NOW - 200 * MIN, startedAt: NOW - 300 * MIN, lastAliveAt: NOW - 200 * MIN } });
		expect(lastActiveAt(inst({ lastActivityAt: own }), a)).toBe(Date.parse(own));
	});

	it("is 0 for an instance with neither, rather than NaN sorting unpredictably", () => {
		expect(lastActiveAt(inst({ lastActivityAt: null }), act())).toBe(0);
		expect(lastActiveAt(inst({ lastActivityAt: "not a date" }), act())).toBe(0);
	});
});

describe("statusRank — whatever needs the owner floats up", () => {
	it("orders stalled, waiting, working, idle", () => {
		const order = (["idle", "working", "stalled", "waiting"] as const).slice().sort((a, b) => statusRank(a) - statusRank(b));
		expect(order).toEqual(["stalled", "waiting", "working", "idle"]);
	});

	it("puts stalled first, because it is the only one asking for a human", () => {
		expect(statusRank("stalled")).toBeLessThan(statusRank("working"));
	});
});

describe("healthCounts", () => {
	it("counts every instance, including those the response omitted", () => {
		const map = indexActivity({ asOf: NOW, instances: [act({ instanceId: "a", health: "stalled" })] });
		expect(healthCounts([inst({ id: "a" }), inst({ id: "b" }), inst({ id: "c" })], map)).toEqual({
			working: 0,
			waiting: 0,
			stalled: 1,
			idle: 2,
		});
	});

	it("reports zeroes rather than omitting a status, so the filter does not reflow", () => {
		expect(Object.keys(healthCounts([], new Map())).sort()).toEqual(["idle", "stalled", "waiting", "working"]);
	});
});

describe("parseHealthFilter", () => {
	it("accepts the four states and rejects anything else", () => {
		expect(parseHealthFilter("stalled")).toBe("stalled");
		expect(parseHealthFilter("ended")).toBe("");
		expect(parseHealthFilter(undefined)).toBe("");
	});
});
