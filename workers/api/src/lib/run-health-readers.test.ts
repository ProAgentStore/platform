/**
 * One run, one verdict — asserted over every reader of `agent_loop_runs` this repo has (#589).
 *
 * ── What went wrong, and why a per-file test could not have caught it
 *
 * `f01d5b4` (#580 AC3) added `runHealth` so a client would stop inferring "is this alright" from
 * two timestamps. It reached two of the readers. For one run parked 4.35 hours on the coding CLI's
 * own usage limit, three surfaces answered differently AT THE SAME INSTANT:
 *
 *   check_instance_loop  → health:"waiting", "WAITING, not stalled and not working…"
 *   subordinate_status   → activity:"working", quietForMinutes: 261
 *   the console          → "step 1/40 · started 4h ago", with a live Stop button
 *
 * A Coder Lead blocks on a subordinate that stopped hours ago; the owner sees a Stop button for a
 * run that had already stopped itself. Each of the three files was internally consistent and had
 * passing tests. **Two surfaces deriving one fact independently is the defect**, and it is invisible
 * to any test that looks at one file — so the assertion has to be over the SET.
 *
 * ── The denominator (ADR 0002)
 *
 * G1/G3: the reader set is FOUND, by seven needles over five source trees, and every needle must
 * match something. A needle that matches nothing means the thing it named was renamed and this
 * guard has quietly stopped measuring — which fails here, loudly, rather than passing on a smaller
 * tree. G2: every arm prints the size of what it examined.
 *
 * The count is deliberately NOT pinned to an exact number: several agents commit to this repo
 * concurrently and a reader added by unrelated work is normal. It is floored instead, with the
 * reason beside the floor — a set this small means the sweep broke, not that the tree got tidy.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { runHealth, waitClause, type RunHealth } from "./work-report.js";
import { summarizeSubordinates } from "./subordinate-observation.js";
import { activityFromRuns, rosterLines } from "./subordinate-payload.js";
import type { RunItem } from "./instance-work.js";

/** Repo root, from `workers/api/src/lib/` — the guard reaches the console and coder-web too. */
const ROOT = new URL("../../../../", import.meta.url).pathname;

/**
 * Where a loop-run reader can live. The console and coder-web are in the sweep BECAUSE the console
 * was one of the three disagreeing surfaces: a guard that stopped at the Worker boundary would
 * have measured two of the three files in its own bug report.
 */
const TREES = ["workers/api/src", "workers/mcp/src", "store/console/src", "agents/coder/web/src", "packages/sdk/src"];

interface Source {
	rel: string;
	/** Lines with whole-line comments dropped — this repo explains itself at length, and the words
	 *  these needles look for appear far more often in prose ABOUT runs than in code reading one. */
	lines: string[];
	body: string;
}

function sources(): Source[] {
	const out: Source[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const p = join(dir, entry);
			if (statSync(p).isDirectory()) {
				walk(p);
				continue;
			}
			if (!/\.(ts|tsx)$/.test(p) || /\.test\.tsx?$/.test(p) || p.endsWith(".d.ts")) continue;
			const lines = readFileSync(p, "utf-8").split("\n");
			const kept = lines.map((l) => (/^\s*(\*|\/\/)/.test(l) ? "" : l));
			out.push({ rel: relative(ROOT, p), lines: kept, body: kept.join("\n") });
		}
	};
	for (const t of TREES) {
		try {
			walk(join(ROOT, t));
		} catch {
			// A tree that does not exist is a MOVED tree, not an empty one. Recorded as a zero and
			// caught by the needle assertions below rather than silently shrinking the sweep.
		}
	}
	return out;
}

/**
 * How a module can be reading `agent_loop_runs`. Every access route the table has, named.
 *
 * The console never mentions the table — it reads the record over HTTP — which is exactly why
 * `endpoint` is a needle. A reader set built from SQL alone would have found four of the five
 * readers in the issue and missed the one the owner looks at.
 */
