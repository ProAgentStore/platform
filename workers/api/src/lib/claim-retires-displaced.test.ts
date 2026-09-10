/**
 * Stealing a session's driver claim RETIRES the run it displaces (#790, symptom 3).
 *
 * ── The defect
 *
 * `claimSessionDriver` takes a claim whose `driver_at` is older than `STALE_DRIVER_MS`, and it used
 * to do that silently: the UPDATE matched, `true` came back, and the run that had been holding the
 * claim was left `status = 'running'` with nothing left to close it. The session then had TWO
 * officially-running runs — and because `ensureActiveSession` reuses a session that is still
 * `active`, the new Pilot attached to the same tmux pane the old engine was sitting in. That is what
 * the incident observed as "the original stuck run's engine went back to `working`" after a second
 * `coding_loop_start`.
 *
 * ── What is asserted, and why the ORDER matters most
 *
 * The retire is scoped to runs on this session that are still `running`, and it is safe only because
 * all three callers claim BEFORE creating their own run row. A caller that ever creates its run row
 * first would retire itself the instant it started — a far worse bug than the one being fixed, and
 * invisible except as "my run ended immediately for no reason". The last test in this file reads the
 * three call sites and pins that ordering, because no unit test of this function can see it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { STALE_DRIVER_MS, claimSessionDriver } from "./coding-store.js";
import type { Env } from "../types.js";

const NOW_ISH = () => Date.now();

interface Stmt {
	sql: string;
	args: unknown[];
}

/**
 * D1 stub. `heldBy` is what the pre-steal SELECT reads back, `claimed` whether the UPDATE matched.
 * Every statement is recorded so the test can assert what ran AND in what order.
 */
function stubEnv(opts: { heldBy?: string | null; claimed?: boolean } = {}) {
	const statements: Stmt[] = [];
	const env = {
		DB: {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async first() {
								statements.push({ sql, args });
								return { driver_id: opts.heldBy ?? null };
							},
							async run() {
								statements.push({ sql, args });
								return { meta: { changes: opts.claimed === false ? 0 : 1 } };
							},
						};
					},
				};
			},
		},
	} as unknown as Env;
	return { env, statements };
}

const retireOf = (statements: Stmt[]) => statements.find((s) => s.sql.includes("UPDATE agent_loop_runs"));

