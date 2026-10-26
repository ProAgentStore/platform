/**
 * #1335: the owner's coding history across every instance — pageable, filterable, correlated, with a full-range summary and an
 * explicit statement of what is not recorded. Real migrated schema and the real route; rows are seeded the way the platform leaves them.
 *
 * Invariants protected: attempts and real runs are different numbers (a null-run admission failure is an attempt); the summary and
 * the coverage describe the whole requested range, not the page; a cursor survives rows inserted while a reader pages; nothing older
 * than a record is reconstructed; one owner never sees another's rows; payloads are bounded and redacted; every read is read-only.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

const uid = { current: "u1" };
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: uid.current, roles: [] }) };
});

const { instanceRoutes } = await import("./instances.js");
const { runAutoPickup, setAutoPickup } = await import("../lib/auto-pickup.js");
const { createLoopRun } = await import("../lib/agent-loop-store.js");
const { enqueueObjective } = await import("../lib/objective-queue.js");
const { listLifecycle } = await import("../lib/objective-lifecycle.js");

const T0 = 1_800_000_000_000;
const MIN = 60_000;
let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2", "i3"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["x2"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r1', 'i1', 'u1', 'app', 'acme/app'), ('r2', 'i2', 'u1', 'web', 'acme/web'), ('rx', 'x2', 'u2', 'secret', 'other/secret')`);
	env = { DB: d1.DB } as unknown as Env;
	uid.current = "u1";
});
afterEach(() => d1.close());

// biome-ignore lint/suspicious/noExplicitAny: a JSON response read field by field in assertions.
type Json = Record<string, any>;
async function history(query = ""): Promise<{ status: number; body: Json }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/instances", instanceRoutes);
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
	const res = await app.request(`/v1/instances/my/coding-history${query ? `?${query}` : ""}`, {}, env);
	return { status: res.status, body: (await res.json()) as Json };
}
/** Follow `nextCursor` to the end; every page must be valid. */
async function allPages(query: string, from: string | null = null): Promise<{ items: Json[]; pages: number }> {
	const items: Json[] = [];
	let cursor: string | null = from;
	let pages = 0;
	do {
		const r = await history(`${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}&summary=false`);
		expect(r.status).toBe(200);
		items.push(...r.body.items);
		cursor = r.body.nextCursor;
		pages++;
	} while (cursor && pages < 100);
	return { items, pages };
}

