import { describe, expect, it } from "vitest";
import {
	IDLE_REAP_PREFIX,
	IDLE_SESSION_MS,
	LEGACY_IDLE_REAP_PREFIXES,
	ORPHAN_QUIET_MS,
	SLEEP_NOTIFY_KEY,
	type SleptRepo,
	idleReapNotice,
	lastIdleReapForRepo,
	resumeDeadlineFor,
	sleepNotification,
	sweepCodingSessions,
	trackedSessionIds,
} from "./coding-session-sweeper.js";
import { RESUME_WINDOW_MS } from "./coding-session-continuity.js";
import { notificationDedupeKey } from "./notifications.js";
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

interface IdleRow {
	id: string;
	instance_id: string;
	user_id: string;
	repo_id: string;
	runner_node: string | null;
	client_type?: string;
	last_activity_at?: number | null;
	repo_name?: string | null;
	instance_name?: string | null;
}

/**
 * D1 + relay stub. `idle` feeds the reap query, `quiet` the reconcile query, and `tracked` is what
 * the fake runner reports from /coding/diagnostics.
 */
function stub(opts: {
	idle?: IdleRow[];
	quiet?: Array<{ instance_id: string; user_id: string }>;
	diagnostics?: unknown;
	/** No relay socket → getBoundRunnerConn resolves null. */
	connected?: boolean;
	/** Runner is there but refuses to stop the engine — the case the timeline used to lie about. */
	endFails?: boolean;
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
							if (sql.includes("FROM coding_sessions s")) return { results: opts.idle ?? [] };
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
					if (opts.endFails && body.path === "/coding/end") return new Response("engine busy", { status: 500 });
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

	it("does not write 'the engine process was released' when the stop FAILED (#325)", async () => {
		// The two cases the swallow made indistinguishable: an offline machine (nothing of ours is
		// left to stop) and a connected machine whose /coding/end failed (the child process is
		// still resident — the leak the docstring excludes). The row closes either way, but the
		// timeline is the session's own durable record and it survives the session it describes,
		// so it may only claim a stop that actually happened.
		const { env, calls } = stub({
			idle: [{ id: "csess_1", instance_id: "inst", user_id: "u", repo_id: "r", runner_node: "mac" }],
			endFails: true,
		});
		expect((await sweepCodingSessions(env, Date.now())).reaped).toBe(1);
		const said = calls.flatMap((c) => c.args).filter((a): a is string => typeof a === "string" && a.startsWith(IDLE_REAP_PREFIX));
		expect(said.join(" ")).toMatch(/may still be running/i);
		expect(said.join(" ")).not.toMatch(/was released/i);
	});

	it("asks for sessions quiet for the full idle window, not for any quiet session", async () => {
		// The cutoff is the policy. A sweep that passed `now` would reap every session on earth.
		const now = 1_800_000_000_000;
		const { env, calls } = stub({});
		await sweepCodingSessions(env, now);
		const reap = calls.find((c) => c.sql.includes("FROM coding_sessions s"));
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

describe("the sleep notification (#698)", () => {
	const HOUR = 3_600_000;
	const LAST = Date.UTC(2026, 7, 16, 1, 11); // 2026-08-16 01:11 UTC
	const repo = (over: Partial<SleptRepo> = {}): SleptRepo => ({
		instanceId: "inst-1",
		instanceName: "Chess coder 2",
		repoName: "apps/chess-academy",
		keptUntil: LAST + RESUME_WINDOW_MS,
		strayProcess: false,
		...over,
	});

	it("says until WHEN the work is resumable, not that something ended", () => {
		// The whole point of the notification. "A session ended" is our lifecycle; "your
		// conversation is kept until X" is the only part of it the user can act on, and it is
		// computable — RESUME_WINDOW_MS from the same `last_activity_at` the reaper measured
		// idleness against.
		const n = sleepNotification([repo()], "Australia/Melbourne");
		expect(n?.title).toBe("😴 Chess coder 2 went to sleep");
		expect(n?.body).toContain("apps/chess-academy");
		expect(n?.body).toMatch(/Your conversation is kept until Thu 20 Aug/);
		expect(n?.title).not.toMatch(/session/i);
		expect(n?.body).not.toMatch(/session/i);
	});

	it("names the TIME as well as the date, so the promise is one it can keep", () => {
		// "Kept until 20 Aug" is the tempting form and it is a broken promise: the window expires at
		// an instant, 11:11 Melbourne in this fixture, so a user coming back that evening would find
		// the conversation gone having been told it would be there.
		expect(sleepNotification([repo()], "Australia/Melbourne")?.body).toMatch(/Thu 20 Aug, 11:11/);
	});

	it("falls back to UTC and SAYS UTC when the owner has set no zone", () => {
		// `accountTimeZone` returns undefined for "nobody has told us", which is a first-class
		// state — a silently-assumed zone is a ten-hour error in this product's own timezone.
		expect(sleepNotification([repo()], undefined)?.body).toMatch(/Thu 20 Aug, 01:11 UTC/);
		// An invalid stored zone must not lose the notification over a label.
		expect(sleepNotification([repo()], "Mars/Olympus")?.body).toMatch(/UTC/);
	});

	it("promises nothing about a raw engine, which has no conversation to keep", () => {
		// Codex/Grok/a custom command are spawned raw and their "history" is whatever scrolled past
		// on stdout. Telling those users their conversation is safe is a confident false statement
		// at the exact moment they are deciding whether to write their context down.
		const n = sleepNotification([repo({ keptUntil: null })], "UTC");
		expect(n?.body).not.toMatch(/kept until/);
		expect(n?.body).toContain("apps/chess-academy");
	});

	it("derives that from the continuity policy rather than a second copy of it", () => {
		// `resumeDeadlineFor` asks `resolveSessionContinuity` the same question the next open will
		// ask. A local `clientType === "claude"` would be right today and silently wrong the moment
		// another engine grows a resume protocol.
		expect(resumeDeadlineFor({ id: "csess_1", clientType: "claude", lastActivityAt: LAST })).toBe(LAST + RESUME_WINDOW_MS);
		expect(resumeDeadlineFor({ id: "csess_1", clientType: "codex", lastActivityAt: LAST })).toBeNull();
		// A legacy row with no stamp: unknown age is not "recent", and a deadline cannot be invented.
		expect(resumeDeadlineFor({ id: "csess_1", clientType: "claude", lastActivityAt: null })).toBeNull();
	});

	it("batches one owner's whole sweep into ONE notification", () => {
		// THE judgement call the issue leaves open. People stop working all at once, so one
		// evening's repos idle out in the same per-minute tick; three separate 3am pings is the
		// failure mode, and batching here is what turns them into one.
		const n = sleepNotification(
			[
				repo({ repoName: "chess-academy" }),
				repo({ repoName: "site-monitor" }),
				repo({ instanceId: "inst-2", instanceName: "Repo coder", repoName: "platform" }),
			],
			"UTC",
		);
		expect(n?.title).toBe("😴 2 agents went to sleep");
		expect(n?.body).toContain("chess-academy, site-monitor and platform");
		// Several instances have no single page to link, so it links nowhere rather than somewhere
		// arbitrary.
		expect(n?.url).toBeUndefined();
	});

	it("counts agents, not repos, and links the one there is", () => {
		const n = sleepNotification([repo({ repoName: "a" }), repo({ repoName: "b" })], "UTC");
		expect(n?.title).toBe("😴 Chess coder 2 went to sleep on 2 repos");
		expect(n?.body).toMatch(/Your conversations are kept until/);
		expect(n?.url).toContain("inst-1");
	});

	it("states the EARLIEST deadline across the batch", () => {
		// "Kept until X" has to be true of everything the sentence covers; the latest would
		// over-promise for every other repo in it.
		const n = sleepNotification([repo({ keptUntil: LAST + RESUME_WINDOW_MS + 48 * HOUR }), repo()], "UTC");
		expect(n?.body).toMatch(/Thu 20 Aug, 01:11\./);
		expect(n?.body).not.toMatch(/22 Aug/);
	});

	it("carries the stray-process ask, which is the one thing only the user can do", () => {
		// The `engineStopped: false` branch is a connected machine refusing /coding/end — a child
		// process still resident on their hardware. Nothing else carries that ask anywhere.
		const n = sleepNotification([repo({ strayProcess: true })], "UTC");
		expect(n?.body).toMatch(/One engine could not be stopped on your machine/);
		expect(sleepNotification([repo({ strayProcess: true }), repo({ strayProcess: true })], "UTC")?.body).toMatch(
			/2 engines could not be stopped/,
		);
		expect(sleepNotification([repo()], "UTC")?.body).not.toMatch(/could not be stopped/);
	});

	it("bounds the repo list, because this goes in a push body", () => {
		const many = ["a", "b", "c", "d", "e"].map((r) => repo({ repoName: r }));
		expect(sleepNotification(many, "UTC")?.body).toContain("a, b, c and 2 more");
	});

	it("returns null for an empty sweep so the caller has nothing to decide", () => {
		expect(sleepNotification([], "UTC")).toBeNull();
	});
});

describe("the sweep announces what it did (#698)", () => {
	it("writes ONE notification row for a sweep that put two of an owner's repos to sleep", async () => {
		// Before this the reap released a process on the user's own machine and its only record was
		// a row in the session's own timeline — visible exclusively to someone who had already come
		// back and opened that repo. The owner found out the next morning by reading a dead pane.
		const last = Date.now() - 7 * 3_600_000;
		const { env, calls } = stub({
			idle: [
				{ id: "csess_1", instance_id: "inst", user_id: "u", repo_id: "r1", runner_node: "mac", client_type: "claude", last_activity_at: last, repo_name: "chess-academy", instance_name: "Chess coder 2" },
				{ id: "csess_2", instance_id: "inst", user_id: "u", repo_id: "r2", runner_node: "mac", client_type: "claude", last_activity_at: last, repo_name: "platform", instance_name: "Chess coder 2" },
			],
		});
		expect((await sweepCodingSessions(env)).reaped).toBe(2);
		const inserts = calls.filter((c) => c.sql.includes("INSERT INTO notifications"));
		expect(inserts).toHaveLength(1);
		const body = inserts[0].args.map(String).join(" | ");
		expect(body).toContain("Chess coder 2 went to sleep on 2 repos");
		expect(body).toContain("chess-academy and platform");
		expect(body).toContain("kept until");
		// A stable EVENT key, so two batches a few ticks apart collapse into ONE interruption inside
		// `notifyUser`'s duplicate window while both still write their row. Derived from the event,
		// never from the prose — a body naming different repos each night would defeat the window
		// exactly when it is needed.
		expect(inserts[0].args).toContain(notificationDedupeKey("coding", SLEEP_NOTIFY_KEY, "", ""));
	});

	it("notifies each owner separately — a sweep is cross-tenant", async () => {
		const last = Date.now() - 7 * 3_600_000;
		const { env, calls } = stub({
			idle: [
				{ id: "csess_1", instance_id: "i1", user_id: "u1", repo_id: "r1", runner_node: null, client_type: "claude", last_activity_at: last, repo_name: "a", instance_name: "A" },
				{ id: "csess_2", instance_id: "i2", user_id: "u2", repo_id: "r2", runner_node: null, client_type: "claude", last_activity_at: last, repo_name: "b", instance_name: "B" },
			],
		});
		await sweepCodingSessions(env);
		const inserts = calls.filter((c) => c.sql.includes("INSERT INTO notifications"));
		expect(inserts).toHaveLength(2);
		expect(inserts.map((i) => i.args[1])).toEqual(["u1", "u2"]);
	});

	it("is `update`, never `alert` — nothing is blocked on the user", async () => {
		// An alert is documented as "a human is blocked on this" and is UNMUTABLE. A 3am ping people
		// cannot turn off is how they learn to stop reading notifications, which is the same
		// reasoning `coding-pause.ts` applies to a usage-limit park.
		const { env, calls } = stub({
			idle: [{ id: "csess_1", instance_id: "inst", user_id: "u", repo_id: "r", runner_node: null, client_type: "claude", last_activity_at: Date.now() - 7 * 3_600_000, repo_name: "a", instance_name: "A" }],
		});
		await sweepCodingSessions(env);
		const insert = calls.find((c) => c.sql.includes("INSERT INTO notifications"));
		expect(insert?.args).toContain("update");
		expect(insert?.args).not.toContain("alert");
	});

	it("reaps nothing quietly — no sleep, no notification", async () => {
		const { env, calls } = stub({});
		await sweepCodingSessions(env);
		expect(calls.filter((c) => c.sql.includes("INSERT INTO notifications"))).toHaveLength(0);
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

describe("the reap, read back from somewhere else (#407)", () => {
	it("keeps the six-hour window exactly where #275 put it", () => {
		// #407 changes who may OPEN a session, not how long an idle one lives — it says so in as
		// many words. The two are easy to conflate ("chat can reopen it, so reap sooner"), and the
		// cost of reaping early is a live CLI context that cannot be recovered.
		expect(IDLE_SESSION_MS).toBe(6 * 60 * 60_000);
	});

	it("stamps both outcomes with the marker another surface matches on", () => {
		// The reap's only durable trace is a timeline sentence, and `lastIdleReapForRepo` finds it
		// with a LIKE on this prefix. Rewording either sentence away from the constant would leave
		// the query matching nothing — silently, and with the chat surface going quiet again.
		expect(idleReapNotice(6, true).startsWith(IDLE_REAP_PREFIX)).toBe(true);
		expect(idleReapNotice(6, false).startsWith(IDLE_REAP_PREFIX)).toBe(true);
		expect(idleReapNotice(6, true)).toMatch(/engine on your machine was released/);
		expect(idleReapNotice(6, false)).toMatch(/may still be running/);
	});

	it("neither instructs the user nor teaches them the word 'session' (#695)", () => {
		// This row is the LAST LINE of the repo history a returning user reads. It used to say
		// "Session closed automatically after 6 hours … Start a new session to pick the work back
		// up" — a noun #257 and #408 exist to make unnecessary, attached to an instruction for
		// something the platform does by itself, using a word ("new") that describes the opposite of
		// the resume that actually happens. The owner read it and concluded their work was gone.
		for (const notice of [idleReapNotice(6, true), idleReapNotice(6, false)]) {
			expect(notice).not.toMatch(/session/i);
			expect(notice).not.toMatch(/start a new/i);
			expect(notice).not.toMatch(/closed/i);
		}
		// The stray-process branch keeps its ask: that one IS something only the user can do, on
		// their own hardware, and it is the reason the branch exists (#325).
		expect(idleReapNotice(6, false)).toMatch(/Check it there/);
	});

	it("still recognises reaps written under the marker's PREVIOUS spelling", async () => {
		// The marker is not a constant the code merely agrees on — it is the literal text of rows
		// already in `coding_timeline`, read back with a LIKE. Renaming it without carrying the old
		// spelling does not rename the marker; it hides every reap written before the rename, and
		// the chat surface goes quiet again for exactly the users #407 was about.
		let seen: { sql: string; args: unknown[] } | null = null;
		const env = {
			DB: {
				prepare(sql: string) {
					return {
						bind: (...args: unknown[]) => ({
							async first() {
								seen = { sql, args };
								return { session_id: "csess_old", ended_at: null, reaped: 1 };
							},
						}),
					};
				},
			},
		} as unknown as Env;
		await lastIdleReapForRepo(env, "inst", "u", "repo_1");
		const q = seen as unknown as { sql: string; args: unknown[] };
		for (const p of [IDLE_REAP_PREFIX, ...LEGACY_IDLE_REAP_PREFIXES]) expect(q.args).toContain(`${p}%`);
		expect(LEGACY_IDLE_REAP_PREFIXES).toContain("Session closed automatically after");
	});

	it("asks whether the repo's MOST RECENT finished session was reaped, not whether any was", async () => {
		// "The newest finished session — was it reaped?" and "the newest reaped session" are the
		// same query with opposite meanings. The second would attach a week-old reap notice to a
		// repo that has had three ordinary sessions since.
		let seen: { sql: string; args: unknown[] } | null = null;
		const env = {
			DB: {
				prepare(sql: string) {
					return {
						bind(...args: unknown[]) {
							return {
								async first() {
									seen = { sql, args };
									return { session_id: "csess_old", ended_at: "2026-08-08 01:00:00", reaped: 0 };
								},
							};
						},
					};
				},
			},
		} as unknown as Env;
		expect(await lastIdleReapForRepo(env, "inst", "u", "repo_1")).toBeNull();
		const q = seen as unknown as { sql: string; args: unknown[] };
		expect(q.sql).toMatch(/ORDER BY s\.ended_at DESC/);
		expect(q.sql).toMatch(/status IN \('ended', 'error'\)/);
		expect(q.args).toContain(`${IDLE_REAP_PREFIX}%`);
	});

	it("reports the reap when the newest finished session carries the marker", async () => {
		const env = {
			DB: {
				prepare: () => ({
					bind: () => ({ first: async () => ({ session_id: "csess_reaped", ended_at: "2026-08-08 01:00:00", reaped: 1 }) }),
				}),
			},
		} as unknown as Env;
		expect(await lastIdleReapForRepo(env, "inst", "u", "repo_1")).toEqual({
			sessionId: "csess_reaped",
			endedAt: "2026-08-08 01:00:00",
		});
	});
});
