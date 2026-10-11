/**
 * The objective lifecycle (#1017), driven through the real routes on the real migrated schema.
 *
 * Real: `POST /loop` (receipts, queue_if_busy, #925 dedup), the queue routes, `GET /loop`, the
 * lifecycle route, the queue drain and `finishLoopRun`. Faked: only the driver (a simulated start that
 * either refuses or opens a real run row) and the account gates — the seams `tools-loop-dedupe.test.ts`
 * uses. No real queue, run, credential or owner identifier.
 *
 * Invariants protected: every accepted receipt has exactly one explainable current disposition with
 * stable joins; a run started from the queue names its entry and request; actor identity is the
 * verified session uid, never request-key text, and legacy rows read `unknown`; every advertised
 * continuation pages fully, without gaps or duplicates; and every read is read-only.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

const driverStart = vi.fn();
const uid = { current: "u1" };

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: uid.current, roles: [] }) };
});
vi.mock("./instances-runtime.js", async () => {
	const actual = await vi.importActual<typeof import("./instances-runtime.js")>("./instances-runtime.js");
	return { ...actual, requireOwnedInstance: async () => undefined };
});
vi.mock("../lib/billing.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/billing.js")>("../lib/billing.js");
	return { ...actual, requirePro: async () => undefined };
});
vi.mock("../lib/agent-capabilities.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/agent-capabilities.js")>("../lib/agent-capabilities.js");
	return { ...actual, capabilitiesForInstance: async () => ({ workflow: "CODING_SESSION" }) };
});
vi.mock("../lib/loop-limits-store.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/loop-limits-store.js")>("../lib/loop-limits-store.js");
	return { ...actual, readLoopLimits: async () => ({}) };
});
vi.mock("../lib/delegation-budget-store.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/delegation-budget-store.js")>("../lib/delegation-budget-store.js");
	return { ...actual, openBudget: async () => ({ id: "bud-1" }), resolveAccountCeilings: async () => ({ loopMaxIterations: 50 }) };
});
vi.mock("../lib/loop-drivers.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/loop-drivers.js")>("../lib/loop-drivers.js");
	return { ...actual, loopDriverFor: () => ({ id: "coding", label: "coding", start: (...a: unknown[]) => driverStart(...a) }) };
});

const { toolRoutes } = await import("./tools.js");
const { tryDequeueAndStart } = await import("../lib/objective-queue-start.js");
const { createLoopRun, finishLoopRun } = await import("../lib/agent-loop-store.js");

let d1: RealSchemaD1;
let env: Env;
let runSeq = 0;
const BUSY = { ok: false, status: 409, reason: "busy", error: "platform is already being worked on" };
/** A simulated start that opens a REAL run row, as every driver does before answering ok. */
const startsRun = () =>
	driverStart.mockImplementationOnce(async (input: { env: Env; instanceId: string; userId: string; objective: string }) => {
		const runId = `run-${++runSeq}`;
		await createLoopRun(input.env, { runId, userId: input.userId, instanceId: input.instanceId, objective: input.objective, maxIterations: 10, startedAt: 1_000 + runSeq });
		return { ok: true, runId, driver: "coding" };
	});

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec("INSERT OR IGNORE INTO users (id, github_login) VALUES ('u2', 'u2')");
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'platform')`);
	env = { DB: d1.DB } as unknown as Env;
	uid.current = "u1";
	runSeq = 0;
	driverStart.mockReset();
	driverStart.mockResolvedValue(BUSY);
});
afterEach(() => d1.close());

function app() {
	const router = new Hono<{ Bindings: Env }>();
	router.route("/v1/instances", toolRoutes);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 409) : c.json({ error: String(e) }, 500)));
	return router;
}
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as never;
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
	const res = await app().request(`/v1/instances/i1${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined }, env, ctx);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const start = (body: Record<string, unknown>, client = "mcp") => call("POST", "/loop", { repoId: "r1", ...body }, { "X-PAGS-Client": client });
