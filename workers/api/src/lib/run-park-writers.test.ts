/**
 * Every field of a park is written by a PRODUCTION call site, not only by a helper test (#591 AC4).
 *
 * ── The defect class, which has now shipped twice
 *
 * `recordLiveness`'s `until` parameter was implemented, bound into the UPDATE, and covered by
 * `run-liveness.test.ts:166`. All three production call sites passed a `reason` and no `until`, so
 * `agent_loop_runs.waiting_until` read **null on 89 of 89 runs** — including one parked 6h51m by its
 * own wall clock — while `planEngineWait` had already computed the instant and `coding-wait.ts` was
 * already printing it into the owner's chat. The column read as implemented; nothing populated it.
 *
 * #570 is the same shape (a helper taking an argument its callers never pass) and #583 is the same
 * shape one level up (a verdict computed and recorded for a reader that does not exist). A test that
 * supplies an argument by hand cannot see any of them: it is the one caller that always passes it.
 *
 * ── So the guard is TWO-SIDED, and neither side is sufficient alone
 *
 * 1. **The module that KNOWS the instant hands it over.** `coding-pause.ts` is the only place
 *    `plan.until` exists, so the seam is `deps.tick`. Driven for real below, through `resolvePause`,
 *    with every effect stubbed — the same way the pause machine is already tested.
 * 2. **The production call site CONSUMES it**, with the denominator stated per ADR 0002. Sources are
 *    read from disk and every `recordLiveness` call site is enumerated; a site that parks without an
 *    `until` has to be NAMED, with the reason there is no knowable end. That is the arm a hand-written
 *    fixture cannot fake, and it is the one that was missing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { recordLiveness } from "./agent-loop-store.js";
import { HANDOFF_GIVE_UP_MS, resolvePause, type PauseDeps } from "./coding-pause.js";
import { realSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, "..", rel), "utf8");

// ── 1. The module that knows the instant hands it over ───────────────────────

function pauseDeps(over: Partial<PauseDeps> = {}): PauseDeps {
	return {
		repo: "demo",
		takeover: vi.fn(async () => undefined),
		takeoverStatus: vi.fn(async () => ({ resolved: true, value: "ok" })),
		endTakeover: vi.fn(async () => undefined),
		sleep: vi.fn(async () => undefined),
		notify: vi.fn(async () => undefined),
		announce: vi.fn(async () => undefined),
		card: vi.fn(async () => undefined),
		tick: vi.fn(async () => true),
		now: () => 1_000_000,
		...over,
	};
}

describe("the pause machine hands the park's END to the heartbeat", () => {
	it("an engine-limit park ticks WITH the instant it computed", async () => {
		const deps = pauseDeps();
		const resetsAt = new Date(1_000_000 + 90 * 60_000).toISOString();
		await resolvePause(deps, {
			round: 1,
			result: { outcome: "waiting", detail: "usage limit", steps: 1, waitUntil: resetsAt },
			state: { waits: 0, spentMs: 0 },
		});
		const calls = (deps.tick as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.length, "the park heartbeats at least once").toBeGreaterThan(0);
		// Before #591 every one of these was `tick()` with no argument, so the instant died here.
		for (const [park] of calls) {
			expect(park?.until, "every tick restates the end, so a replayed park cannot blank it").toBeGreaterThan(1_000_000);
		}
	});

	it("a human handoff ticks WITH its give-up instant, which is the deadline the owner can beat", async () => {
		// The inversion #596 argues for. This park publishes nothing until now, on the grounds that
		// `waiting_until` was rendered unconditionally as "expected to resume in …" — true of the
		// engine park, and a lie here, where the instant is when the run STOPS waiting for the
		// reader. The renderer now reads the KIND off the park reason, so withholding the instant no
		// longer protects anybody: it hides the only deadline anyone can still act on.
		let polls = 0;
		// A clock the sleeps actually move, because the property under test is about elapsed time:
		// `step.sleep` really does advance the wall clock by what it was asked to wait, and a frozen
		// `now()` would measure the fixture rather than the rule.
		let clock = 1_000_000;
		const deps = pauseDeps({
			now: () => clock,
			sleep: vi.fn(async (_label: string, ms: number) => {
				clock += ms;
			}),
			takeoverStatus: vi.fn(async () => ({ resolved: ++polls > 20, value: "v" })),
		});
		await resolvePause(deps, {
			round: 1,
			result: { outcome: "stuck", detail: "a widget", steps: 1 },
			state: { waits: 0, spentMs: 0 },
		});
		const calls = (deps.tick as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		// EXACTLY the instant the loop gives up at — 15 minutes after the wait opened — restated
		// identically by every tick. Computed from the polls REMAINING, so it cannot slide: a
		// deadline captured once before the loop would move a whole wait on a Workflow replay, and
		// one computed as `now + 15min` per tick would never arrive at all.
		const instants = new Set(calls.map(([park]) => park?.until));
		expect(instants.size, `${instants.size} distinct give-up instants across ${calls.length} ticks`).toBe(1);
		expect([...instants][0], "the published instant is not the moment the loop actually stops waiting").toBe(1_000_000 + HANDOFF_GIVE_UP_MS);
	});
});

// ── 2. The production call sites consume it, over the whole enumerated set ────

/**
 * Files that call `recordLiveness` in production. Read from disk, and the count is ASSERTED — a
 * moved or renamed driver must fail as "this guard stopped measuring", never as a clean tree.
 */
