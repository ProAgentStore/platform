/**
 * The cursored timeline feed, driven against the REAL schema (#581, #527).
 *
 * ── What is being defended, and why each arm exists
 *
 * The tool this route backs is a poller: a client asks "what is new since `seq`" every few
 * seconds while a run works. Two properties make that safe and one makes it useful, and all three
 * have a matching failure this repo has already paid for:
 *
 *   · **disjointness** — consecutive pages neither overlap nor skip. #566 shipped a `before`
 *     cursor whose tool never sent it, so every response advertised a cursor no argument could
 *     use; the fix came with an overlapping-pages test and this follows that convention.
 *   · **a bounded payload** — #569's guard passed at ~54 KB while production served 66,042 B,
 *     because the assertion sat one layer above the serialiser. A `terminal` row averages 8,068
 *     chars in production and maxes at 12,000, so five of them overflow a 64 KiB response on
 *     their own: `limit` cannot be the bound, and the arm below drives the worst case.
 *   · **an empty page that says WHY** — #580's run reported `running` for 4.35 hours with a fresh
 *     `lastProgressAt` while its engine had been dead since step 1. "No new events" is the same
 *     observation for a long step and a dead one; `runState` is what separates them.
 *
 * `realSchemaD1` rather than a SQL-matching stub, deliberately: the cursor IS the SQL here
 * (`seq > ?2 ORDER BY seq ASC LIMIT ?3`), and a stub that returns a fixed array whatever it is
 * asked would assert the fixture rather than the query. #438 records what that costs.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import {
	appendTimeline,
	budgetFeedEvent,
	FEED_BYTE_BUDGET,
	FEED_NARRATIVE_CHARS,
	FEED_TERMINAL_CHARS,
	loadTimelineFeed,
} from "../lib/coding-timeline.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";

// The runner transport, stubbed at the seam the route reads `runState` through. Only the two
// entry points are replaced, so a caller that starts depending on the rest of the module is not
// handed `undefined`.
const { getRunnerConn, callRunner } = vi.hoisted(() => ({
	getRunnerConn: vi.fn(),
	callRunner: vi.fn(),
}));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/runner-client.js")>()),
	getRunnerConn,
	callRunner,
}));

import { registerFeedRoutes } from "./coding-feed.js";

const SECRET = "coding-feed-test-secret";
const UID = "user-1";
const INSTANCE = "inst-1";

/** The 64 KiB limit the calling host in #569 applied. */
const HOST_LIMIT = 64 * 1024;

let d1: RealSchemaD1;
let env: Env;

function seedSession(id: string, status: "active" | "ended", updatedAt: string): void {
	d1.exec(
		`INSERT OR IGNORE INTO coding_repos (id, instance_id, user_id, name) VALUES ('repo-1', '${INSTANCE}', '${UID}', 'demo')`,
	);
	d1.exec(
		`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, tmux_session, updated_at)
		 VALUES ('${id}', '${INSTANCE}', 'repo-1', '${UID}', '${status}', 'claude:${id}', '${updatedAt}')`,
	);
}

function seedRun(id: string, sessionId: string | null, instanceId = INSTANCE): void {
	d1.exec(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, max_iterations, started_at, status, session_id)
		 VALUES ('${id}', '${UID}', '${instanceId}', 'fix #767', 10, 1780000000000, 'running', ${sessionId ? `'${sessionId}'` : "NULL"})`,
	);
}

async function append(sessionId: string, type: Parameters<typeof appendTimeline>[1]["type"], content: string) {
	await appendTimeline(env, { sessionId, instanceId: INSTANCE, userId: UID, type, content });
}

beforeEach(() => {
	vi.resetAllMocks();
	d1 = realSchemaD1();
	seedTenant(d1, { userId: UID, instanceIds: [INSTANCE] });
	env = { DB: d1.DB, SESSION_SIGNING_KEY: SECRET } as unknown as Env;
});

function app() {
	const a = new Hono<{ Bindings: Env }>();
	const routes = new Hono<{ Bindings: Env }>();
	registerFeedRoutes(routes);
	a.route("/v1/instances", routes);
	a.onError((err, c) => {
		if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
		return c.json({ error: (err as Error).message }, 500);
	});
	return a;
}

async function get(path: string) {
	const token = await signSession(UID, SECRET, { roles: ["user"] });
	return app().fetch(new Request(`https://api.test${path}`, { headers: { Authorization: `Bearer ${token}` } }), env);
}

