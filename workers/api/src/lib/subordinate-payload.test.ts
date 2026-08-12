import { describe, expect, it } from "vitest";
import { COMPLETENESS_LEGEND, MAX_STATUS_PAYLOAD_CHARS, STATUS_LEGEND, fitStatusPayload, rosterLines } from "./subordinate-payload.js";
import { TOOL_RESULT_MAX_CHARS, capToolResult } from "./tool-result-cap.js";

/**
 * One subordinate the size the live payload actually carries.
 *
 * #503 measured the six live blocks at 7,388–9,914 characters each, pretty-printed, and this one
 * serialises to ~9,800 compact — the upper end of the real thing. Anything smaller would not
 * reproduce the defect, and the point of the fixture is that six of them are 58 KB.
 */
const fatSubordinate = (i: number) => ({
	instanceId: `1111111${i}-2850-45a4-982c-95876${i}c7261e`,
	name: `Agent number ${i}`,
	subscription: "active",
	buckets: [
		{ id: "running", title: "Running", count: 2 },
		{ id: "needs", title: "Needs you", count: 1 },
	],
	work: Array.from({ length: 8 }, (_, w) => ({
		id: `w-${i}-${w}`,
		kind: "delegation",
		status: "running",
		columnTitle: "Running",
		title: `Delegated: ${"work title ".repeat(10)}`,
		detail: "detail ".repeat(20),
		updatedAt: "11 Aug 2026, 01:51 (Australia/Sydney)",
	})),
	runs: Array.from({ length: 5 }, (_, r) => ({
		runId: `r-${i}-${r}`,
		objective: "objective ".repeat(20),
		status: r === 0 ? "running" : "completed",
		stopReason: null,
		detail: "detail ".repeat(17),
		iteration: 4,
		maxIterations: 10,
		quietForMinutes: r === 0 ? 7 : null,
	})),
	connectivity: {
		requiresRunner: true,
		state: "connected",
		canWork: i % 2 === 0,
		node: "macbook",
		runnerVersion: "0.4.32",
		lastSeenAt: "11 Aug 2026, 01:50 (Australia/Sydney)",
		message: "The runner is connected and this agent can be given work now. ".repeat(2),
		remedy: null,
	},
	config: {
		available: true,
		mergeAuthority: { applies: true, policy: "pr-only", note: "may open a pull request, may not merge" },
		specialInstructions: { set: true, text: "rules ".repeat(30) },
		behaviour: { set: true, fields: Array.from({ length: 4 }, (_, f) => ({ id: `f${f}`, label: `Field ${f}`, value: 70, description: "description ".repeat(5) })) },
		settings: { set: true, values: Array.from({ length: 4 }, (_, s) => ({ id: `s${s}`, label: `Setting ${s}`, value: "value", set: true })) },
	},
	repo: {
		repoId: `repo-${i}`,
		name: `display name ${i}`,
		githubRepo: `some-long-organisation-name-${i}/some-long-repository-name-${i}`,
		configuredBranch: "main",
		branch: "main",
		dirtyFiles: 4,
		note: "the previous run left four uncommitted files on this branch. ".repeat(5),
		otherRepos: 0,
	},
	acts: Array.from({ length: 5 }, (_, a) => ({
		kind: "pr.merge",
		summary: "summary ".repeat(12),
		command: "gh pr merge ".repeat(16),
		irreversible: true,
		ok: true,
		traceId: `t-${i}-${a}`,
		at: "11 Aug 2026, 01:40 (Australia/Sydney)",
	})),
});

const line = (i: number) => ({
	instanceId: fatSubordinate(i).instanceId,
	name: `Agent number ${i}`,
	subscription: "active",
	activity: (i === 0 ? "working" : "idle") as "working" | "idle",
	canWork: i % 2 === 0,
});