const receipts = async () => ((await call("GET", "/loop?include_starts=true")).body.starts as Array<Record<string, unknown>>);
const receipt = async (requestId: string) => (await receipts()).find((r) => r.requestId === requestId) as Record<string, unknown>;
const lifecycle = async (q: string) => (await call("GET", `/loop/lifecycle?${q}`)).body as { events: Array<{ event: string; actor: Record<string, unknown>; runId: string | null; queueEntryId: string | null; seq: number }>; nextCursor: number | null; complete: boolean };
const events = async (q: string) => (await lifecycle(q)).events.map((e) => e.event);
const counts = () => ({
	queue: (d1.sqlite.prepare("SELECT count(*) AS n FROM instance_objective_queue").get() as { n: number }).n,
	receipts: (d1.sqlite.prepare("SELECT count(*) AS n FROM loop_start_receipts").get() as { n: number }).n,
	runs: (d1.sqlite.prepare("SELECT count(*) AS n FROM agent_loop_runs").get() as { n: number }).n,
	lifecycle: (d1.sqlite.prepare("SELECT count(*) AS n FROM objective_lifecycle_events").get() as { n: number }).n,
});

describe("one objective, end to end: queued → deferred → admitted → run → finished (#1017)", () => {
	it("every handle reconstructs the same history, and the receipt's present tense follows it", async () => {
		const q = await start({ requestId: "req-1", objective: "Work issue #101 on the platform.", queueIfBusy: true });
		expect(q).toMatchObject({ status: 202, body: { queued: true, startState: "queued" } });
		const entryId = (q.body.entry as { id: string }).id;
		expect(await receipt("req-1")).toMatchObject({ startState: "queued", current: { state: "pending", queueEntryId: entryId } });

		// The drain is refused once (busy) — deferred, entry kept — then admits it.
		expect(await tryDequeueAndStart(env, "i1", "r1", "u1")).toMatchObject({ requeued: true });
		startsRun();
		const admitted = await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(admitted).toMatchObject({ started: true, runId: "run-1" });
		expect(await receipt("req-1")).toMatchObject({ startState: "queued", current: { state: "running", runId: "run-1", queueEntryId: entryId } });

		// A run started from the queue names its entry and its request — live and in history.
		const run = (await call("GET", "/loop/run-1")).body as { queueEntryId?: string; requestId?: string };
		expect(run).toMatchObject({ queueEntryId: entryId, requestId: "req-1" });

		await finishLoopRun(env, "run-1", "done", "shipped", 5_000);
		expect(await receipt("req-1")).toMatchObject({ startState: "queued", current: { state: "completed", runId: "run-1", stopReason: "done" } });

		const expected = ["requested", "queued", "deferred", "admitted", "run_finished"];
		expect(await events("request_id=req-1")).toEqual(expected);
		expect(await events(`queue_entry_id=${entryId}`)).toEqual(expected);
		expect(await events("run_id=run-1")).toEqual(expected);
	});
});

