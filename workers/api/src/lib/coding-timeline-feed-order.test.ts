/**
 * Which END of an append-only log a reader with no cursor gets (#674).
 *
 * `loadTimelineFeed` resolved an absent cursor to `since = 0` and returned the OLDEST page. Every
 * prompt in a run precedes every piece of output, so page 1 of a real run was
 * `brain, brain, command` and a caller reasonably concluded the engine's output was missing — the
 * report this issue was filed from. The output was never missing; it was behind paging, and the
 * consequence scaled the wrong way: the more work a run did, the further its latest output sat
 * from page 1.
 *
 * The convention applied here is not a new one. `loadTerminalSnapshots` in the same file already
 * carries both arms over the same table — `after` ascending for the live tail, `before` descending
 * for scrollback — and says so: *"deliberately the same `before`/`limit`/`hasMore` shape the chat
 * thread needs (#428), so one convention covers both"*. `loadRepoTimeline` records the same
 * reasoning for the default: *"the cap has to keep the LATEST rows, and `ORDER BY seq ASC LIMIT n`
 * would keep the oldest"*.
 *
 * What each arm must hold, and why the obvious wrong implementation fails it:
 *
 *   · **no cursor ⇒ newest page.** Reversing only the SQL and not the rows would hand the caller
 *     newest→oldest and break render order, which every existing consumer assumes.
 *   · **`sinceSeq` still walks forward, byte for byte.** A poller must be untouched: flipping its
 *     direction is the race this fix explicitly refused, since the Pilot ends a session on every
 *     finished run and a live poll would be re-pointed mid-loop.
 *   · **`before` pages strictly backwards** and reports `hasMore` about the OLD end, so a caller
 *     walking back cannot mistake "more history exists" for "more output arrived".
 */
import { beforeEach, describe, expect, it } from "vitest";
import { appendTimeline, FEED_DEFAULT_LIMIT, loadTimelineFeed } from "./coding-timeline.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

const SESSION = "csess_order";

describe("loadTimelineFeed — a reader with no cursor gets the NEWEST page (#674)", () => {
	let db: RealSchemaD1;
	let env: Env;

	beforeEach(() => {
		db = realSchemaD1();
		seedTenant(db, { userId: "u1", instanceIds: ["i1"] });
		db.exec("INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('repo-1', 'i1', 'u1', 'demo')");
		db.exec(
			`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, tmux_session)
			 VALUES ('${SESSION}', 'i1', 'repo-1', 'u1', 'active', 'claude:${SESSION}')`,
		);
		env = { DB: db.DB } as unknown as Env;
	});

	const add = (type: "brain" | "command" | "terminal" | "outcome", content: string) =>
		appendTimeline(env, { sessionId: SESSION, instanceId: "i1", userId: "u1", type, content });

	/** The reported run's shape: the instructions come first, the engine's output comes after. */
	async function seedRun(): Promise<void> {
		await add("brain", "AI run started — objective: implement the thing");
		await add("brain", "planning");
		await add("command", "Let's start by exploring the repository structure...");
		for (let i = 0; i < 8; i++) {
			await add("terminal", `⚙ Bash {"command":"step ${i}"}\n  ↳ output of step ${i}`);
		}
		await add("outcome", "run finished");
	}

	it("page 1 contains the engine's OUTPUT, not only what was sent to it", async () => {
		await seedRun();
		// The exact reproduction on the issue: a small page that was all `brain`/`command`.
		const page = await loadTimelineFeed(env, { sessionId: SESSION, limit: 3 });
		expect(page.events.map((e) => e.type)).toContain("terminal");
	});

	it("the newest event in the session is on page 1", async () => {
		await seedRun();
		const page = await loadTimelineFeed(env, { sessionId: SESSION, limit: 3 });
		// The scaling property: whatever the run did, its LATEST event is reachable in one call.
		expect(page.events[page.events.length - 1].content).toBe("run finished");
	});

	it("rows still come back oldest→newest inside the page", async () => {
		await seedRun();
		const page = await loadTimelineFeed(env, { sessionId: SESSION, limit: 4 });
		const seqs = page.events.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
	});

	it("a short session is returned whole, and says there is nothing older", async () => {
		await add("brain", "only event");
		const page = await loadTimelineFeed(env, { sessionId: SESSION });
		expect(page.events).toHaveLength(1);
		expect(page.hasMore).toBe(false);
	});

	it("`hasMore` on a default page reports history OLDER than it, not events still to come", async () => {
		await seedRun();
		const page = await loadTimelineFeed(env, { sessionId: SESSION, limit: 3 });
		expect(page.hasMore).toBe(true);
		expect(page.oldestSeq).toBe(page.events[0].seq);
	});
});