const fit = (n: number, over: { maxChars?: number; each?: (s: Record<string, unknown>) => Record<string, unknown> } = {}) =>
	fitStatusPayload({
		asOf: "11 Aug 2026, 01:57 (Australia/Sydney)",
		roster: Array.from({ length: n }, (_, i) => line(i)),
		subordinates: Array.from({ length: n }, (_, i) => (over.each ? over.each(fatSubordinate(i)) : fatSubordinate(i))),
		legend: STATUS_LEGEND,
		...(over.maxChars ? { maxChars: over.maxChars } : {}),
	});

const parse = (content: string) =>
	JSON.parse(content) as {
		total: number;
		roster: Array<{ name: string }>;
		rosterOmitted?: number;
		coverage: { detailFor: number; of: number; detailLevel: string; detailOmittedFor?: string[]; detailOmittedCount?: number; note: string };
		legend: string;
		subordinates: Array<Record<string, unknown>>;
	};

describe("fitStatusPayload — the roster is never the thing that gets cut (#503)", () => {
	it("names all six agents, in a result the global backstop does not touch", () => {
		// The live failure, reproduced: six subordinates of this size are 58 KB, `capToolResult`
		// cut at 24,000, and three agents never reached the model at all while a fourth arrived as
		// 480 bytes of a 7,388-byte block. The agent then reported the survivors as the roster.
		expect(JSON.stringify(Array.from({ length: 6 }, (_, i) => fatSubordinate(i))).length).toBeGreaterThan(50_000);
		const out = fit(6);
		const parsed = parse(out.content);
		expect(parsed.total).toBe(6);
		expect(parsed.roster.map((r) => r.name)).toEqual(["Agent number 0", "Agent number 1", "Agent number 2", "Agent number 3", "Agent number 4", "Agent number 5"]);
		// Every one is in the DETAIL too, not only in the roster.
		expect(parsed.subordinates.map((s) => s.name)).toEqual(parsed.roster.map((r) => r.name));
		expect(out.detailOmittedFor).toEqual([]);
		// Not merely "under the cap" — UNTOUCHED by it. `capToolResult` returns its input unchanged
		// when it fits, so this asserts the two budgets can no longer disagree.
		expect(capToolResult(out.content)).toBe(out.content);
	});

	it("still names all ten when there are ten of them", () => {
		// The acceptance criterion as filed: N=10 with full acts/runs, every name survives.
		const out = fit(10);
		const parsed = parse(out.content);
		expect(parsed.total).toBe(10);
		expect(parsed.roster).toHaveLength(10);
		expect(parsed.subordinates).toHaveLength(10);
		expect(out.content.length).toBeLessThanOrEqual(MAX_STATUS_PAYLOAD_CHARS);
		expect(capToolResult(out.content)).toBe(out.content);
	});

	it("sits below the global backstop by construction", () => {
		expect(MAX_STATUS_PAYLOAD_CHARS).toBeLessThan(TOOL_RESULT_MAX_CHARS);
	});

	it("leaves one agent's full record alone — the narrower slice the truncation notice asks for", () => {
		// The other half of the design: the roster answer is complete, and the per-agent answer is
		// deep. `subordinate_status(instanceId)` is now a slice that genuinely answers something.
		const sub = fatSubordinate(1);
		const out = fitStatusPayload({ asOf: "now", roster: [line(1)], subordinates: [sub], legend: STATUS_LEGEND });
		expect(out.level).toBe("full");
		expect(parse(out.content).subordinates[0]).toEqual(sub);
	});
});