describe("loadTimelineFeed cursor semantics (#581 AC2)", () => {
	it("pages two overlapping windows that neither repeat nor skip a row", async () => {
		seedSession("csess-1", "active", "2026-08-15 10:00:00");
		for (let i = 1; i <= 25; i++) await append("csess-1", "command", `instruction ${i}`);

		// G1 — the denominator. A query that silently returned nothing would satisfy every
		// disjointness claim below by vacuity (ADR 0002).
		const all = await loadTimelineFeed(env, { sessionId: "csess-1", limit: 100 });
		expect(all.events).toHaveLength(25);

		// `sinceSeq: 0` is the explicit "walk me forward from the start" poll. It used to be what an
		// absent cursor meant; since #674 an absent cursor means the NEWEST page, and this test is
		// about the forward walk, so it names its direction rather than relying on a default.
		const first = await loadTimelineFeed(env, { sessionId: "csess-1", sinceSeq: 0, limit: 10 });
		expect(first.events).toHaveLength(10);
		expect(first.hasMore).toBe(true);
		expect(first.nextSeq).toBe(first.events[9].seq);

		const second = await loadTimelineFeed(env, { sessionId: "csess-1", sinceSeq: first.nextSeq, limit: 10 });
		const third = await loadTimelineFeed(env, { sessionId: "csess-1", sinceSeq: second.nextSeq, limit: 10 });
		expect(third.hasMore).toBe(false);

		const seqs = [...first.events, ...second.events, ...third.events].map((e) => e.seq);
		// Disjoint: no seq delivered twice.
		expect(new Set(seqs).size).toBe(seqs.length);
		// Complete and in order: the three pages are exactly the whole timeline, oldest→newest.
		expect(seqs).toEqual(all.events.map((e) => e.seq));
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
	});

	it("echoes the cursor back on an empty page rather than restarting the session", async () => {
		seedSession("csess-1", "active", "2026-08-15 10:00:00");
		await append("csess-1", "command", "only instruction");
		const page = await loadTimelineFeed(env, { sessionId: "csess-1" });
		expect(page.hasMore).toBe(false);

		// The poll that finds nothing. `nextSeq: 0` here would re-deliver the whole session on the
		// next tick — the same class of defect as a tail that answers `null` (#550).
		const idle = await loadTimelineFeed(env, { sessionId: "csess-1", sinceSeq: page.nextSeq });
		expect(idle.events).toEqual([]);
		expect(idle.nextSeq).toBe(page.nextSeq);
		expect(idle.hasMore).toBe(false);

		// …and a row appended after that poll is picked up from the echoed cursor.
		await append("csess-1", "outcome", "done — pushed");
		const next = await loadTimelineFeed(env, { sessionId: "csess-1", sinceSeq: idle.nextSeq });
		expect(next.events.map((e) => e.content)).toEqual(["done — pushed"]);
	});
});

