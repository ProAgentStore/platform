import { describe, expect, it } from "vitest";
import { IDLE_SESSION_MS, ORPHAN_QUIET_MS, sweepCodingSessions, trackedSessionIds } from "./coding-session-sweeper.js";
import type { Env } from "../types.js";

describe("trackedSessionIds (#275)", () => {
	it("returns null when the runner's answer has no `tracked` array", () => {
		// THE dangerous case. `reconcileOrphanedSessions` ends every active session NOT in the set
		// it is given, so an unrecognised reply degrading to `[]` means "end everything". Opening
		// the diagnostics panel could trip that once; a cron would trip it every minute forever.
		expect(trackedSessionIds(null)).toBeNull();
		expect(trackedSessionIds(undefined)).toBeNull();
		expect(trackedSessionIds({})).toBeNull();
		expect(trackedSessionIds({ tracked: "nope" })).toBeNull();
		expect(trackedSessionIds({ error: "unknown path" })).toBeNull();
	});

	it("distinguishes a runner tracking nothing from a runner that did not answer", () => {
		// An EMPTY array is a real answer ("I hold no sessions") and must reconcile; only an
		// absent one is a skip. Collapsing the two would make the reaper unable to clean up after
		// a runner restart, which is the case it exists for.
		expect(trackedSessionIds({ tracked: [] })).toEqual([]);
	});

	it("keeps only well-formed session ids", () => {
		expect(trackedSessionIds({ tracked: [{ sessionId: "a" }, {}, { sessionId: 7 }, { sessionId: "b" }] })).toEqual(["a", "b"]);
	});
});

interface Call { sql: string; args: unknown[] }

/**
 * D1 + relay stub. `idle` feeds the reap query, `quiet` the reconcile query, and `tracked` is what
 * the fake runner reports from /coding/diagnostics.
 */
function stub(opts: {
	idle?: Array<{ id: string; instance_id: string; user_id: string; repo_id: string; runner_node: string | null }>;
	quiet?: Array<{ instance_id: string; user_id: string }>;
	diagnostics?: unknown;
	/** No relay socket → getBoundRunnerConn resolves null. */
	connected?: boolean;
}) {
	const calls: Call[] = [];
	const runnerCalls: Array<{ path: string; body: unknown }> = [];
	const connected = opts.connected !== false;
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async all() {
							calls.push({ sql, args });
							if (sql.includes("SELECT id, instance_id, user_id, repo_id, runner_node")) return { results: opts.idle ?? [] };
							if (sql.includes("SELECT DISTINCT instance_id, user_id")) return { results: opts.quiet ?? [] };
							return { results: [] };
						},
						async first() {
							calls.push({ sql, args });
							// getRunnerConn's registration lookup.
							if (sql.includes("endpoint_url")) return connected ? { endpoint_url: "https://runner.local", token_plaintext: "t", runner_node: "mac" } : null;
							return null;
						},
						async run() {
							calls.push({ sql, args });
							return { meta: { changes: 1 } };
						},
					};
				},
			};
		},
	};
	const env = {
		DB,
		RELAY: {
			idFromName: (n: string) => n,
			get: () => ({
				async fetch(req: Request) {
					if (req.url.endsWith("/status")) return new Response(JSON.stringify({ connected }));
					const body = (await req.json()) as { path: string; body: unknown };
					runnerCalls.push({ path: body.path, body: body.body });
					if (body.path === "/coding/diagnostics") return new Response(JSON.stringify(opts.diagnostics ?? {}));
					return new Response(JSON.stringify({ ok: true }));
				},
			}),
		},
	} as unknown as Env;
	return { env, calls, runnerCalls };
}