let seq = 0;
function queue(o: { id?: string; instance?: string; user?: string; repoId?: string | null; status?: string; runId?: string | null; at?: number; issue?: number | null; meta?: string | null; deferrals?: number; stop?: string | null; actor?: string | null; request?: string | null }): string {
	const id = o.id ?? `objq-${++seq}`;
	d1.DB.prepare(
		`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, stop_reason, run_id, created_at, issue_number, metadata, deferral_count, actor_uid, request_id)
		 VALUES (?1, ?2, ?3, ?4, 'SECRET-OBJECTIVE-TEXT do the thing', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
	)
		.bind(id, o.instance ?? "i1", o.repoId === undefined ? "r1" : o.repoId, o.user ?? "u1", o.status ?? "pending", o.stop ?? null, o.runId ?? null, o.at ?? T0 + seq, o.issue ?? null, o.meta ?? null, o.deferrals ?? 0, o.actor ?? null, o.request ?? null)
		.run();
	return id;
}
function run(o: { id?: string; instance?: string; user?: string; status?: string; at?: number; issue?: number | null; session?: string | null; stop?: string | null; queueEntry?: string | null }): string {
	const id = o.id ?? `run-${++seq}`;
	d1.DB.prepare(
		`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at, session_id, issue_number, queue_entry_id)
		 VALUES (?1, ?2, ?3, 'SECRET-OBJECTIVE-TEXT run', ?4, ?5, 10, ?6, ?7, ?8, ?9, ?10)`,
	)
		.bind(id, o.user ?? "u1", o.instance ?? "i1", o.status ?? "completed", o.stop ?? null, o.at ?? T0 + seq, (o.at ?? T0 + seq) + 5 * MIN, o.session ?? null, o.issue ?? null, o.queueEntry ?? null)
		.run();
	return id;
}
const event = (o: { instance?: string; user?: string; event?: string; at: number; queueEntry?: string | null; runId?: string | null }) =>
	d1.DB.prepare(`INSERT INTO objective_lifecycle_events (user_id, instance_id, queue_entry_id, run_id, event, actor_kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'platform', ?6)`)
		.bind(o.user ?? "u1", o.instance ?? "i1", o.queueEntry ?? null, o.runId ?? null, o.event ?? "queued", o.at)
		.run();

describe("pageable, stable under concurrent inserts (#1335)", () => {
	it("pages 90 items across three instances newest-first with no gap and no duplicate", async () => {
		for (let i = 0; i < 60; i++) queue({ instance: `i${(i % 3) + 1}`, at: T0 + i * 1000 });
		for (let i = 0; i < 30; i++) run({ instance: `i${(i % 3) + 1}`, at: T0 + 100_000 + i * 1000 });
		const { items, pages } = await allPages("limit=25");
		expect(pages).toBe(4);
		expect(items).toHaveLength(90);
		expect(new Set(items.map((i) => `${i.kind}.${i.id}`)).size).toBe(90);
		const times = items.map((i) => i.at);
		expect(times).toEqual([...times].sort((a, b) => b - a));
		const first = await history("limit=25");
		expect(first.body.complete).toBe(false);
		expect(first.body.nextCursor).toMatch(/^\d+:/);
	});

	it("a row inserted while a reader pages is not repeated and shifts nothing; the last page says complete", async () => {
		for (let i = 0; i < 12; i++) queue({ at: T0 + i * 1000 });
		const p1 = await history("limit=5&summary=false");
		const seen = p1.body.items.map((i: Json) => i.id);
		for (let i = 0; i < 4; i++) queue({ at: T0 + 500_000 + i }); // newer than anything the reader holds
		const rest = await allPages("limit=5", p1.body.nextCursor);
		const ids = rest.items.map((i) => i.id);
		expect(ids.filter((id) => seen.includes(id))).toEqual([]);
		expect(new Set(ids).size).toBe(ids.length);
		// every one of the original twelve was delivered exactly once across both reads; the four new ones sit above the cursor
		expect(new Set([...seen, ...ids]).size).toBe(12);
		const last = await history(`limit=100&summary=false`);
		expect(last.body.complete).toBe(true);
		expect(last.body.nextCursor).toBeNull();
	});

	it("rejects a cursor that is not one, rather than answering a silent first page", async () => {
		queue({});
		const r = await history("cursor=nonsense");
		expect(r.status).toBe(400);
		expect(r.body.error).toMatch(/nextCursor/);
	});
});

describe("attempts versus real runs, and the summary over the whole range (#1335)", () => {
	it("98 admission failures with no run and 2 real runs: 100 attempts, 2 runs — and the summary says so with a page of 3", async () => {
		for (let i = 0; i < 98; i++) queue({ status: "failed", stop: "refused: already done", issue: 3, at: T0 + i });
		const r1 = run({ at: T0 + 1000, issue: 8 });
		const r2 = run({ at: T0 + 2000, issue: 9 });
		queue({ status: "started", runId: r1, issue: 8, at: T0 + 1000 });
		queue({ status: "started", runId: r2, issue: 9, at: T0 + 2000 });
		const r = await history("limit=3");
		expect(r.body.items).toHaveLength(3);
		expect(r.body.summary).toMatchObject({ scope: "full_range", attempts: 100, runs: 2, admissionFailuresWithoutRun: 98, attemptsWithoutRun: 98 });
		expect(r.body.summary.byOutcome).toMatchObject({ admission_failed: 98, completed: 2 });
		expect(r.body.summary.byInstance[0]).toMatchObject({ instanceId: "i1", attempts: 100, runs: 2, admissionFailuresWithoutRun: 98 });
	});

	it("an attempt that became a run is ONE item carrying both, and a direct run with no entry is its own item — never counted twice", async () => {
		const r1 = run({ at: T0 + 10, issue: 5 });
		const q1 = queue({ status: "started", runId: r1, issue: 5, at: T0 + 9, request: "req-1" });
		const direct = run({ at: T0 + 20, issue: 6 });
		const r = await history();
		expect(r.body.items.map((i: Json) => `${i.kind}.${i.id}`).sort()).toEqual([`attempt.${q1}`, `run.${direct}`].sort());
		const attempt = r.body.items.find((i: Json) => i.kind === "attempt");
		expect(attempt).toMatchObject({ outcome: "completed", run: { id: r1, status: "completed" }, correlation: { queueEntryId: q1, runId: r1, requestId: "req-1" } });
		expect(r.body.summary).toMatchObject({ attempts: 1, runs: 2 });
	});

	it("the summary follows the filters across ALL pages, not the first", async () => {
		for (let i = 0; i < 40; i++) queue({ issue: i % 2 ? 7 : 8, status: "failed", at: T0 + i });
		const filtered = await history("issue=7&limit=5");
		expect(filtered.body.items).toHaveLength(5);
		expect(filtered.body.summary.attempts).toBe(20);
		const all = await allPages("issue=7&limit=7");
		expect(all.items).toHaveLength(20);
		expect(all.items.every((i) => i.issue === 7)).toBe(true);
	});

	it("derives an attempt's outcome from the queue when it has no run: queued, deferred, claimed, cancelled, failed admission", async () => {
		queue({ status: "pending" });
		queue({ status: "pending", deferrals: 2 });
		queue({ status: "running" });
		queue({ status: "cancelled" });
		queue({ status: "failed" });
		const r = await history();
		expect(r.body.summary.byOutcome).toEqual({ queued: 1, deferred: 1, claimed: 1, queue_cancelled: 1, admission_failed: 1 });
	});
});

describe("filters (#1335)", () => {
	beforeEach(() => {
		queue({ instance: "i1", repoId: "r1", issue: 1, status: "failed", at: T0 + 1 * MIN });
		queue({ instance: "i2", repoId: "r2", issue: 2, status: "pending", at: T0 + 2 * MIN });
		run({ instance: "i1", issue: 3, status: "failed", at: T0 + 3 * MIN });
		d1.exec(`INSERT INTO auto_pickup_log (id, instance_id, user_id, repo, issue_number, outcome, detail, created_at) VALUES ('pl-1', 'i1', 'u1', 'acme/app', 4, 'passed_over', 'already_done', ${T0 + 4 * MIN})`);
	});
	const kinds = async (q: string) => ((await history(q)).body.items as Json[]).map((i) => `${i.kind}:${i.issue}`).sort();

	it("narrows by instance, repo, issue, outcome, kind and time", async () => {
		expect(await kinds("instance_id=i2")).toEqual(["attempt:2"]);
		expect(await kinds("repo=acme/app")).toEqual(["attempt:1", "picker:4"]); // the run has no session, so no repo is recorded for it
		expect(await kinds("issue=3")).toEqual(["run:3"]);
		expect(await kinds("outcome=failed")).toEqual(["run:3"]);
		expect(await kinds("outcome=admission_failed")).toEqual(["attempt:1"]);
		expect(await kinds("kind=picker")).toEqual(["picker:4"]);
		expect(await kinds(`since=${T0 + 2 * MIN}&until=${T0 + 3 * MIN}`)).toEqual(["attempt:2", "run:3"]);
		expect(await kinds(`since=${new Date(T0 + 4 * MIN).toISOString()}`)).toEqual(["picker:4"]);
	});

	it("a malformed filter is a 400 naming it, never an unfiltered answer", async () => {
		for (const [q, text] of [
			["outcome=bogus", /outcome must be one of/],
			["kind=bogus", /kind must be one of/],
			["repo=not-a-repo", /owner\/name/],
			["issue=abc", /issue must be/],
			["issue=0", /issue must be/],
			["since=yesterday-ish", /since must be/],
			[`since=${T0 + MIN}&until=${T0}`, /since must not be after until/],
			["limit=0", /limit must be/],
			["limit=101", /limit must be/],
			["summary=maybe", /summary must be/],
		] as const) {
			const r = await history(q);
			expect(r.status, q).toBe(400);
			expect(r.body.error, q).toMatch(text);
		}
	});
});

describe("correlation and attribution (#1335)", () => {
	it("carries request, entry, run, session and machine, and says who acted without inventing it", async () => {
		d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, runner_node) VALUES ('s1', 'i1', 'r1', 'u1', 'mac-mini')`);
		const r1 = run({ id: "run-a", session: "s1", issue: 11 });
		queue({ id: "objq-human", status: "started", runId: r1, actor: "u1", request: "req-h", issue: 11, at: T0 + 5 });
		queue({ id: "objq-auto", meta: JSON.stringify({ autoPickup: { repo: "acme/app", issue: 12 } }), at: T0 + 6 });
		queue({ id: "objq-legacy", at: T0 + 7 });
		const r = await history();
		const by = (id: string) => (r.body.items as Json[]).find((i) => i.id === id) as Json;
		expect(by("objq-human")).toMatchObject({ machine: "mac-mini", actor: { kind: "owner", uid: "u1", verified: true }, correlation: { requestId: "req-h", queueEntryId: "objq-human", runId: "run-a", sessionId: "s1" } });
		expect(by("objq-auto")).toMatchObject({ repo: "acme/app", issue: 12, actor: { kind: "platform", via: "auto_pickup" }, outcome: "queued" });
		expect(by("objq-legacy").actor).toEqual({ kind: "unknown", legacy: true });
		expect(by("objq-legacy").repo).toBe("acme/app"); // from the entry's repo_id
	});

	it("a refused or duplicate request is an item of its own, with no run and no entry", async () => {
		d1.exec(`INSERT INTO loop_start_receipts (user_id, instance_id, request_id, input_json, state, response_json, created_at, updated_at, actor_uid)
		  VALUES ('u1', 'i1', 'req-dup', '{}', 'started', '{"duplicate_of":"run-9"}', ${T0}, ${T0}, 'u1'), ('u1', 'i1', 'req-no', '{}', 'not_started', '{"error":"busy"}', ${T0 + 1}, ${T0 + 1}, NULL),
		         ('u1', 'i1', 'req-ok', '{}', 'started', '{"runId":"run-1"}', ${T0 + 2}, ${T0 + 2}, 'u1')`);
		const r = await history("kind=request");
		expect((r.body.items as Json[]).map((i) => [i.correlation.requestId, i.outcome]).sort()).toEqual([["req-dup", "duplicate"], ["req-no", "not_started"]]);
		expect(r.body.summary.requests).toBe(2);
	});
});