describe("payload bounds (#581 AC4, #569's lesson)", () => {
	it("keeps a terminal snapshot's TAIL and a narrative row's HEAD, recording the true length", () => {
		const pane = budgetFeedEvent({ seq: 1, type: "terminal", content: `${"x".repeat(12_000)}LATEST`, createdAt: "t" });
		// The end of a pane is the live part — the tail is what "what is it doing right now" needs.
		expect(pane.content.endsWith("LATEST")).toBe(true);
		expect(pane.content).toHaveLength(FEED_TERMINAL_CHARS);
		expect(pane.chars).toBe(12_006);

		const instruction = budgetFeedEvent({ seq: 2, type: "command", content: `START${"y".repeat(5_000)}`, createdAt: "t" });
		// An instruction says what it wants first, so the head is the informative end.
		expect(instruction.content.startsWith("START")).toBe(true);
		expect(instruction.content).toHaveLength(FEED_NARRATIVE_CHARS);
		expect(instruction.chars).toBe(5_005);

		// A row that fits carries no `chars` — the field's presence IS the truncation signal.
		expect(budgetFeedEvent({ seq: 3, type: "command", content: "short", createdAt: "t" }).chars).toBeUndefined();
	});

	it("bounds the page in BYTES, so a 200-row limit of production-max snapshots still fits the wire", async () => {
		seedSession("csess-1", "active", "2026-08-15 10:00:00");
		// The worst case measured in production D1 on 2026-08-15: `terminal` rows at their 12,000
		// char maximum, with newlines, which JSON escapes to two bytes each — the inflation a
		// character count cannot see and the reason the budget is taken on serialised bytes.
		const pane = "claude working on the thing\n".repeat(500).slice(0, 12_000);
		const SEEDED = 150;
		for (let i = 0; i < SEEDED; i++) await append("csess-1", "terminal", pane);

		// G1 — the fixture is the size it claims to be, before any claim about it (ADR 0002). A
		// session that seeded fewer rows, or shorter ones, would satisfy every bound below by
		// being small rather than by being bounded.
		const rows = d1.sqlite.prepare("SELECT COUNT(*) n FROM coding_timeline WHERE type = 'terminal'").get() as { n: number };
		expect(rows.n).toBe(SEEDED);
		expect(pane).toHaveLength(12_000);

		const page = await loadTimelineFeed(env, { sessionId: "csess-1", limit: 200 });
		const bytes = new TextEncoder().encode(JSON.stringify(page)).length;
		expect(bytes).toBeLessThan(FEED_BYTE_BUDGET);
		expect(bytes).toBeLessThan(HOST_LIMIT);

		// The ground this walks: the rows it DID return, served at their true lengths, would not
		// have fitted the host limit. Without it the assertion above would pass on any page small
		// enough to fit anyway — which is exactly how #569's guard certified 54 KB while
		// production served 66,042 B.
		const inlineChars = page.events.reduce((n, e) => n + (e.chars ?? e.content.length), 0);
		expect(inlineChars).toBeGreaterThan(HOST_LIMIT);

		// The bound is the BUDGET, not the row cap: `limit: 200` asked for all 150 and the page
		// still came back short of them, with `hasMore` saying so rather than dropping them.
		expect(page.events.length).toBeLessThan(SEEDED);
		expect(page.hasMore).toBe(true);
		expect(page.truncated?.events).toBe(page.events.length);
		// And the withheld rows are reachable rather than stranded. The direction is BACKWARD since
		// #674: a page with no cursor keeps the NEWEST rows and withholds the older ones, so the
		// budget's overflow is reached with `before`, not by polling forward off the end.
		const older = await loadTimelineFeed(env, { sessionId: "csess-1", before: page.oldestSeq, limit: 200 });
		expect(older.events.length).toBeGreaterThan(0);
		expect(older.events[older.events.length - 1].seq).toBeLessThan(page.events[0].seq);

		console.log(
			`✓ feed page: ${page.events.length}/${SEEDED} rows of 12,000-char panes, ${bytes} B ` +
				`(budget ${FEED_BYTE_BUDGET} B, host limit ${HOST_LIMIT} B); the same rows inline ` +
				`would be ${inlineChars} chars, ${page.truncated?.chars} of them withheld`,
		);
	});

	it("always emits one row, so a single oversized row cannot stall the cursor", async () => {
		seedSession("csess-1", "active", "2026-08-15 10:00:00");
		await append("csess-1", "terminal", "z".repeat(100_000));
		const page = await loadTimelineFeed(env, { sessionId: "csess-1", limit: 1 });
		expect(page.events).toHaveLength(1);
		expect(page.nextSeq).toBe(page.events[0].seq);
	});
});