describe("every way an accepted request can end has one explainable disposition", () => {
	it("a duplicate request for the same issue is deduplicated onto the first entry, not inserted", async () => {
		const first = await start({ requestId: "req-1", objective: "Work issue #202.", queueIfBusy: true });
		const dup = await start({ requestId: "req-2", objective: "Work issue #202.", queueIfBusy: true });
		const entryId = (first.body.entry as { id: string }).id;
		expect(dup.body).toMatchObject({ duplicate_of: entryId });
		expect(counts().queue).toBe(1);
		expect(await receipt("req-2")).toMatchObject({ current: { state: "pending", queueEntryId: entryId } });
		expect(await events("request_id=req-2")).toEqual(["requested", "deduplicated"]);
	});

	it("the same request key replays its answer and records the replay — no second entry or run", async () => {
		await start({ requestId: "req-1", objective: "Work issue #203.", queueIfBusy: true });
		await start({ requestId: "req-1", objective: "Work issue #203.", queueIfBusy: true });
		expect(counts()).toMatchObject({ queue: 1, receipts: 1 });
		expect(await events("request_id=req-1")).toEqual(["requested", "queued", "request_replayed"]);
	});

	it("a deliberate retry after an inspected terminal outcome is allowed — a new objective, not a duplicate", async () => {
		await start({ requestId: "req-1", objective: "Work issue #204.", queueIfBusy: true });
		const entry = (d1.sqlite.prepare("SELECT id FROM instance_objective_queue").get() as { id: string }).id;
		await call("DELETE", `/loop/queue/${entry}`);
		const retry = await start({ requestId: "req-2", objective: "Work issue #204.", queueIfBusy: true });
		expect(retry.body).not.toHaveProperty("duplicate_of");
		expect(counts().queue).toBe(2);
	});

	it("an owner cancel is attributed to the verified owner, and the receipt says the entry was cancelled", async () => {
		const q = await start({ requestId: "req-1", objective: "Work issue #205.", queueIfBusy: true });
		const entryId = (q.body.entry as { id: string }).id;
		expect((await call("DELETE", `/loop/queue/${entryId}`, undefined, { "X-PAGS-Client": "console" })).status).toBe(200);
		expect(await receipt("req-1")).toMatchObject({ current: { state: "queue_cancelled", queueEntryId: entryId } });
		const cancelled = (await lifecycle("request_id=req-1")).events.find((e) => e.event === "cancelled");
		expect(cancelled?.actor).toEqual({ kind: "owner", uid: "u1", verified: true, clientClaimed: "console" });
	});

	it("a structural admission failure is recorded as such", async () => {
		await start({ requestId: "req-1", objective: "Work issue #206.", queueIfBusy: true });
		driverStart.mockResolvedValueOnce({ ok: false, status: 409, error: "This coding agent has no repository yet." });
		await tryDequeueAndStart(env, "i1", "r1", "u1");
		expect(await receipt("req-1")).toMatchObject({ current: { state: "admission_failed", reason: "This coding agent has no repository yet." } });
		expect(await events("request_id=req-1")).toEqual(["requested", "queued", "admission_failed"]);
	});

	it("a direct start links its run to the request; a refusal is not_started", async () => {
		startsRun();
		await start({ requestId: "req-1", objective: "Work issue #207." });
		expect(await receipt("req-1")).toMatchObject({ startState: "started", current: { state: "running", runId: "run-1" } });
		expect((d1.sqlite.prepare("SELECT request_id FROM agent_loop_runs WHERE run_id = 'run-1'").get() as { request_id: string }).request_id).toBe("req-1");

		await start({ requestId: "req-2", objective: "Work issue #208." });
		expect(await receipt("req-2")).toMatchObject({ startState: "not_started", current: { state: "not_started" } });
		expect(await events("request_id=req-2")).toEqual(["requested", "not_started"]);
	});

	it("a crash mid-start is outcome_unknown — never claimed as not started, and nothing is replayed", async () => {
		driverStart.mockRejectedValueOnce(new Error("worker lost"));
		const res = await start({ requestId: "req-1", objective: "Work issue #209." });
		expect(res.status).toBe(503);
		expect(await receipt("req-1")).toMatchObject({ startState: "unknown", current: { state: "outcome_unknown" } });
		expect(await events("request_id=req-1")).toEqual(["requested", "outcome_unknown"]);
		// A reconnect that reads back does not re-run it.
		await receipts();
		expect(driverStart).toHaveBeenCalledTimes(1);
	});
});

describe("attribution is the verified session, never request-key text", () => {
	it("records the session uid and the CLAIMED client, whatever the request key says", async () => {
		await start({ requestId: "owner-is-u2-admin", objective: "Work issue #301.", queueIfBusy: true }, "mcp");
		expect(await receipt("owner-is-u2-admin")).toMatchObject({ attribution: { kind: "owner", uid: "u1", verified: true, clientClaimed: "mcp" } });
		const entry = (await call("GET", "/loop/queue?status=all")).body.entries as Array<Record<string, unknown>>;
		expect(entry[0]).toMatchObject({ requestId: "owner-is-u2-admin", attribution: { kind: "owner", uid: "u1", verified: true, clientClaimed: "mcp" } });
	});

	it("an undeclared or unknown client claim is recorded as no claim", async () => {
		await start({ requestId: "req-1", objective: "Work issue #302.", queueIfBusy: true }, "definitely-the-owner");
		expect(await receipt("req-1")).toMatchObject({ attribution: { kind: "owner", uid: "u1", clientClaimed: null } });
	});

	it("a receipt and a queue entry from before attribution read back as unknown legacy", async () => {
		d1.exec(`INSERT INTO loop_start_receipts (user_id, instance_id, request_id, input_json, state, response_json, response_status, created_at, updated_at)
		  VALUES ('u1', 'i1', 'legacy-1', '{}', 'queued', '{"queued":true,"entry":{"id":"objq-legacy"}}', 202, 1, 1)`);
		d1.exec(`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at) VALUES ('objq-legacy', 'i1', 'r1', 'u1', 'old', 'pending', 1)`);
		expect(await receipt("legacy-1")).toMatchObject({ attribution: { kind: "unknown", legacy: true }, current: { state: "pending", queueEntryId: "objq-legacy" } });
		const entries = (await call("GET", "/loop/queue?status=all")).body.entries as Array<Record<string, unknown>>;
		expect(entries.find((e) => e.id === "objq-legacy")).toMatchObject({ attribution: { kind: "unknown", legacy: true } });
		// …and it has no fabricated history.
		expect(await events("request_id=legacy-1")).toEqual([]);
	});

	it("another account's history is never returned, even for the same handle", async () => {
		await start({ requestId: "shared-key", objective: "Work issue #303.", queueIfBusy: true });
		uid.current = "u2";
		expect(await events("request_id=shared-key")).toEqual([]);
	});
});