describe("coverage says what is not recorded (#1335)", () => {
	it("work that began before the lifecycle ledger is flagged, not reconstructed; work after it with no events is `not_recorded`; with events, `recorded`", async () => {
		const old = queue({ at: T0 });
		const covered = queue({ at: T0 + 2 * MIN });
		const missing = queue({ at: T0 + 3 * MIN });
		event({ at: T0 + MIN, queueEntry: "objq-someone-else" }); // the ledger starts at T0 + 1 min
		event({ at: T0 + 2 * MIN, queueEntry: covered });
		const r = await history();
		const hist = (id: string) => (r.body.items as Json[]).find((i) => i.id === id)?.transitions.history;
		expect(hist(old)).toBe("predates_ledger");
		expect(hist(covered)).toBe("recorded");
		expect(hist(missing)).toBe("not_recorded");
		expect(r.body.coverage.status).toBe("partial");
		expect(r.body.coverage.gaps.join("\n")).toMatch(/1 attempt\(s\)\/run\(s\) on .* began before its lifecycle ledger started/);
		expect(r.body.coverage.ledgerStartedAt).toEqual([{ instanceId: "i1", at: new Date(T0 + MIN).toISOString() }]);
	});

	it("rows with no recorded issue cannot match an issue filter, and the response COUNTS them rather than hiding them", async () => {
		queue({ issue: 7 });
		queue({ issue: null });
		queue({ issue: null });
		run({ issue: null });
		const r = await history("issue=7");
		expect(r.body.items).toHaveLength(1);
		expect(r.body.coverage.gaps.join("\n")).toMatch(/2 attempt\(s\) in this range have no recorded issue.*NOT in the items/);
		expect(r.body.coverage.gaps.join("\n")).toMatch(/1 run\(s\) in this range have no recorded issue/);
		expect(r.body.coverage.status).toBe("partial");
	});

	it("a range that starts before anything was recorded says nothing older exists; deployment is stated as unobserved; retention is explicit", async () => {
		queue({ at: T0 });
		const r = await history(`since=${T0 - 86_400_000}`);
		expect(r.body.coverage.gaps.join("\n")).toMatch(/Nothing is recorded before .* the requested range starts earlier/);
		expect(r.body.coverage.deployment).toMatch(/not recorded against a run/);
		expect(r.body.coverage.retention).toMatchObject({ queue: expect.stringContaining("indefinitely"), mcpAudit: expect.stringContaining("90 days") });
		expect(r.body.items[0].deployment).toBeNull();
	});

	it("says when the picker's per-candidate skip reasons begin, and that older ones live only in detail text", async () => {
		queue({ at: T0 });
		let r = await history();
		expect(r.body.coverage.passedOverRecordedSince).toBeNull();
		expect(r.body.coverage.gaps.join("\n")).toMatch(/has not yet recorded a candidate it passed over/);
		d1.exec(`INSERT INTO auto_pickup_log (id, instance_id, user_id, repo, issue_number, outcome, detail, created_at) VALUES ('pl-1', 'i1', 'u1', 'acme/app', 4, 'passed_over', 'already_done', ${T0 + MIN})`);
		r = await history(`since=${T0}`);
		expect(r.body.coverage.passedOverRecordedSince).toBe(new Date(T0 + MIN).toISOString());
		expect(r.body.coverage.gaps.join("\n")).toMatch(/records each candidate it passed over from .*; before that/);
		r = await history(`since=${T0 + MIN}`);
		expect(r.body.coverage.gaps.join("\n")).not.toMatch(/passed over/);
	});

	it("paging to the end is not coverage: `complete` is true on the last page while coverage is still partial", async () => {
		queue({ at: T0 });
		const r = await history();
		expect(r.body.complete).toBe(true);
		expect(r.body.coverage.status).toBe("partial");
	});
});