describe("loadTimelineFeed — `sinceSeq` still walks FORWARD, unchanged (#674)", () => {
	let db: RealSchemaD1;
	let env: Env;

	beforeEach(() => {
		db = realSchemaD1();
		seedTenant(db, { userId: "u1", instanceIds: ["i1"] });
		db.exec("INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('repo-1', 'i1', 'u1', 'demo')");
		db.exec(
			`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, tmux_session)
			 VALUES ('${SESSION}', 'i1', 'repo-1', 'u1', 'active', 'claude:${SESSION}')`,
		);
		env = { DB: db.DB } as unknown as Env;
	});

	const add = (content: string) =>
		appendTimeline(env, { sessionId: SESSION, instanceId: "i1", userId: "u1", type: "brain", content });

	it("a poll from a cursor returns only what is newer, oldest→newest", async () => {
		for (let i = 0; i < 5; i++) await add(`event ${i}`);
		const first = await loadTimelineFeed(env, { sessionId: SESSION, sinceSeq: 0, limit: 2 });
		// `sinceSeq: 0` is the explicit "from the beginning" poll and MUST stay oldest-first —
		// this is the arm the live poller uses, and re-pointing it is the race this fix refused.
		expect(first.events.map((e) => e.content)).toEqual(["event 0", "event 1"]);
		const second = await loadTimelineFeed(env, { sessionId: SESSION, sinceSeq: first.nextSeq, limit: 2 });
		expect(second.events.map((e) => e.content)).toEqual(["event 2", "event 3"]);
	});

	it("an empty poll echoes the cursor back rather than restarting the session", async () => {
		await add("only");
		const page = await loadTimelineFeed(env, { sessionId: SESSION, sinceSeq: 0 });
		const empty = await loadTimelineFeed(env, { sessionId: SESSION, sinceSeq: page.nextSeq });
		expect(empty.events).toHaveLength(0);
		expect(empty.nextSeq).toBe(page.nextSeq);
	});
});

describe("loadTimelineFeed — `before` pages backwards from the newest page (#674)", () => {
	let db: RealSchemaD1;
	let env: Env;

	beforeEach(() => {
		db = realSchemaD1();
		seedTenant(db, { userId: "u1", instanceIds: ["i1"] });
		db.exec("INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('repo-1', 'i1', 'u1', 'demo')");
		db.exec(
			`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, tmux_session)
			 VALUES ('${SESSION}', 'i1', 'repo-1', 'u1', 'active', 'claude:${SESSION}')`,
		);
		env = { DB: db.DB } as unknown as Env;
	});

	const add = (content: string) =>
		appendTimeline(env, { sessionId: SESSION, instanceId: "i1", userId: "u1", type: "brain", content });

	it("walks back through the whole session without overlap or gap", async () => {
		for (let i = 0; i < 6; i++) await add(`event ${i}`);
		const newest = await loadTimelineFeed(env, { sessionId: SESSION, limit: 2 });
		expect(newest.events.map((e) => e.content)).toEqual(["event 4", "event 5"]);

		const older = await loadTimelineFeed(env, { sessionId: SESSION, before: newest.oldestSeq, limit: 2 });
		expect(older.events.map((e) => e.content)).toEqual(["event 2", "event 3"]);

		const oldest = await loadTimelineFeed(env, { sessionId: SESSION, before: older.oldestSeq, limit: 2 });
		expect(oldest.events.map((e) => e.content)).toEqual(["event 0", "event 1"]);
		expect(oldest.hasMore).toBe(false);
	});

	it("`before` is EXCLUSIVE, so the row the cursor names is not delivered twice", async () => {
		for (let i = 0; i < 4; i++) await add(`event ${i}`);
		const newest = await loadTimelineFeed(env, { sessionId: SESSION, limit: 2 });
		const older = await loadTimelineFeed(env, { sessionId: SESSION, before: newest.oldestSeq, limit: 2 });
		const seen = [...older.events, ...newest.events].map((e) => e.seq);
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("`before` and `sinceSeq` together is refused rather than silently picking one", async () => {
		await add("a");
		await expect(loadTimelineFeed(env, { sessionId: SESSION, before: 5, sinceSeq: 1 })).rejects.toThrow(/before.*since|since.*before/i);
	});

	it("the default limit is unchanged", () => {
		expect(FEED_DEFAULT_LIMIT).toBe(40);
	});
});
