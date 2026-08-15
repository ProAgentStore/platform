import { describe, expect, it } from "vitest";
import { summarizeSubordinates, MAX_OBSERVATION_CHARS, type SubordinateInput } from "./subordinate-observation.js";
import type { RunItem, WorkItem } from "./instance-work.js";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const minsAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

const sub = (id: string, columns: SubordinateInput["columns"]): SubordinateInput => ({
	instanceId: id,
	name: `agent-${id}`,
	subscription: "active",
	columns,
});

const work = (instanceId: string, over: Partial<WorkItem> = {}): WorkItem => ({
	instanceId,
	id: `w-${instanceId}`,
	kind: "delegation",
	status: "running",
	title: "Delegated: get the suite green",
	detail: "",
	updatedAt: minsAgo(1),
	...over,
});

const run = (instanceId: string, over: Partial<RunItem> = {}): RunItem => ({
	instanceId,
	runId: `r-${instanceId}`,
	objective: "get the suite green",
	status: "running",
	stopReason: null,
	detail: null,
	iteration: 4,
	maxIterations: 10,
	startedAt: NOW - 60 * 60_000,
	finishedAt: null,
	lastProgressAt: NOW - 7 * 60_000,
	// Three `RunItem` fields (0127) the factory never carried; `summarizeSubordinates` reads none of
	// them, so this is fixture truthfulness rather than a behaviour change — but it was only
	// invisible because this file was excluded from tsc until #599.
	lastAliveAt: null,
	waitingReason: null,
	waitingUntil: null,
	...over,
});

describe("summarizeSubordinates — supervision holds NO status vocabulary of its own", () => {
	it("buckets the SAME raw status differently, per each subordinate's own declaration", () => {
		// The load-bearing assertion of the whole design. Supervision must not know what
		// "in_progress" means; the SUBORDINATE declares it. This is what lets a third-party agent
		// with columns "Triage / Cooking / Shipped" work on day one with no platform change — and
		// it is why the supervisor never needs to import a domain module to interpret a status.
		const out = summarizeSubordinates({
			now: NOW,
			subordinates: [
				sub("a", [{ id: "running", title: "Running", color: "#000", statuses: ["in_progress"] }]),
				sub("b", [{ id: "cooking", title: "Cooking", color: "#000", statuses: ["in_progress"] }]),
			],
			work: [work("a", { status: "in_progress" }), work("b", { status: "in_progress" })],
			runs: [],
		});
		expect(out.subordinates[0].work[0].columnTitle).toBe("Running");
		expect(out.subordinates[1].work[0].columnTitle).toBe("Cooking");
		// The agent's own word survives untranslated, so the supervisor can disagree with us.
		expect(out.subordinates[0].work[0].status).toBe("in_progress");
	});

	it("falls back to the catchAll column for a status nothing claims", () => {
		const out = summarizeSubordinates({
			now: NOW,
			subordinates: [
				sub("a", [
					{ id: "running", title: "Running", color: "#000", statuses: ["running"] },
					{ id: "other", title: "Other", color: "#000", catchAll: true },
				]),
			],
			work: [work("a", { status: "wat" })],
			runs: [],
		});
		expect(out.subordinates[0].work[0].columnTitle).toBe("Other");
	});

	it("reports columnTitle null — not a guess — when the vocabulary does not cover the status", () => {
		// A null is information: the agent is writing a status its own declaration never claimed.
		const out = summarizeSubordinates({
			now: NOW,
			subordinates: [sub("a", [{ id: "running", title: "Running", color: "#000", statuses: ["running"] }])],
			work: [work("a", { status: "wat" })],
			runs: [],
		});
		expect(out.subordinates[0].work[0].columnTitle).toBeNull();
		expect(out.subordinates[0].buckets).toEqual([]);
	});

	it("counts buckets by the agent's own column titles", () => {
		const cols = [
			{ id: "running", title: "Running", color: "#000", statuses: ["running"] },
			{ id: "needs_human", title: "Needs you", color: "#000", statuses: ["needs_human"] },
		];
		const out = summarizeSubordinates({
			now: NOW,
			subordinates: [sub("a", cols)],
			work: [
				work("a", { id: "w1", status: "running" }),
				work("a", { id: "w2", status: "needs_human" }),
				work("a", { id: "w3", status: "needs_human" }),
			],
			runs: [],
		});
		expect(out.subordinates[0].buckets).toEqual([
			{ id: "running", title: "Running", count: 1 },
			{ id: "needs_human", title: "Needs you", count: 2 },
		]);
	});
});