describe("the route resolves a session and says what the engine is doing", () => {
	it("picks the newest ACTIVE session when the caller names none", async () => {
		seedSession("csess-old", "ended", "2026-08-15 09:00:00");
		seedSession("csess-live", "active", "2026-08-15 10:00:00");
		await append("csess-live", "brain", "AI run started — objective: fix #26");
		getRunnerConn.mockResolvedValue({ node: "laptop" });
		callRunner.mockResolvedValue({ runState: "thinking" });

		const res = await get(`/v1/instances/${INSTANCE}/coding/timeline`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessionId: string; runState: string; runnerConnected: boolean; events: { content: string }[] };
		expect(body.sessionId).toBe("csess-live");
		expect(body.runState).toBe("thinking");
		expect(body.runnerConnected).toBe(true);
		expect(body.events[0].content).toContain("objective: fix #26");
	});

	it("resolves a loop run id to its coding session instead of guessing the newest session", async () => {
		seedSession("csess-run", "ended", "2026-08-15 09:00:00");
		seedSession("csess-other", "active", "2026-08-15 10:00:00");
		seedRun("run-767", "csess-run");
		await append("csess-run", "brain", "AI run started — objective: expose trace by run");
		await append("csess-other", "brain", "AI run started — objective: unrelated newer work");

		const res = await get(`/v1/instances/${INSTANCE}/coding/timeline?run_id=run-767`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessionId: string; runState: string; events: { content: string }[] };
		expect(body.sessionId).toBe("csess-run");
		expect(body.runState).toBe("ended");
		expect(body.events.map((e) => e.content)).toEqual(["AI run started — objective: expose trace by run"]);
	});

	it("keeps explicit session_id ahead of run_id resolution", async () => {
		seedSession("csess-named", "ended", "2026-08-15 08:00:00");
		seedSession("csess-run", "active", "2026-08-15 09:00:00");
		seedRun("run-767", "csess-run");
		await append("csess-named", "brain", "the named session wins");
		await append("csess-run", "brain", "the run-linked session loses");

		const res = await get(`/v1/instances/${INSTANCE}/coding/timeline?run_id=run-767&session_id=csess-named`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessionId: string; events: { content: string }[] };
		expect(body.sessionId).toBe("csess-named");
		expect(body.events.map((e) => e.content)).toEqual(["the named session wins"]);
	});

	it("does not let a run id escape the instance named in the route", async () => {
		seedTenant(d1, { userId: UID, instanceIds: ["inst-2"] });
		seedRun("run-other", "csess-other", "inst-2");

		const res = await get(`/v1/instances/${INSTANCE}/coding/timeline?run_id=run-other`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Run coding session not found" });
	});

	it("reports a non-coding loop run as having no coding session", async () => {
		seedRun("run-chat", null);

		const res = await get(`/v1/instances/${INSTANCE}/coding/timeline?run_id=run-chat`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Run coding session not found" });
	});

	it("falls back to the most recent ENDED session, which is #527's audit case", async () => {
		// The platform ends sessions by itself — the Pilot closes one on every finished run — so a
		// run that finished a minute ago has NO active session. `coding_session_capture` answers
		// that with an empty pane and `idle`; this must answer with the run.
		seedSession("csess-done", "ended", "2026-08-15 10:00:00");
		await append("csess-done", "command", "Run the full test suite with `pnpm test`");
		await append("csess-done", "outcome", "done — 1198 tests passed, commit 1fbb124 landed");

		const res = await get(`/v1/instances/${INSTANCE}/coding/timeline`);
		const body = (await res.json()) as { sessionId: string; runState: string; events: { type: string; content: string }[] };
		expect(body.sessionId).toBe("csess-done");
		// `ended`, not the runner's `idle`: no runner was asked about a session it no longer holds,
		// so reporting `idle` would be a reading nobody took (#527).
		expect(body.runState).toBe("ended");
		expect(getRunnerConn).not.toHaveBeenCalled();
		expect(body.events.map((e) => e.type)).toEqual(["command", "outcome"]);
	});

	it("reports `offline` when no runner holds the session, never `idle`", async () => {
		seedSession("csess-1", "active", "2026-08-15 10:00:00");
		await append("csess-1", "brain", "AI run started — objective: anything");
		getRunnerConn.mockResolvedValue(null);

		const body = (await (await get(`/v1/instances/${INSTANCE}/coding/timeline`)).json()) as { runState: string; runnerConnected: boolean };
		expect(body.runState).toBe("offline");
		expect(body.runnerConnected).toBe(false);
	});

	it("404s an instance with no coding session rather than answering an empty feed", async () => {
		const res = await get(`/v1/instances/${INSTANCE}/coding/timeline`);
		expect(res.status).toBe(404);
	});

	it("reproduces #580: the engine dies at step 1 and the read shows the error, not silence", async () => {
		// The measured run: instance e4d2d031, run 70ea298e, 2026-08-15. `check_instance_loop` said
		// `running` with a `lastProgressAt` 3.5 minutes old, for 4.35 hours, on iteration 1 of 30.
		// The engine had died one second after receiving the objective and the ONLY place the truth
		// existed was the pane — retrievable solely by someone who already knew the session id.
		seedSession("csess-1", "active", "2026-08-15 14:20:00");
		await append("csess-1", "brain", "AI run started — objective: Fix issue #57 in proappstore-online/platform");
		await append("csess-1", "command", "Please read GitHub issue #57 from the repository proappstore-online/platform");
		await append("csess-1", "terminal", "[14:20:57] Please read GitHub issue #57…\n[14:20:58] You've hit your weekly limit · resets Aug 17 at 4pm\n[error] You've hit your weekly limit…");
		getRunnerConn.mockResolvedValue({ node: "laptop" });
		callRunner.mockResolvedValue({ runState: "idle" });

		const body = (await (await get(`/v1/instances/${INSTANCE}/coding/timeline`)).json()) as {
			runState: string;
			hasMore: boolean;
			events: { type: string; content: string }[];
		};
		// The cause is in the read, without a session id and without the pane.
		expect(body.events.map((e) => e.type)).toEqual(["brain", "command", "terminal"]);
		expect(body.events[2].content).toContain("You've hit your weekly limit");
		// And the pair that distinguishes a long step from a dead one: nothing further is coming
		// (`hasMore:false`) AND the engine is not working. Either half alone is the ambiguity #580
		// is about — a fresh `lastProgressAt` on a run that had not moved in 4.35 hours.
		expect(body.hasMore).toBe(false);
		expect(body.runState).toBe("idle");
	});
});

/**
 * `?terminal=1` — the arm that gives a finished run's pane a reader (#699).
 *
 * The feed above is measured against its byte budget and passes; this is the read it deliberately
 * cannot serve. A `terminal` row is stored whole (8,000 chars, capped by `snapshotForStore`) and
 * served to this feed as a 400-character tail, so an MCP client could reach 5% of what D1 holds —
 * measured live on 2026-08-18 at 64,000 stored characters against 3,200 reachable.
 *
 * Both arms are driven THROUGH THE ROUTE rather than against `loadTerminalSnapshots` directly. The
 * store function has had cursor tests since #432; what was missing is that the cursor is reachable
 * on a session the caller cannot name, which is a property of the resolution above it.
 */
describe("?terminal=1 — the stored panes, uncut (#699)", () => {
	/** A snapshot the size production writes: `TERMINAL_SNAPSHOT_CHARS` exactly. */
	const pane = (i: number) => `[snapshot ${i}] ${"claude working on the thing\n".repeat(400)}`.slice(0, 8_000);

	async function readTerminal(qs: string) {
		const res = await get(`/v1/instances/${INSTANCE}/coding/timeline?terminal=1${qs}`);
		return {
			status: res.status,
			body: (await res.json()) as {
				sessionId: string;
				sessionStatus: string;
				entries: { seq: number; content: string }[];
				hasMore: boolean;
				oldestSeq: number | null;
				newestSeq: number | null;
			},
		};
	}

	it("reaches all 64,000 stored characters of an ENDED session the caller cannot name, where the feed reaches 3,200", async () => {
		// The shape of `csess_613d1455-c882-4899-9117-1e3670e94027`, the session #699 measured: eight
		// `terminal` rows, ended, no active session on the instance. Reconstructed here at the real
		// sizes rather than hit live — the row count and the 8,000-char row are the measurement.
		seedSession("csess-done", "ended", "2026-08-18 09:12:00");
		for (let i = 0; i < 8; i++) await append("csess-done", "terminal", pane(i));

		// G1 — the denominator, before any claim about what is reachable (ADR 0002). A seed that
		// stored short rows would let every assertion below pass by being small.
		const stored = d1.sqlite.prepare("SELECT COUNT(*) n, SUM(LENGTH(content)) c FROM coding_timeline WHERE type = 'terminal'").get() as { n: number; c: number };
		expect(stored).toEqual({ n: 8, c: 64_000 });

		// What the FEED reaches on the same rows: eight 400-character tails. This is the 5%.
		const feed = await loadTimelineFeed(env, { sessionId: "csess-done", limit: 40 });
		const feedChars = feed.events.reduce((n, e) => n + e.content.length, 0);
		expect(feed.events).toHaveLength(8);
		expect(feedChars).toBe(8 * FEED_TERMINAL_CHARS);

		// What THIS arm reaches, walking back one snapshot at a time from no cursor at all — the
		// caller names neither a session nor a seq, which is AC1.
		const seen: { seq: number; content: string }[] = [];
		let cursor = "";
		for (let call = 0; call < 8; call++) {
			const { status, body } = await readTerminal(`&limit=1${cursor}`);
			expect(status).toBe(200);
			// Resolution is the feed's own: no active session, so the most recently updated one.
			expect(body.sessionId).toBe("csess-done");
			expect(body.sessionStatus).toBe("ended");
			expect(body.entries).toHaveLength(1);
			seen.push(body.entries[0]);
			expect(body.hasMore).toBe(call < 7);
			cursor = `&before=${body.oldestSeq}`;
		}

		// Every row, once, uncut — 64,000 characters against the feed's 3,200.
		const reached = seen.reduce((n, e) => n + e.content.length, 0);
		expect(new Set(seen.map((e) => e.seq)).size).toBe(8);
		expect(reached).toBe(64_000);
		expect(seen.every((e) => e.content.length === 8_000)).toBe(true);
		// Newest first, and the CONTENT is what was written rather than a tail of it.
		expect(seen.map((e) => e.content.slice(0, 12))).toEqual([7, 6, 5, 4, 3, 2, 1, 0].map((i) => `[snapshot ${i}]`));
		// …and the page after the oldest is empty rather than looping.
		const past = await readTerminal(`&limit=1&before=${seen[7].seq}`);
		expect(past.body.entries).toEqual([]);
		expect(past.body.hasMore).toBe(false);

		console.log(
			`✓ coding_terminal reach: ${reached} of ${stored.c} stored chars across 8 calls; ` +
				`the same rows through the feed are ${feedChars} chars (${Math.round((feedChars / stored.c) * 100)}%)`,
		);
	});

	it("walks `before` back through every snapshot with no overlap and no gap", async () => {
		// The disjointness arm the forward cursor already carries, applied to this one. Pages of 3
		// over 8 rows so the last page is partial — a cursor that is off by one shows up there first.
		seedSession("csess-live", "active", "2026-08-18 09:12:00");
		for (let i = 0; i < 8; i++) await append("csess-live", "terminal", pane(i));

		const all = (await readTerminal("&limit=4")).body;
		expect(all.entries).toHaveLength(4);

		const seqs: number[] = [];
		let cursor = "";
		for (let page = 0; page < 3; page++) {
			const { body } = await readTerminal(`&limit=3${cursor}`);
			seqs.push(...body.entries.map((e) => e.seq));
			cursor = `&before=${body.oldestSeq}`;
			expect(body.hasMore).toBe(page < 2);
		}
		// Disjoint (no seq twice), complete (all eight), ordered (each page oldest→newest, the
		// window walking backwards).
		expect(new Set(seqs).size).toBe(seqs.length);
		expect([...seqs].sort((a, b) => a - b)).toHaveLength(8);
		expect(seqs.slice(0, 3)).toEqual([...seqs.slice(0, 3)].sort((a, b) => a - b));
		expect(Math.min(...seqs.slice(0, 3))).toBeGreaterThan(Math.max(...seqs.slice(3, 6)));

		// The arm does not probe the runner: it reads stored text, and `runState` is coding_timeline's
		// job. A capture round trip here would cost a subrequest per call to answer nothing.
		expect(getRunnerConn).not.toHaveBeenCalled();
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("reads a session the caller names, and 404s an instance with none", async () => {
		expect((await readTerminal("")).status).toBe(404);
		seedSession("csess-a", "ended", "2026-08-18 09:00:00");
		seedSession("csess-b", "ended", "2026-08-18 09:30:00");
		await append("csess-a", "terminal", pane(1));
		await append("csess-b", "terminal", pane(2));
		// Named wins over the resolution; without it the newer of the two ended sessions answers.
		expect((await readTerminal("&session_id=csess-a")).body.sessionId).toBe("csess-a");
		expect((await readTerminal("")).body.sessionId).toBe("csess-b");
	});
});