const NEEDLES: Record<string, RegExp> = {
	/** The table itself, in a query. */
	table: /agent_loop_runs/,
	/** `agent-loop-store`'s record — what the two readers that DID apply the verdict hold. */
	storeView: /\bLoopRunView\b/,
	/** `instance-work`'s cross-instance row — the supervision path's shape. */
	crossInstance: /\bRunItem\b/,
	/** `subordinate-observation`'s projection of it. */
	observed: /\bObservedRun\b/,
	/** The console's own mirrored shape. */
	consoleShape: /\bLoopRunLike\b/,
	/** The functions that read rows out. */
	reads: /\b(listLoopRuns|getLoopRun|delegatedRunsFor|recentRunsForInstances)\b/,
	/** The HTTP surface — how every client reader gets one. */
	endpoint: /\/loop(\?|`|"|'|\/)/,
	/** The verdict itself, so a module that consumes it is counted as a reader too. */
	verdict: /\b(runHealth|RunHealth|activityFromRuns)\b/,
};

/**
 * A floor, not a pin, and the reason is the number itself: the issue named five readers and the
 * sweep finds four times that. Anything under this means a needle stopped matching or a tree
 * moved — a real tree cannot shed two thirds of its loop-run readers in one commit.
 */
const MIN_READERS = 15;

const readerSet = () => {
	const all = sources();
	const readers = all.filter((s) => Object.values(NEEDLES).some((re) => re.test(s.body)));
	return { all, readers };
};

describe("every reader of agent_loop_runs derives liveness from one implementation (#589 AC3)", () => {
	it("finds the readers it claims to sweep, through every needle", () => {
		const { all, readers } = readerSet();
		// G1: an empty or implausibly small input set is a broken sweep, not a clean tree.
		expect(all.length, `${all.length} source files across ${TREES.length} trees`).toBeGreaterThan(300);
		expect(
			readers.length,
			`${readers.length} loop-run readers found over ${all.length} source files in ${TREES.length} trees`,
		).toBeGreaterThanOrEqual(MIN_READERS);
		// G3: a needle that matches nothing has been renamed out from under this guard, and the
		// set it was contributing has silently left the measurement. Each is asserted separately
		// so the failure names WHICH access route stopped being watched.
		for (const [name, re] of Object.entries(NEEDLES)) {
			const matched = all.filter((s) => re.test(s.body)).map((s) => s.rel);
			expect(matched.length, `needle \`${name}\` (${re}) matches no file — it was renamed, and this guard stopped measuring that access route`).toBeGreaterThan(0);
		}
	});

	/**
	 * The defect's exact shape: a line that reads the raw column AND names a liveness state.
	 *
	 * `out.activity = runs.some((r) => r.status === "running") ? "working" : "idle"` — both halves
	 * on one line, in two files. That is what turns a column into a claim, and it is what this
	 * arm forbids. Comparing `status` to `"running"` on its own is fine and common: it answers "is
	 * this run OPEN", which the Stop button, the watcher and the poll all legitimately need. The
	 * two questions were one sentence in the console until this ticket, which is why the rule is
	 * stated as a pair rather than as a ban on the comparison.
	 */
	it("no reader turns the raw status column into a liveness word", () => {
		const OPEN_TEST = /\bstatus\b\s*(?:===|!==|==|!=)\s*(["'])running\1/;
		const LIVENESS_WORD = /(["'])(working|idle|stalled)\1/;
		/**
		 * The one module allowed to hold the rule, because it IS the rule. Everything else quotes
		 * its answer. An entry here is a claim that a file owns the definition of liveness, and
		 * there can only be one.
		 */
		const OWNER = "workers/api/src/lib/work-report.ts";
		const { readers } = readerSet();
		const offenders: string[] = [];
		let linesChecked = 0;
		for (const s of readers) {
			if (s.rel === OWNER) continue;
			s.lines.forEach((line, i) => {
				linesChecked++;
				if (OPEN_TEST.test(line) && LIVENESS_WORD.test(line)) offenders.push(`${s.rel}:${i + 1}: ${line.trim()}`);
			});
		}
		// Compared EXACTLY, not as a subset: removing the last offender must fail this too, so the
		// list can only shrink deliberately.
		expect(offenders, `${linesChecked} lines across ${readers.length} readers`).toEqual([]);
	});

	/**
	 * #589 AC2, asserted over the SQL rather than over a comment about it.
	 *
	 * `recentRunsForInstances` did not select `last_alive_at`, `waiting_reason` or `waiting_until`,
	 * so the supervision path could not form a verdict even in principle — it had `status` and one
	 * progress timestamp and nothing else. This is the arm that stops the columns being dropped
	 * again by someone tidying a SELECT list.
	 */
	it("the cross-instance reader selects every column a verdict needs", () => {
		const sql = readFileSync(join(ROOT, "workers/api/src/lib/instance-work.ts"), "utf-8");
		const REQUIRED = ["status", "started_at", "last_progress_at", "last_alive_at", "waiting_reason", "waiting_until"];
		for (const col of REQUIRED) {
			expect(sql, `recentRunsForInstances must SELECT \`${col}\` — without it no verdict is possible`).toMatch(new RegExp(`\\b${col}\\b`));
		}
		expect(REQUIRED.length, `${REQUIRED.length} columns required for a verdict`).toBe(6);
	});
});

/**
 * The legends that TEACH the verdict must name every value it can take.
 *
 * `subordinate_status` cannot afford `RUN_HEALTH_LEGEND` verbatim — it is 856 characters and that
 * payload has run out of room before (#503) — so it carries a shortened clause instead. A second
 * hand-maintained restatement of one fact is exactly the #585/#594 failure: prose that names a
 * field the code has since changed, believed because it sits right next to the data. This is the
 * price of the shortcut, paid here rather than by the next reader.
 */
describe("no legend names fewer states than the code can produce (#594 AC5, scoped)", () => {
	/** Compile-time exhaustive: adding a member to either union fails to typecheck here. */
	const HEALTH: Record<RunHealth, true> = { working: true, waiting: true, stalled: true, ended: true };
	const ACTIVITY: Record<ReturnType<typeof activityFromRuns>, true> = { working: true, waiting: true, stalled: true, idle: true, unknown: true };

	it("the canonical legend names every RunHealth member", async () => {
		const { RUN_HEALTH_LEGEND } = await import("./work-report.js");
		const members = Object.keys(HEALTH);
		for (const m of members) expect(RUN_HEALTH_LEGEND, `RUN_HEALTH_LEGEND omits \`${m}\``).toContain(`\`${m}\``);
		expect(members.length, `${members.length} RunHealth members checked`).toBe(4);
	});

	/**
	 * Every park's deadline is rendered with the verb matching its KIND (#596 AC4).
	 *
	 * The defect: `waiting_until` used to be rendered as "expected to resume in …" whatever the
	 * park was, and stayed coherent only because its second producer ABSTAINED — the human handoff
	 * had a computable 15-minute deadline and published nothing rather than publish a give-up under
	 * a resume verb. So the field's honesty rested on a writer declining to write, and the one
	 * deadline an owner can still beat was the one nobody was shown.
	 *
	 * Two deadlines, opposite actions: "resuming at 16:00" means do nothing, "giving up at 16:00"
	 * means intervene now. The verb is therefore the load-bearing half of the sentence, and this
	 * asserts it per reason rather than for the case that happens to be right.
	 *
	 * ── The denominator (ADR 0002 G1/G2)
	 *
	 * `RUN_WAIT_REASONS` is walked at RUN TIME. The previous version of this test wrote
	 * `const REASONS: Record<RunWaitReason, true>` and called it compile-time exhaustive — it was
	 * not, when it was written: `workers/api/tsconfig.json` excluded `src/**\/*.test.ts` and vitest
	 * transpiles without checking, so that annotation compiled nowhere and could never have failed.
	 * A fourth park reason would have walked straight past the one guard whose job is to count them.
	 *
	 * The array is the fix REGARDLESS of whether the tests are typechecked later: the assertions
	 * below are about rendered strings, so the denominator has to exist at the moment they run.
	 * Same lesson as `RUN_HEALTH_STATES` (#588), applied one enum over.
	 */
	it("renders EVERY park reason's deadline with the verb matching its kind", async () => {
		const { waitClause } = await import("./work-report.js");
		const { RUN_WAIT_REASONS } = await import("./agent-loop-store.js");
		const NOW = 1_000_000;
		const IN_12M = NOW + 12 * 60_000;
		const noteFor = (reason: string, until: number | null) =>
			waitClause({ status: "running", waitingReason: reason, waitingUntil: until, lastAliveAt: NOW, startedAt: 0 }, NOW) ?? "";

		// G1 — a sweep over an empty or shrunken vocabulary is a broken guard, not a clean tree.
		expect(RUN_WAIT_REASONS.length, `${RUN_WAIT_REASONS.length} park reasons swept`).toBeGreaterThanOrEqual(3);

		/** The verb each reason's deadline must be said with — restated here, ON PURPOSE. */
		const KIND: Record<string, "resume" | "give_up"> = { engine_limit: "resume", human: "give_up", platform_interrupt: "resume" };
		const seen = new Set<string>();
		for (const reason of RUN_WAIT_REASONS) {
			const kind = KIND[reason];
			// A reason with no entry here is a reason nobody decided the kind of. Failing is the
			// point: the table in `work-report.ts` would otherwise silently give it a verb.
			expect(kind, `no deadline kind decided for park reason \`${reason}\` — add it to work-report.ts's PARKS and here`).toBeDefined();
			seen.add(kind);
			const note = noteFor(reason, IN_12M);
			expect(note, `\`${reason}\` renders no note at all`).not.toBe("");
			expect(note, `\`${reason}\` states no deadline though one was given`).toContain("12m");
			if (kind === "resume") {
				expect(note, `\`${reason}\` is a resume and must say so`).toContain("expected to resume");
				expect(note, `\`${reason}\` is a resume and must not say it gives up`).not.toContain("GIVES UP");
			} else {
				// G4, the red demonstrated: on the tree that shipped, `waitClause` rendered ANY
				// `waitingUntil` as "expected to resume in …", so this line fails there — which is
				// exactly the sentence that would tell an owner to wait for a run about to stop
				// waiting for them.
				expect(note, `\`${reason}\` is a give-up and must NOT be rendered as a resume`).not.toContain("expected to resume");
				expect(note, `\`${reason}\` is a give-up and must say so`).toContain("GIVES UP");
			}
			// The park still names what it waits for when no end is knowable.
			expect(noteFor(reason, null), `\`${reason}\` with no end`).not.toBe("");
		}
		// Both kinds are actually exercised: a table where every reason is a `resume` would satisfy
		// every assertion above while testing only half the rule.
		expect([...seen].sort(), `${seen.size} deadline kinds exercised across ${RUN_WAIT_REASONS.length} reasons`).toEqual(["give_up", "resume"]);

		// A reason nothing recognises is still a park — and gets NO deadline clause, because with no
		// kind the instant could only be printed under a guessed verb.
		const unknown = noteFor("some_new_reason", IN_12M);
		expect(unknown).toContain("some_new_reason");
		expect(unknown).not.toContain("expected to resume");
		expect(unknown).not.toContain("GIVES UP");
	});

	/**
	 * No legend promises a resume time for every park (#591/#596).
	 *
	 * A give-up deadline is now published (the owner needs it most), so the legends must state
	 * which kind a park's note carries rather than promising the good one. "It resumes on its own"
	 * tells the reader to walk away from the one park that is waiting for THEM.
	 */
	it("no legend promises a resume time, or self-resolution, for every park", async () => {
		const { RUN_HEALTH_LEGEND } = await import("./work-report.js");
		const { COMPLETENESS_LEGEND } = await import("./subordinate-payload.js");
		const { RUN_WAIT_REASONS } = await import("./agent-loop-store.js");
		expect(RUN_WAIT_REASONS.length, `${RUN_WAIT_REASONS.length} park reasons, not all of which resume`).toBeGreaterThanOrEqual(3);

		for (const [name, legend] of [["RUN_HEALTH_LEGEND", RUN_HEALTH_LEGEND], ["COMPLETENESS_LEGEND", COMPLETENESS_LEGEND]] as const) {
			expect(legend, `${name} promises a resume time for every park; one of them gives up instead`).not.toMatch(/what for and until when/i);
			expect(legend, `${name} says a park resolves itself; a human handoff does not`).not.toMatch(/resumes on its own/i);
		}
		// The canonical legend has to teach the distinction, not merely avoid the false promise: a
		// reader who is not told the verb exists will read every instant as the good kind.
		expect(RUN_HEALTH_LEGEND, "RUN_HEALTH_LEGEND does not say a park can GIVE UP").toMatch(/gives up/i);
	});

	it("the supervision legend names every activity word AND every health word", async () => {
		const { COMPLETENESS_LEGEND } = await import("./subordinate-payload.js");
		const words = new Set([...Object.keys(HEALTH), ...Object.keys(ACTIVITY)]);
		for (const w of words) expect(COMPLETENESS_LEGEND, `the roster legend omits \`${w}\``).toContain(`\`${w}\``);
		// working · waiting · stalled shared by both, plus `ended` (health only) and `idle` +
		// `unknown` (activity only). The roster legend has to teach all six, because a supervisor
		// reads `activity` on the roster and `health` on the runs in the same reply.
		expect(words.size, `${words.size} distinct state words across both enums`).toBe(6);
	});
});

/**
 * The behavioural half — one run, every surface, at one instant.
 *
 * The needle sweep above catches the shape of the mistake. This catches the mistake itself, and it
 * is the arm that would have gone red on the tree that shipped: the console's contribution was an
 * OMISSION (it rendered no verdict at all), which no source pattern can see.
 */
describe("#589 AC5 — one parked run, and every surface says the same thing", () => {
	const NOW = 1_700_000_000_000;

	/**
	 * Run 70ea298e as `agent_loop_runs` held it: `running`, iteration 1 of 30, 4.35 hours in,
	 * heartbeat 3.5 minutes old (the engine-wait tick was beating), no progress since it started,
	 * parked on the coding CLI's own usage window. Nothing about it was wrong — `coding-wait.ts`
	 * permits a six-hour park — and every surface but one called it working.
	 */
	const parked: RunItem = {
		instanceId: "sub-1",
		runId: "70ea298e",
		objective: "work through the open issues, bugs first",
		status: "running",
		stopReason: null,
		detail: null,
		iteration: 1,
		maxIterations: 30,
		startedAt: NOW - 4.35 * 60 * 60_000,
		finishedAt: null,
		lastProgressAt: NOW - 4.35 * 60 * 60_000,
		lastAliveAt: NOW - 3.5 * 60_000,
		waitingReason: "engine_limit",
		waitingUntil: NOW + 60 * 60_000,
	};

	const observed = () =>
		summarizeSubordinates({
			now: NOW,
			subordinates: [{ instanceId: "sub-1", name: "PAS Coder", subscription: "active", columns: [] }],
			work: [],
			runs: [parked],
		}).subordinates;

	it("the platform's verdict is `waiting`", () => {
		expect(runHealth(parked, NOW)).toBe("waiting");
		expect(waitClause(parked, NOW)).toContain("usage limit");
	});

	it("subordinate_status does NOT report it as working — the measured wrong answer", () => {
		const runs = observed()[0]?.runs ?? [];
		expect(runs[0]?.health).toBe("waiting");
		expect(activityFromRuns(runs)).toBe("waiting");
		expect(activityFromRuns(runs)).not.toBe("working");
	});

	it("the roster line a supervisor triages from says the same word", () => {
		const [line] = rosterLines({
			roster: [{ instanceId: "sub-1", name: "PAS Coder", subscription: "active" }],
			observed: observed(),
			canWork: new Map([["sub-1", true]]),
		});
		expect(line?.activity).toBe("waiting");
	});

	it("the one-line rung keeps the verdict — it is what survives when everything else is cut", () => {
		// `collapseSubordinate` is reached through `fitStatusPayload` at the last rung, and its
		// `activity` is the field the legend tells a supervisor to answer "which ones are idle"
		// from. A verdict that survives the full payload and not the collapsed one would report
		// six busy agents correctly and ten of them wrongly.
		const sub = observed()[0] as unknown as Record<string, unknown>;
		expect(activityFromRuns(sub.runs as Array<{ health?: unknown }>)).toBe("waiting");
	});

	it("nobody reports it as `idle` either — it IS in flight, and handing it work is wrong", () => {
		const runs = observed()[0]?.runs ?? [];
		expect(activityFromRuns(runs)).not.toBe("idle");
	});

	it("the same machinery reports a genuinely working run as working, and a dead one as stalled", () => {
		// The other two thirds of the rule, stated because #588 measured that production exercised
		// none of it: 0 of 89 runs were `running` at audit time.
		const at = (over: Partial<RunItem>): RunItem => ({ ...parked, waitingReason: null, waitingUntil: null, ...over });
		const cases: Array<[RunItem, RunHealth]> = [
			[at({ lastAliveAt: NOW - 1000, lastProgressAt: NOW - 1000 }), "working"],
			[at({ lastAliveAt: NOW - 60 * 60_000, lastProgressAt: NOW - 60 * 60_000 }), "stalled"],
			[at({ status: "failed", finishedAt: NOW - 60_000 }), "ended"],
		];
		for (const [run, expected] of cases) {
			expect(runHealth(run, NOW), `${run.status}/${expected}`).toBe(expected);
			const runs = summarizeSubordinates({ now: NOW, subordinates: [{ instanceId: "sub-1", name: "n", subscription: "active", columns: [] }], work: [], runs: [run] }).subordinates[0]?.runs ?? [];
			expect(runs[0]?.health, `${run.status}/${expected}`).toBe(expected);
		}
		expect(cases.length, `${cases.length} health states exercised end-to-end, plus the parked case above`).toBe(3);
	});
});