describe("claimSessionDriver retires the run it displaces", () => {
	it("closes the previous holder's run when it steals the claim", async () => {
		const { env, statements } = stubEnv({ heldBy: "driver-old", claimed: true });
		expect(await claimSessionDriver(env, "inst-1", "user-1", "sess-1", "driver-new")).toBe(true);

		const retire = retireOf(statements);
		expect(retire, "a steal must retire what it displaced").toBeDefined();
		// `interrupted` (#546) — the platform cut the invocation off and the objective never reported
		// either way — which `statusFor` puts in `needs_human`. The honest column: the displaced run
		// may have pushed commits before it wedged, so somebody should look.
		expect(retire?.sql).toContain("status = 'needs_human'");
		expect(retire?.sql).toContain("stop_reason = 'interrupted'");
		expect(retire?.args.slice(0, 3)).toEqual(["sess-1", "inst-1", "user-1"]);
		expect(String(retire?.args[3])).toContain("newer run took over its session");
	});

	it("scopes the retire to this session, this instance, this owner, and only RUNNING rows", async () => {
		// Every clause is load-bearing. Without `status = 'running'` a steal would rewrite the
		// finished runs of every earlier objective on the same session, destroying their outcomes.
		const { env, statements } = stubEnv({ heldBy: "driver-old", claimed: true });
		await claimSessionDriver(env, "inst-1", "user-1", "sess-1", "driver-new");
		const sql = retireOf(statements)?.sql ?? "";
		expect(sql).toContain("session_id = ?1");
		expect(sql).toContain("instance_id = ?2");
		expect(sql).toContain("user_id = ?3");
		expect(sql).toContain("status = 'running'");
	});

	it("retires NOTHING when the session was free", async () => {
		// Claiming an unheld session displaces nobody. Retiring here would close a run that has every
		// right to be running — one on a DIFFERENT session of the same instance, say.
		const { env, statements } = stubEnv({ heldBy: null, claimed: true });
		expect(await claimSessionDriver(env, "inst-1", "user-1", "sess-1", "driver-new")).toBe(true);
		expect(retireOf(statements)).toBeUndefined();
	});

	it("retires NOTHING when the same driver re-claims its own session", async () => {
		// A live Pilot re-claiming its own claim is the heartbeat path, and it runs constantly.
		// Retiring there would have every run kill itself on its own next tick.
		const { env, statements } = stubEnv({ heldBy: "driver-same", claimed: true });
		expect(await claimSessionDriver(env, "inst-1", "user-1", "sess-1", "driver-same")).toBe(true);
		expect(retireOf(statements)).toBeUndefined();
	});

	it("retires NOTHING when the claim was REFUSED", async () => {
		// The claim is still someone else's and that someone is alive. Ending their run because we
		// failed to take it from them would turn a correct 409 into a kill.
		const { env, statements } = stubEnv({ heldBy: "driver-old", claimed: false });
		expect(await claimSessionDriver(env, "inst-1", "user-1", "sess-1", "driver-new")).toBe(false);
		expect(retireOf(statements)).toBeUndefined();
	});

	it("reads the current holder BEFORE the steal, or the fact is already gone", async () => {
		// After the UPDATE the column says `driver-new`, and "a claim was taken from somebody" is
		// unrecoverable. Order is the only thing that makes the steal detectable at all.
		const { env, statements } = stubEnv({ heldBy: "driver-old", claimed: true });
		await claimSessionDriver(env, "inst-1", "user-1", "sess-1", "driver-new");
		const read = statements.findIndex((s) => s.sql.includes("SELECT driver_id"));
		const steal = statements.findIndex((s) => s.sql.includes("UPDATE coding_sessions"));
		expect(read).toBeGreaterThanOrEqual(0);
		expect(read).toBeLessThan(steal);
		expect(steal).toBeLessThan(statements.findIndex((s) => s.sql.includes("UPDATE agent_loop_runs")));
	});

	it("still only takes a claim that has gone stale", async () => {
		// The steal condition itself is unchanged — this ticket adds a consequence to it, not a new
		// licence to take a live claim.
		const { env, statements } = stubEnv({ heldBy: "driver-old", claimed: true });
		const before = NOW_ISH();
		await claimSessionDriver(env, "inst-1", "user-1", "sess-1", "driver-new");
		const steal = statements.find((s) => s.sql.includes("UPDATE coding_sessions"));
		expect(steal?.sql).toContain("driver_at < ?6");
		expect(Number(steal?.args[5])).toBeGreaterThanOrEqual(before - STALE_DRIVER_MS - 5_000);
		expect(Number(steal?.args[5])).toBeLessThanOrEqual(Date.now() - STALE_DRIVER_MS + 5_000);
	});
});

describe("every caller claims BEFORE it creates its run row", () => {
	// The precondition the retire depends on, asserted over the SOURCE because no unit test of
	// `claimSessionDriver` can see it. A caller that created its run row first would be retired by
	// its own claim — which presents as "my run ended instantly for no reason" and would be
	// extremely hard to trace back to here.
	// Each entry names the ENCLOSING declaration, because every one of these files also creates runs
	// in a function that never claims — `chatDriver` has no session at all, and both route files have
	// a sibling handler. Searching the whole file would compare a claim in one function against a
	// create in another and prove nothing.
	const CALLERS = [
		{
			file: "lib/loop-drivers.ts",
			path: new URL("./loop-drivers.ts", import.meta.url).pathname,
			from: "const codingDriver",
			create: "createLoopRun(",
		},
		{
			file: "routes/coding-brains.ts",
			path: new URL("../routes/coding-brains.ts", import.meta.url).pathname,
			from: "async function delegateToTarget",
			create: "CODING_SESSION.create(",
		},
		{
			file: "routes/coding-drive.ts",
			path: new URL("../routes/coding-drive.ts", import.meta.url).pathname,
			from: '/:instanceId/coding/sessions/:sessionId/run',
			create: "CODING_SESSION.create(",
		},
	];

	for (const c of CALLERS) {
		it(`${c.file} claims before it creates its run`, () => {
			const whole = readFileSync(c.path, "utf8");
			const anchor = whole.indexOf(c.from);
			expect(anchor, `${c.file} should still contain ${c.from}`).toBeGreaterThan(-1);
			const src = whole.slice(anchor);
			const claim = src.indexOf("claimSessionDriver(");
			const create = src.indexOf(c.create);
			expect(claim, `${c.file} should call claimSessionDriver`).toBeGreaterThan(-1);
			expect(create, `${c.file} should create a run`).toBeGreaterThan(-1);
			expect(claim, `${c.file} must claim before it creates its run row`).toBeLessThan(create);
		});
	}
});