describe("fitStatusPayload — a reduction says so, next to what it reduced", () => {
	it("never empties a list that has something in it", () => {
		// The #259 invariant restated: empty `work`/`runs` means IDLE and the legend says so, so a
		// budget that empties a busy agent's lists reports it as doing nothing.
		for (const s of parse(fit(2).content).subordinates) {
			expect((s.work as unknown[]).length).toBeGreaterThanOrEqual(1);
			expect((s.runs as unknown[]).length).toBeGreaterThanOrEqual(1);
			// And #159/#183: a shortened `acts` must not become an absent `acts`, which reads as
			// "no irreversible action was observed".
			expect((s.acts as unknown[]).length).toBeGreaterThanOrEqual(1);
		}
	});

	it("counts what it dropped, beside the list it dropped it from", () => {
		const s = parse(fit(2).content).subordinates[0];
		expect(s.workOmitted).toBe(8 - (s.work as unknown[]).length);
		expect(s.actsOmitted).toBe(5 - (s.acts as unknown[]).length);
	});

	it("ADDS to a count the caller already recorded, rather than replacing it", () => {
		// `summarizeSubordinates` trims work to its own budget first and leaves `workOmitted`
		// behind. Overwriting it here would report 5 dropped items where 45 were.
		const out = fit(2, { each: (s) => ({ ...s, workOmitted: 40 }) });
		const s = parse(out.content).subordinates[0];
		expect(s.workOmitted).toBe(40 + (8 - (s.work as unknown[]).length));
	});

	it("cuts prose but never an identifier", () => {
		// A `githubRepo` cut for length is still a plausible `owner/name`, and #320 is the ticket
		// about a supervisor handing a plausible-looking repo path to a GitHub tool.
		const s = parse(fit(2).content).subordinates[0];
		const repo = s.repo as { githubRepo: string; note: string };
		expect(repo.githubRepo).toBe("some-long-organisation-name-0/some-long-repository-name-0");
		expect(s.instanceId).toBe(fatSubordinate(0).instanceId);
		expect(repo.note).toMatch(/…\[\+\d+ chars\]$/);
		expect(repo.note.length).toBeLessThan(fatSubordinate(0).repo.note.length);
	});

	it("keeps the bucket counts whole — they are already the summary", () => {
		const s = parse(fit(2).content).subordinates[0];
		expect(s.buckets).toHaveLength(2);
		expect(s.bucketsOmitted).toBeUndefined();
	});

	it("says how much detail survived, in the payload", () => {
		const parsed = parse(fit(10).content);
		expect(parsed.coverage).toMatchObject({ detailFor: 10, of: 10 });
		expect(parsed.coverage.detailLevel).not.toBe("full");
		expect(parsed.coverage.note).toMatch(/All 10 agents you supervise are listed/);
		expect(parsed.coverage.note).toMatch(/SHORTENED/);
	});
});

describe("fitStatusPayload — the last rung is one line, and it is still honest", () => {
	const summarised = () => {
		const out = fit(10);
		expect(out.level).toBe("summary");
		return parse(out.content).subordinates;
	};

	it("replaces each list with a count that INCLUDES what an earlier pass dropped", () => {
		const s = summarised()[0];
		expect(s.workCount).toBe(8);
		expect(s.runsCount).toBe(5);
		expect(s.actsCount).toBe(5);
		const withPrior = parse(fit(10, { each: (x) => ({ ...x, workOmitted: 40 }) }).content).subordinates[0];
		expect(withPrior.workCount).toBe(48);
	});

	it("keeps the bucket counts as counts, not a count OF them", () => {
		// Live, the first cut of this rung reported `bucketsCount: 4` — the number of board COLUMNS,
		// which answers nothing. The buckets themselves are already the summary.
		const s = summarised()[0];
		expect(s.buckets).toEqual([
			{ id: "running", title: "Running", count: 2 },
			{ id: "needs", title: "Needs you", count: 1 },
		]);
		expect(s.bucketsCount).toBeUndefined();
	});

	it("keeps the four things a supervisor cannot lose", () => {
		const s = summarised()[0];
		// The only field the legend says answers "can I give it work".
		expect((s.connectivity as { canWork: boolean }).canWork).toBe(true);
		// #159/#183 — a merge or force-push is reported unprompted, and a count cannot be mistaken
		// for "it did nothing" the way an absent list can.
		expect(s.irreversibleActs).toBe(5);
		// What it is doing, in one string, which is the question being asked.
		expect(s.latest).toMatch(/^objective/);
		expect(s.activity).toBe("working");
		// #339 — what it is ALLOWED to do is standing configuration, never a run objective.
		expect((s.config as { mergeAuthority: { policy: string } }).mergeAuthority.policy).toBe("pr-only");
		// And it says, in the record itself, that this is a line and not the record.
		expect(String(s.summarised)).toMatch(/call subordinate_status with this instanceId/);
	});

	it("counts a list added to the payload later, without being taught about it", () => {
		// The #468 lesson: an enumerated projection reports a new field as absent forever. The
		// counts are derived from whatever arrays are there.
		const s = parse(fit(10, { each: (x) => ({ ...x, incidents: [{ id: "i1" }, { id: "i2" }] }) }).content).subordinates[0];
		expect(s.incidentsCount).toBe(2);
	});

	it("NAMES what it could not fit at all, and keeps the count right", () => {
		// Far past what this feature is built for. What must not happen is a payload that lists
		// twelve agents and looks like the whole roster.
		const n = 400;
		const out = fit(n);
		const parsed = parse(out.content);
		expect(out.content.length).toBeLessThanOrEqual(MAX_STATUS_PAYLOAD_CHARS);
		expect(parsed.total).toBe(n);
		expect(parsed.subordinates.length).toBeLessThan(n);
		expect(parsed.coverage.detailOmittedCount).toBe(n - parsed.subordinates.length);
		expect(parsed.coverage.note).toMatch(/left out of this reply entirely/);
		// The roster is the LAST thing to go, and never silently: `total` stays true and
		// `rosterOmitted` says how many names are missing when even the names do not fit.
		expect(parsed.roster.length + (parsed.rosterOmitted ?? 0)).toBe(n);
	});
});