const LIVENESS_SOURCES = ["workflows/coding-session.ts"];

/** One `recordLiveness(...)` call, as written. Every site in this repo is a single line. */
function livenessCallSites(): { file: string; line: number; text: string }[] {
	const out: { file: string; line: number; text: string }[] = [];
	for (const file of LIVENESS_SOURCES) {
		read(file)
			.split("\n")
			.forEach((text, i) => {
				if (text.includes("recordLiveness(") && !text.trimStart().startsWith("*")) out.push({ file, line: i + 1, text });
			});
	}
	return out;
}

/**
 * Call sites that park WITHOUT a knowable end, each with the reason. A named list, not a pattern:
 * adding a park must not be able to exempt itself, which is exactly how `until` went unwritten.
 */
const NO_KNOWN_END: Record<string, string> = {
	platform_interrupt:
		"our own deploy evicted the isolate; Cloudflare replays the journal when it replays it, and there is no instant to state (#583)",
};

describe("every park field has a production writer", () => {
	it("measures every recordLiveness call site, and says how many", () => {
		const sites = livenessCallSites();
		// The denominator. Three sites today: one clear, one park with a knowable end, one without.
		expect(sites.length, `${sites.length} recordLiveness call site(s) across ${LIVENESS_SOURCES.length} source file(s)`).toBe(3);
	});

	it("a site that parks either states its end or is named as having none", () => {
		const sites = livenessCallSites();
		const parks = sites.filter((s) => s.text.includes("reason:"));
		expect(parks.length, `${parks.length} of ${sites.length} sites park (the rest clear)`).toBe(2);
		for (const site of parks) {
			const exempt = Object.keys(NO_KNOWN_END).find((k) => site.text.includes(k));
			if (exempt) continue;
			expect(site.text, `${site.file}:${site.line} parks without an \`until\` and is not named in NO_KNOWN_END`).toContain("until:");
		}
	});

	it("EVERY optional park field is supplied by at least one production call site", () => {
		// The general property #591 AC4 states, and the one a helper test cannot check: a field that
		// only ever receives a value from a test is a field with no production writer. `until` had
		// exactly that status, and this arm is what fails on the tree that shipped it.
		const text = livenessCallSites()
			.map((s) => s.text)
			.join("\n");
		const PARK_FIELDS = ["reason", "until"] as const;
		for (const field of PARK_FIELDS) {
			expect(text, `no production call site ever supplies \`${field}\``).toContain(`${field}:`);
		}
		expect(PARK_FIELDS.length, `${PARK_FIELDS.length} optional park fields measured`).toBe(2);
	});

	it("every exemption names a reason that appears in the code it exempts", () => {
		const text = livenessCallSites()
			.map((s) => s.text)
			.join("\n");
		for (const reason of Object.keys(NO_KNOWN_END)) {
			expect(text, `exemption for a park nothing writes: ${reason}`).toContain(reason);
		}
	});
});

// ── 3. …and the column actually takes it, against the real schema ────────────

describe("the column stores what the park hands it", () => {
	it("an until written by the heartbeat is readable, and a clear removes it", async () => {
		const db = realSchemaD1();
		seedTenant(db, { userId: "u1", instanceIds: ["i1"] });
		db.exec(
			"INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at) VALUES ('r1','u1','i1','x','running',1,10,1)",
		);
		const env = { DB: db.DB } as unknown as Env;
		const until = 1_000_000 + 6 * 3_600_000;
		await recordLiveness(env, "r1", 2_000, { reason: "engine_limit", until });
		const parked = await db.DB.prepare("SELECT waiting_reason, waiting_until FROM agent_loop_runs WHERE run_id='r1'").first<{
			waiting_reason: string | null;
			waiting_until: number | null;
		}>();
		expect(parked).toEqual({ waiting_reason: "engine_limit", waiting_until: until });
		await recordLiveness(env, "r1", 3_000, null);
		const cleared = await db.DB.prepare("SELECT waiting_until FROM agent_loop_runs WHERE run_id='r1'").first<{ waiting_until: number | null }>();
		expect(cleared?.waiting_until).toBeNull();
	});
});
