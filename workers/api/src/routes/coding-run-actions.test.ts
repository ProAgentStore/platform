/** The owner's abandon and worktree-discard routes, driven as the owner and as a stranger (#1709). */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { realSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import { RUNNER_ROUTES } from "../lib/runner-routes.js";
import { registerRunActionRoutes } from "./coding-run-actions.js";
import type { Env } from "../types.js";

const { callRunner, getRunnerConn, getBoundRunnerConn } = vi.hoisted(() => ({ callRunner: vi.fn(), getRunnerConn: vi.fn(), getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/runner-client.js")>()), callRunner, getRunnerConn, getBoundRunnerConn }));

const SECRET = "run-actions-test-secret";
const conn = { runnerNode: "Macmini.modem" };
const UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SESSION = `csess_${UUID}`;
const HEAD = "b".repeat(40);

function build() {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, branch) VALUES ('r1', 'i1', 'u1', 'o/r', '/w/r', 'main')");
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, branch) VALUES ('r2', 'i1', 'u1', 'o/other', '/w/o', 'main')");
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, status, client_type) VALUES ('${SESSION}', 'i1', 'r1', 'u1', 'suspended', 'claude')`);
	d1.exec("INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, max_iterations, started_at) VALUES ('run-1', 'u1', 'i1', 'x', 'running', 10, 1)");
	const env = { SESSION_SIGNING_KEY: SECRET, DB: d1.DB, CODING_SESSION: { get: async () => ({ sendEvent: async () => undefined, status: async () => ({ status: "running" }) }) } } as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	const routes = new Hono<{ Bindings: Env }>();
	registerRunActionRoutes(routes);
	app.route("/v1/instances", routes);
	app.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	const get = async (path: string, uid = "u1") => app.request(`/v1/instances/i1/coding${path}`, { headers: { Authorization: `Bearer ${await signSession(uid, SECRET, { roles: ["user"] })}` } }, env);
	const call = async (path: string, body?: unknown, uid = "u1") => {
		const token = await signSession(uid, SECRET, { roles: ["user"] });
		return app.request(`/v1/instances/i1/coding${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }, env);
	};
	return { call, get, d1 };
}

beforeEach(() => {
	callRunner.mockReset();
	getRunnerConn.mockReset().mockResolvedValue(conn);
	getBoundRunnerConn.mockReset().mockResolvedValue(conn);
});

describe("POST /coding/runs/:runId/abandon", () => {
	it("abandons the owner's run and 404s anyone else's", async () => {
		const { call, d1 } = build();
		expect((await call("/runs/run-1/abandon", {}, "u2")).status).toBe(404);
		expect((await call("/runs/nope/abandon")).status).toBe(404);
		const res = await call("/runs/run-1/abandon");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, runId: "run-1", outcome: "cancelling" });
		expect((d1.sqlite.prepare("SELECT cancel_requested AS c FROM agent_loop_runs WHERE run_id = 'run-1'").get() as { c: number }).c).toBe(1);
	});
});

describe("POST /coding/repos/:repoId/worktrees/discard", () => {
	const named = { runner_node: "Macmini.modem", session_id: SESSION };

	it("needs the machine, a session of THIS repo and this user, and the head to execute", async () => {
		const { call } = build();
		expect((await call("/repos/r1/worktrees/discard", { session_id: SESSION })).status).toBe(400);
		expect((await call("/repos/r1/worktrees/discard", { runner_node: "Macmini.modem" })).status).toBe(400);
		expect((await call("/repos/r1/worktrees/discard", { runner_node: "Macmini.modem", session_id: "csess_nope" })).status).toBe(400);
		expect((await call("/repos/r2/worktrees/discard", named)).status).toBe(404);
		expect((await call("/repos/r1/worktrees/discard", named, "u2")).status).toBe(404);
		expect((await call("/repos/r1/worktrees/discard", { ...named, dry_run: false })).status).toBe(400);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("previews by default and sends the run's uuid; executing passes the head it read", async () => {
		callRunner.mockResolvedValue({ ok: true, dryRun: true, head: HEAD });
		const { call } = build();
		expect((await call("/repos/r1/worktrees/discard", named)).status).toBe(200);
		expect(callRunner.mock.calls[0].slice(1, 3)).toEqual(["/coding/worktree-discard", { workDir: "/w/r", repoId: "r1", runId: UUID, dryRun: true, expectedHead: undefined }]);
		callRunner.mockResolvedValue({ ok: true, discardedFiles: 2, pinned: null });
		expect((await call("/repos/r1/worktrees/discard", { ...named, dry_run: false, expected_head: HEAD })).status).toBe(200);
		expect(callRunner.mock.calls[1][2]).toMatchObject({ runId: UUID, dryRun: false, expectedHead: HEAD });
	});

	it("the preview is a GET (a read) that always asks the machine for a dry run", async () => {
		callRunner.mockResolvedValue({ ok: true, dryRun: true, head: HEAD });
		const { get } = build();
		expect((await get(`/repos/r1/worktrees/discard?runner_node=Macmini.modem&session_id=${SESSION}`)).status).toBe(200);
		expect(callRunner.mock.calls[0][2]).toMatchObject({ runId: UUID, dryRun: true });
		expect((await get(`/repos/r1/worktrees/discard?session_id=${SESSION}`)).status).toBe(400);
		expect((await get(`/repos/r1/worktrees/discard?runner_node=Macmini.modem&session_id=${SESSION}`, "u2")).status).toBe(404);
	});

	it("a refusal the machine reports is a 409; an old runner names the CLI; an offline machine is 503", async () => {
		const { call } = build();
		callRunner.mockResolvedValue({ ok: false, reason: "stale_head" });
		expect((await call("/repos/r1/worktrees/discard", { ...named, dry_run: false, expected_head: HEAD })).status).toBe(409);
		callRunner.mockRejectedValue(new Error("runner /coding/worktree-discard → 404 not found"));
		const old = await call("/repos/r1/worktrees/discard", named);
		expect(old.status).toBe(422);
		expect(((await old.json()) as { error: string }).error).toMatch(/CLI 0\.4\.\d+ or newer/);
		getRunnerConn.mockResolvedValue(null);
		expect((await call("/repos/r1/worktrees/discard", named)).status).toBe(503);
	});

	it("is a never-repeat runner route", () => {
		expect(RUNNER_ROUTES["/coding/worktree-discard"].retry).toBe("never");
	});
});
