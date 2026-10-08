/**
 * Confirming a fan-out of queued starts in one read (#935).
 *
 * Live: four `coding_loop_start {queue_if_busy}` calls fired together behind a busy repo. Some answered
 * inline, some as "still provisioning", and `coding_loop_queue` then read EMPTY — the starts were still
 * inside their confirmation window, so nothing had been enqueued yet — which looked like none had
 * landed. The queue view now says what it sits behind and which starts are still on their way in.
 * Real schema; only `requireUser` is faked.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import type { Env } from "../types.js";

vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => ({ uid: "u1", roles: [] }) };
});

const { registerLoopQueueRoutes } = await import("./loop-queue-routes.js");

let d1: RealSchemaD1;
const NOW = Date.now();
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1')`);
	d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't935-coder', 'Coder')`);
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'ag', 'u1', 'active', '{}')`);
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name) VALUES ('r1', 'i1', 'u1', 'platform')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, user_id, repo_id, client_type, status) VALUES ('s1', 'i1', 'u1', 'r1', 'claude', 'active')`);
	// #930 is working the repo …
	d1.exec(`INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at, session_id) VALUES ('run-930', 'u1', 'i1', 'Fix issue #930', 'running', 10, ${NOW - 600_000}, 's1')`);
	// … #931 already landed in the queue …
	d1.exec(`INSERT INTO instance_objective_queue (id, instance_id, repo_id, user_id, objective, status, created_at) VALUES ('objq-931', 'i1', 'r1', 'u1', 'Fix issue #931', 'pending', ${NOW - 20_000})`);
	// … and #932, #933 are still inside their confirmation window: provisioning, nothing enqueued yet.
	for (const [req, issue, ago] of [["req-932", 932, 8_000], ["req-933", 933, 3_000]] as const) {
		d1.exec(`INSERT INTO loop_start_receipts (user_id, instance_id, request_id, input_json, state, created_at, updated_at)
		         VALUES ('u1', 'i1', '${req}', '${JSON.stringify({ objective: `Fix issue #${issue}`, repoId: "r1", queueIfBusy: true })}', 'provisioning', ${NOW - ago}, ${NOW - ago})`);
	}
});
afterEach(() => d1.close());

async function queue(qs = "") {
	const router = new Hono<{ Bindings: Env }>();
	registerLoopQueueRoutes(router);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 404) : c.json({ error: String(e) }, 500)));
	const res = await router.request(`/i1/loop/queue${qs}`, {}, { DB: d1.DB } as unknown as Env);
	expect(res.status).toBe(200);
	return (await res.json()) as { entries: Array<{ id: string }>; activeRun: { runId: string } | null; inFlightStarts: Array<{ requestId: string; objective: string | null; ageMs: number }> };
}

describe("coding_loop_queue during a fan-out (#935)", () => {
	it("shows the run it sits behind, the entries already queued, and the starts still on their way in", async () => {
		const q = await queue("?repo_id=r1");
		expect(q.entries.map((e) => e.id)).toEqual(["objq-931"]);
		expect(q.activeRun).toMatchObject({ runId: "run-930", objective: "Fix issue #930" });
		expect(q.inFlightStarts.map((s) => s.requestId).sort()).toEqual(["req-932", "req-933"]);
		expect(q.inFlightStarts.find((s) => s.requestId === "req-933")?.objective).toBe("Fix issue #933");
	});

	it("a settled start is no longer in flight — its account is the entry or run it produced", async () => {
		d1.exec(`UPDATE loop_start_receipts SET state = 'queued' WHERE request_id = 'req-932'`);
		expect((await queue()).inFlightStarts.map((s) => s.requestId)).toEqual(["req-933"]);
	});

	it("an idle repo with nothing lined up reads as such", async () => {
		d1.exec(`DELETE FROM loop_start_receipts`);
		d1.exec(`DELETE FROM instance_objective_queue`);
		d1.exec(`UPDATE agent_loop_runs SET status = 'completed'`);
		// `handoff` is null here because this read names no repo (#984): the handover state is a fact
		// about one checkout, and an instance-wide read has no single one to report.
		expect(await queue()).toEqual({ entries: [], activeRun: null, inFlightStarts: [], handoff: null });
	});
});