describe("isolation, bounds and redaction (#1335)", () => {
	it("one owner never sees another's rows, and cannot filter on another's instance", async () => {
		queue({ instance: "x2", user: "u2", repoId: "rx", issue: 99 });
		run({ instance: "x2", user: "u2" });
		d1.exec(`INSERT INTO auto_pickup_log (id, instance_id, user_id, repo, issue_number, outcome, detail, created_at) VALUES ('pl-x', 'x2', 'u2', 'other/secret', 99, 'passed_over', 'theirs', ${T0})`);
		queue({ instance: "i1" });
		const mine = await history();
		expect(JSON.stringify(mine.body)).not.toMatch(/other\/secret|x2|theirs/);
		expect(mine.body.summary.attempts).toBe(1);
		expect((await history("instance_id=x2")).status).toBe(404);
		uid.current = "u2";
		const theirs = await history();
		expect(theirs.body.summary).toMatchObject({ attempts: 1, runs: 1, pickerDecisions: 1 });
		expect(JSON.stringify(theirs.body)).not.toMatch(/acme\//);
	});

	it("a page never exceeds 100 items however many exist; reasons are clipped; a token in a reason is redacted; an objective's text is never returned", async () => {
		for (let i = 0; i < 130; i++) queue({ at: T0 + i, issue: 1, stop: i === 0 ? `refused with ghp_${"a".repeat(30)} ${"x".repeat(2000)}` : null, status: "failed" });
		const r = await history("limit=100");
		expect(r.body.items).toHaveLength(100);
		expect(r.body.complete).toBe(false);
		const oldest = (await history(`limit=100&cursor=${encodeURIComponent(r.body.nextCursor)}`)).body.items as Json[];
		const reason = oldest.find((i) => i.attempt?.reason)?.attempt.reason as string;
		expect(reason).not.toMatch(/ghp_a+/);
		expect(reason).toContain("[redacted]");
		expect(reason.length).toBeLessThan(400);
		expect(JSON.stringify(r.body) + JSON.stringify(oldest)).not.toContain("SECRET-OBJECTIVE-TEXT");
	});

	it("survives queue metadata that is not JSON", async () => {
		queue({ meta: "this is {not json", issue: 5 });
		const r = await history("issue=5");
		expect(r.status).toBe(200);
		expect(r.body.items).toHaveLength(1);
	});

	it("is read-only: a read writes nothing to any source", async () => {
		queue({});
		run({});
		const count = () => ["instance_objective_queue", "agent_loop_runs", "auto_pickup_log", "loop_start_receipts", "objective_lifecycle_events"].map((t) => (d1.sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
		const before = count();
		await history();
		await history("limit=1");
		expect(count()).toEqual(before);
	});
});

describe("the rows are stamped where they are created (#1335)", () => {
	it("a queued objective and a started run record the issue their objective names; one that names none records none", async () => {
		const e = await enqueueObjective(env, { instanceId: "i1", userId: "u1", repoId: "r1", objective: "Implement GitHub issue #1335 in acme/app" });
		await createLoopRun(env, { runId: "run-stamped", userId: "u1", instanceId: "i1", objective: "Work issue #55 on it", maxIterations: 5, startedAt: T0 });
		await createLoopRun(env, { runId: "run-plain", userId: "u1", instanceId: "i1", objective: "Tidy the readme", maxIterations: 5, startedAt: T0 });
		expect((d1.sqlite.prepare("SELECT issue_number AS n FROM instance_objective_queue WHERE id = ?").get(e.id) as { n: number }).n).toBe(1335);
		expect((d1.sqlite.prepare("SELECT issue_number AS n FROM agent_loop_runs WHERE run_id = 'run-stamped'").get() as { n: number }).n).toBe(55);
		expect((d1.sqlite.prepare("SELECT issue_number AS n FROM agent_loop_runs WHERE run_id = 'run-plain'").get() as { n: number | null }).n).toBeNull();
	});
});

describe("the picker's decisions are recorded and linked (#1335)", () => {
	const open = (n: number) => ({ number: n, title: `issue ${n}`, state: "open", labels: [] as string[], assignees: [] as string[], comments: 0, updatedAt: "", url: `u/${n}` });
	function doneRun(n: number, finishedAt: number) {
		d1.exec(`INSERT OR IGNORE INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES ('s-${n}', 'i1', 'r1', 'u1')`);
		d1.exec(`INSERT OR IGNORE INTO tickets (id, instance_id, user_id, job_key, title, created_by, repo_id, issue_number) VALUES ('t-${n}', 'i1', 'u1', 'issue:r1#${n}', 'T', 'human', 'r1', ${n})`);
		d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, stop_reason, max_iterations, started_at, finished_at, session_id, ticket_id)
		  VALUES ('done-${n}', 'u1', 'i1', 'Implement GitHub issue #${n}', 'completed', 'done', 10, 1, ${finishedAt}, 's-${n}', 't-${n}')`);
	}
	const deps = () => ({ listOpenIssues: async () => ({ issues: [open(3), open(8)], unreadable: false }), postComment: async () => true, notify: async () => undefined, startQueued: async () => ({ drained: true, started: true }) });
	const NOW = Date.now();

	it("a candidate passed over is a row with its reason, written once an hour; the one chosen is an attempt linked to its selection, as the platform's own act", async () => {
		await setAutoPickup(env, "i1", "u1", { enabled: true });
		doneRun(3, NOW - 86_400_000);
		expect(await runAutoPickup(env, "i1", "u1", deps(), NOW)).toMatchObject({ started: true, issue: 8 });
		const passed = d1.sqlite.prepare("SELECT repo, issue_number, detail FROM auto_pickup_log WHERE outcome = 'passed_over'").all() as Array<{ repo: string; issue_number: number; detail: string }>;
		expect(passed).toEqual([{ repo: "acme/app", issue_number: 3, detail: expect.stringContaining("already_done") }]);
		// a repeat wake does not add a row for #3: it resumes the entry already queued, and a repeated skip is written once an hour
		await runAutoPickup(env, "i1", "u1", deps(), NOW + 5000);
		expect(d1.sqlite.prepare("SELECT count(*) AS n FROM auto_pickup_log WHERE outcome = 'passed_over'").get()).toEqual({ n: 1 });

		const r = await history("repo=acme/app&limit=50");
		const items = r.body.items as Json[];
		const skip = items.find((i) => i.kind === "picker");
		expect(skip).toMatchObject({ outcome: "passed_over", issue: 3, repo: "acme/app", picker: { outcome: "passed_over", detail: expect.stringContaining("already_done") } });
		const attempt = items.find((i) => i.kind === "attempt" && i.issue === 8) as Json;
		expect(attempt).toMatchObject({ repo: "acme/app", actor: { kind: "platform", via: "auto_pickup" }, picker: { outcome: "started" }, correlation: { queueEntryId: expect.stringMatching(/^objq-/) } });
		expect(r.body.summary.pickerDecisions).toBe(1);

		// …and the enqueue the trigger made is a recorded `queued` transition, so the lifecycle has no hole for it.
		const life = await listLifecycle(env, { userId: "u1", instanceId: "i1", filter: { queueEntryId: attempt.correlation.queueEntryId } });
		expect(life.events.map((e) => e.event)).toContain("queued");
		expect(life.events.find((e) => e.event === "queued")?.actor).toEqual({ kind: "platform" });
		expect(life.coverage_gaps.join("\n")).not.toMatch(/no "queued" event/);
	});

	it("filtering the history to the skipped issue returns the skip, and to the chosen one returns its attempt", async () => {
		await setAutoPickup(env, "i1", "u1", { enabled: true });
		doneRun(3, NOW - 86_400_000);
		await runAutoPickup(env, "i1", "u1", deps(), NOW);
		expect(((await history("issue=3&kind=picker")).body.items as Json[]).map((i) => i.outcome)).toEqual(["passed_over"]);
		expect(((await history("issue=8&kind=attempt")).body.items as Json[]).map((i) => i.issue)).toEqual([8]);
	});
});