describe("sweepCodingSessions — idle reaping (#275)", () => {
	it("stops the ENGINE on the machine before closing the row", async () => {
		// Closing only the D1 row tidies the database and leaves a live
		// `claude --dangerously-skip-permissions` child process resident on the user's laptop —
		// which IS the leak. The runner call is the point of the sweep, not a nicety.
		const { env, runnerCalls, calls } = stub({
			idle: [{ id: "csess_1", instance_id: "inst", user_id: "u", repo_id: "r", runner_node: "mac" }],
		});
		const res = await sweepCodingSessions(env, Date.now());
		expect(res.reaped).toBe(1);
		expect(runnerCalls.find((c) => c.path === "/coding/end")).toMatchObject({ body: { sessionId: "csess_1" } });
		expect(calls.some((c) => c.sql.includes("SET status = ?4") && c.args.includes("ended"))).toBe(true);
	});

	it("still closes the row when the machine is gone", async () => {
		// A session whose runner is offline has no process left to stop, but its row must stop
		// claiming to be active — that stale `active` is what `ensureActiveSession` hands back and
		// what connectivity reporting shows as a session that is not really there.
		const { env, runnerCalls } = stub({
			idle: [{ id: "csess_1", instance_id: "inst", user_id: "u", repo_id: "r", runner_node: "mac" }],
			connected: false,
		});
		const res = await sweepCodingSessions(env, Date.now());
		expect(res.reaped).toBe(1);
		expect(runnerCalls.find((c) => c.path === "/coding/end")).toBeUndefined();
	});

	it("asks for sessions quiet for the full idle window, not for any quiet session", async () => {
		// The cutoff is the policy. A sweep that passed `now` would reap every session on earth.
		const now = 1_800_000_000_000;
		const { env, calls } = stub({});
		await sweepCodingSessions(env, now);
		const reap = calls.find((c) => c.sql.includes("SELECT id, instance_id, user_id, repo_id, runner_node"));
		expect(reap?.args[0]).toBe(now - IDLE_SESSION_MS);
		const reconcile = calls.find((c) => c.sql.includes("SELECT DISTINCT instance_id, user_id"));
		expect(reconcile?.args[0]).toBe(now - ORPHAN_QUIET_MS);
	});

	it("keeps the idle window generous enough that no legitimate silence trips it", () => {
		// A Pilot parked in a human handoff waits 15 minutes per round, up to 12 rounds — three
		// hours of legitimate quiet before the run even gives up. The window has to clear that with
		// room, because reaping early destroys a live CLI context that cannot be recovered.
		expect(IDLE_SESSION_MS).toBeGreaterThan(3 * 60 * 60_000);
	});
});

describe("sweepCodingSessions — orphan reconcile (#275)", () => {
	it("does not reconcile an instance whose runner is offline", async () => {
		// "Not tracked" carries no information when there is nothing there to track. Reconciling
		// here would end every session of every laptop that closed its lid.
		const { env, runnerCalls } = stub({ quiet: [{ instance_id: "inst", user_id: "u" }], connected: false });
		const res = await sweepCodingSessions(env, Date.now());
		expect(res.reconciled).toBe(0);
		expect(runnerCalls).toHaveLength(0);
	});

	it("skips — rather than reaping everything — when the runner's reply is unrecognisable", async () => {
		// An older runner, a partial reply or a shape change all produce a body with no `tracked`.
		// Treating that as "the runner holds nothing" would end every active session on that
		// machine, every single minute.
		const { env, calls } = stub({ quiet: [{ instance_id: "inst", user_id: "u" }], diagnostics: { error: "unknown path" } });
		const res = await sweepCodingSessions(env, Date.now());
		expect(res.skipped).toBe(1);
		expect(res.reconciled).toBe(0);
		expect(calls.some((c) => c.sql.includes("updated_at < datetime('now', '-3 minutes')"))).toBe(false);
	});

	it("reconciles against the ids a healthy runner reports", async () => {
		const { env, calls } = stub({
			quiet: [{ instance_id: "inst", user_id: "u" }],
			diagnostics: { tracked: [{ sessionId: "csess_live" }] },
		});
		await sweepCodingSessions(env, Date.now());
		expect(calls.some((c) => c.sql.includes("updated_at < datetime('now', '-3 minutes')"))).toBe(true);
	});
});