describe("fitStatusPayload — the head answers the question that was asked", () => {
	it("puts total and roster before the legend and the detail", () => {
		// Key ORDER, not merely presence: `capToolResult` keeps the head, so a result cut by some
		// future caller must still carry the count.
		const out = fit(6);
		expect(out.content.indexOf('"total"')).toBeLessThan(out.content.indexOf('"legend"'));
		expect(out.content.indexOf('"roster"')).toBeLessThan(out.content.indexOf('"legend"'));
		expect(out.content.indexOf('"roster"')).toBeLessThan(out.content.indexOf('"subordinates"'));
	});

	it("tells the model where the count lives and what an omitted count means", () => {
		expect(COMPLETENESS_LEGEND).toMatch(/how many agents do you have/i);
		expect(COMPLETENESS_LEGEND).toMatch(/Omitted/);
		expect(COMPLETENESS_LEGEND).toMatch(/NEVER shortened/);
		expect(parse(fit(6).content).legend).toContain("`total` and `roster`");
	});
});

describe("rosterLines — which ones are idle", () => {
	const roster = [
		{ instanceId: "a", name: "FAS platform", subscription: "active" },
		{ instanceId: "b", name: "Heartfull", subscription: "active" },
		{ instanceId: "c", name: "Chess coder 2", subscription: "paused" },
	];

	it("calls an agent with a running run working, and one with none idle", () => {
		// The owner asked four times which agents were idle and never got a list. This is it.
		const out = rosterLines({
			roster,
			observed: [
				{ instanceId: "a", runs: [{ status: "completed" }, { status: "running" }] },
				{ instanceId: "b", runs: [{ status: "completed" }] },
				{ instanceId: "c", runs: [] },
			],
			canWork: new Map([
				["a", true],
				["b", false],
			]),
		});
		expect(out.map((r) => r.activity)).toEqual(["working", "idle", "idle"]);
		expect(out.map((r) => r.canWork)).toEqual([true, false, undefined]);
	});

	it("leaves activity ABSENT for an agent this call never looked at", () => {
		// A status call narrowed to one agent reads runs for that agent alone. Reporting the other
		// two as idle on the strength of a query that never asked about them is the confident wrong
		// answer this whole file exists to stop — but the roster is still complete, which is the point.
		const out = rosterLines({ roster, observed: [{ instanceId: "b", runs: [{ status: "running" }] }], canWork: new Map() });
		expect(out.map((r) => r.activity)).toEqual([undefined, "working", undefined]);
		expect(out).toHaveLength(3);
	});
});