describe("summarizeSubordinates — staleness is the only signal a dead workflow gives", () => {
	it("reports how long a RUNNING run has been quiet", () => {
		const out = summarizeSubordinates({ now: NOW, subordinates: [sub("a", [])], work: [], runs: [run("a")] });
		expect(out.subordinates[0].runs[0].quietForMinutes).toBe(7);
	});

	it("falls back to startedAt when a run has never reported progress", () => {
		// That IS the signal, not a gap: a Pilot that has never called recordIteration looks quiet
		// since it began, which is exactly what a supervisor should act on.
		const out = summarizeSubordinates({
			now: NOW,
			subordinates: [sub("a", [])],
			work: [],
			runs: [run("a", { lastProgressAt: null })],
		});
		expect(out.subordinates[0].runs[0].quietForMinutes).toBe(60);
	});

	it("does not call a FINISHED run quiet — it is done, not stalled", () => {
		const out = summarizeSubordinates({
			now: NOW,
			subordinates: [sub("a", [])],
			work: [],
			runs: [run("a", { status: "completed", stopReason: "done", finishedAt: NOW - 60_000 })],
		});
		expect(out.subordinates[0].runs[0].quietForMinutes).toBeNull();
	});

	it("passes the loop-run status through VERBATIM — it is a closed platform enum, not a free-text status", () => {
		// Bucketing this through board columns would be wrong: it is already the platform's own
		// word, and boardColumns describes the agent's task vocabulary, not the run vocabulary.
		const out = summarizeSubordinates({
			now: NOW,
			subordinates: [sub("a", [{ id: "done", title: "Shipped", color: "#000", statuses: ["needs_human"] }])],
			work: [],
			runs: [run("a", { status: "needs_human" })],
		});
		expect(out.subordinates[0].runs[0].status).toBe("needs_human");
		expect(out.subordinates[0].runs[0]).not.toHaveProperty("columnTitle");
	});
});

describe("summarizeSubordinates — the size budget", () => {
	it("trims OLDEST work first and says it truncated", () => {
		// Dropping the newest would hide exactly what the supervisor is asking about.
		const many = Array.from({ length: 40 }, (_, i) =>
			work("a", { id: `w${i}`, title: "x".repeat(190), detail: "y".repeat(290), updatedAt: minsAgo(40 - i) }),
		);
		const out = summarizeSubordinates({
			now: NOW,
			subordinates: [sub("a", [{ id: "running", title: "Running", color: "#000", statuses: ["running"] }])],
			work: many,
			runs: [],
			maxChars: 2000,
		});
		expect(out.truncated).toBe(true);
		expect(JSON.stringify(out.subordinates).length).toBeLessThanOrEqual(2000);
		// The survivors are the NEWEST — w39 lives, w0 is gone.
		const ids = out.subordinates[0].work.map((w) => w.id);
		expect(ids).toContain("w39");
		expect(ids).not.toContain("w0");
	});

	it("never drops a subordinate's identity, even when nothing fits", () => {
		const out = summarizeSubordinates({
			now: NOW,
			subordinates: [sub("a", []), sub("b", [])],
			work: [work("a"), work("b")],
			runs: [],
			maxChars: 1,
		});
		expect(out.subordinates).toHaveLength(2);
		expect(out.subordinates.map((s) => s.name)).toEqual(["agent-a", "agent-b"]);
	});

	it("defaults to the same ceiling the hardcoded Overseer uses", () => {
		expect(MAX_OBSERVATION_CHARS).toBe(16_000);
	});
});

describe("summarizeSubordinates — the ordinary shapes", () => {
	it("reports an idle subordinate as present with nothing in flight", () => {
		// Idle is the ABSENCE of work — it has no row anywhere, which is precisely why a unified
		// run table could not have answered this and a resolver is needed either way.
		const out = summarizeSubordinates({ now: NOW, subordinates: [sub("a", [])], work: [], runs: [] });
		expect(out.subordinates[0]).toMatchObject({ instanceId: "a", work: [], runs: [], buckets: [] });
	});

	it("keeps subscription state separate from work state", () => {
		const out = summarizeSubordinates({
			now: NOW,
			subordinates: [{ ...sub("a", []), subscription: "paused" }],
			work: [],
			runs: [],
		});
		expect(out.subordinates[0].subscription).toBe("paused");
	});

	it("routes each item to its own subordinate", () => {
		const out = summarizeSubordinates({
			now: NOW,
			subordinates: [sub("a", []), sub("b", [])],
			work: [work("b", { id: "only-b" })],
			runs: [run("a", { runId: "only-a" })],
		});
		expect(out.subordinates[0].work).toEqual([]);
		expect(out.subordinates[0].runs[0].runId).toBe("only-a");
		expect(out.subordinates[1].work[0].id).toBe("only-b");
	});
});