describe("every advertised continuation pages fully, without gaps or duplicates", () => {
	it("start receipts: three pages of 20/20/5 via starts_offset, then complete", async () => {
		for (let i = 0; i < 45; i++) {
			// Tied timestamps on purpose — the tie-break is what keeps a page boundary still.
			d1.exec(`INSERT INTO loop_start_receipts (user_id, instance_id, request_id, input_json, state, created_at, updated_at) VALUES ('u1', 'i1', 'k${String(i).padStart(2, "0")}', '{}', 'not_started', ${1000 + Math.floor(i / 3)}, 1)`);
		}
		const seen: string[] = [];
		let offset: number | null = 0;
		const pages: number[] = [];
		while (offset !== null) {
			const body = (await call("GET", `/loop?include_starts=true&starts_offset=${offset}`)).body as { starts: Array<{ requestId: string }>; startsNextOffset: number | null; startsComplete: boolean; startsTotal: number };
			pages.push(body.starts.length);
			seen.push(...body.starts.map((s) => s.requestId));
			expect(body.startsComplete).toBe(body.startsNextOffset === null);
			offset = body.startsNextOffset;
		}
		expect(pages).toEqual([20, 20, 5]);
		expect(new Set(seen).size).toBe(45);
	});

	it("runs: more than one page via offset", async () => {
		for (let i = 0; i < 60; i++) await createLoopRun(env, { runId: `r${String(i).padStart(2, "0")}`, userId: "u1", instanceId: "i1", objective: "x", maxIterations: 1, startedAt: 1000 + Math.floor(i / 4) });
		const seen = new Set<string>();
		let offset: number | null = 0;
		while (offset !== null) {
			const body = (await call("GET", `/loop?offset=${offset}`)).body as { runs: Array<{ runId: string }>; nextOffset: number | null };
			for (const r of body.runs) seen.add(r.runId);
			offset = body.nextOffset;
		}
		expect(seen.size).toBe(60);
	});

	it("queue history (status=all) and lifecycle events page to completion", async () => {
		for (let i = 0; i < 7; i++) await start({ requestId: `req-${i}`, objective: `Work issue #${400 + i}.`, queueIfBusy: true });
		const entries: string[] = [];
		let offset: number | null = 0;
		while (offset !== null) {
			const body = (await call("GET", `/loop/queue?status=all&limit=3&offset=${offset}`)).body as { entries: Array<{ id: string }>; nextOffset: number | null; complete: boolean; scope: string };
			expect(body.scope).toBe("all");
			entries.push(...body.entries.map((e) => e.id));
			offset = body.nextOffset;
		}
		expect(new Set(entries).size).toBe(7);

		const seqs: number[] = [];
		let cursor: number | null = 0;
		let last: { complete: boolean } = { complete: false };
		while (cursor !== null) {
			const page = await lifecycle(`limit=4&cursor=${cursor}`);
			seqs.push(...page.events.map((e) => e.seq));
			last = page;
			cursor = page.nextCursor;
		}
		expect(last.complete).toBe(true);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(seqs.length).toBe(14); // requested + queued, per request
	});

	it("the pending-only queue is labelled as such", async () => {
		expect((await call("GET", "/loop/queue")).body).toMatchObject({ scope: "pending" });
	});

	it("refuses a cursor that is not a previous page's", async () => {
		expect((await call("GET", "/loop/lifecycle?cursor=abc")).status).toBe(400);
	});
});

describe("a read-only audit changes nothing", () => {
	it("reading receipts, queue history and lifecycle writes no row and starts nothing", async () => {
		await start({ requestId: "req-1", objective: "Work issue #501.", queueIfBusy: true });
		const before = counts();
		const calls = driverStart.mock.calls.length;
		await receipts();
		await call("GET", "/loop/queue?status=all");
		await call("GET", "/loop/queue");
		await lifecycle("request_id=req-1");
		expect(counts()).toEqual(before);
		expect(driverStart.mock.calls.length).toBe(calls);
	});
});
