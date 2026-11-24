/** The branch and stash routes, driven as the owner (#1700, #1701): the tenant gate, the exact-mutation contract, and each named failure's status. */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import { realSchemaD1, seedTenant } from "../lib/d1-sqlite.js";
import { RUNNER_ROUTES } from "../lib/runner-routes.js";
import { RunnerUnreachableError } from "../lib/runner-unreachable.js";
import { registerBranchActionRoutes } from "./coding-branch-actions.js";
import type { Env } from "../types.js";

const { callRunner, getRunnerConn, getBoundRunnerConn } = vi.hoisted(() => ({ callRunner: vi.fn(), getRunnerConn: vi.fn(), getBoundRunnerConn: vi.fn() }));
vi.mock("../lib/runner-client.js", async (orig) => ({ ...(await orig<typeof import("../lib/runner-client.js")>()), callRunner, getRunnerConn, getBoundRunnerConn }));

const SECRET = "branch-actions-test-secret";
const conn = { runnerNode: "Macmini.modem" };

function build() {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, branch) VALUES ('r1', 'i1', 'u1', 'o/r', '/w/r', 'main')");
	const env = { SESSION_SIGNING_KEY: SECRET, DB: d1.DB } as unknown as Env;
	const app = new Hono<{ Bindings: Env }>();
	const routes = new Hono<{ Bindings: Env }>();
	registerBranchActionRoutes(routes);
	app.route("/v1/instances", routes);
	app.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	const call = async (method: string, path: string, body?: unknown, uid = "u1") => {
		const token = await signSession(uid, SECRET, { roles: ["user"] });
		return app.request(`/v1/instances/i1/coding/repos/r1${path}`, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	};
	return { call };
}

const TIP = "a".repeat(40);
beforeEach(() => {
	callRunner.mockReset();
	getRunnerConn.mockReset().mockResolvedValue(conn);
	getBoundRunnerConn.mockReset().mockResolvedValue(conn);
});

describe("reads", () => {
	it("inventory goes to the bound machine by default and says which machine answered", async () => {
		callRunner.mockResolvedValue({ local: [], remoteBranches: [] });
		const res = await build().call("GET", "/branches");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, machine: "Macmini.modem", repo: { id: "r1" } });
		expect(callRunner.mock.calls[0].slice(1, 3)).toEqual(["/coding/branches", { workDir: "/w/r", repoId: "r1" }]);
		expect(getBoundRunnerConn).toHaveBeenCalled();
	});

	it("compare passes its arguments through; a named node picks that machine", async () => {
		callRunner.mockResolvedValue({});
		const { call } = build();
		await call("GET", "/branches?compare=feature&base=main&runner_node=Macmini.modem");
		expect(callRunner.mock.calls[0][2]).toMatchObject({ compare: "feature", base: "main" });
		expect(getRunnerConn.mock.calls[0][3]).toBe("Macmini.modem");
		await call("GET", `/stashes?sha=${TIP}`);
		expect(callRunner.mock.calls[1][2]).toMatchObject({ workDir: "/w/r", repoId: "r1", sha: TIP });
	});

	it("an offline machine is a 503 that says nothing was read, never an empty list", async () => {
		getBoundRunnerConn.mockResolvedValue(null);
		const res = await build().call("GET", "/stashes");
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ ok: false, reason: "unreachable", outcome: "not-started" });
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("a machine other than the one named is not silently used", async () => {
		getRunnerConn.mockResolvedValue({ runnerNode: "other" });
		const res = await build().call("GET", "/branches?runner_node=Macmini.modem");
		expect(res.status).toBe(503);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("an older runner (404) names the CLI to update to", async () => {
		callRunner.mockRejectedValue(new Error("runner /coding/branches → 404 not found"));
		const res = await build().call("GET", "/branches");
		expect(res.status).toBe(422);
		expect(((await res.json()) as { error: string }).error).toMatch(/CLI 0\.4\.\d+ or newer/);
	});
});

describe("mutations", () => {
	it("require the machine to be named, and the repo to be this user's", async () => {
		const { call } = build();
		expect((await call("POST", "/branches/delete", { branch: "x", scope: "local" })).status).toBe(400);
		expect((await call("POST", "/branches/delete", { branch: "x", scope: "local", runner_node: "Macmini.modem" }, "u2")).status).toBe(404);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("preview by default; executing needs the tip (or sha) the caller read; delete needs a scope", async () => {
		callRunner.mockResolvedValue({ ok: true, dryRun: true });
		const { call } = build();
		expect((await call("POST", "/branches/integrate", { branch: "f", runner_node: "Macmini.modem" })).status).toBe(200);
		expect(callRunner.mock.calls[0][2]).toMatchObject({ dryRun: true, branch: "f" });
		expect((await call("POST", "/branches/integrate", { branch: "f", runner_node: "Macmini.modem", dry_run: false })).status).toBe(400);
		expect((await call("POST", "/branches/delete", { branch: "f", runner_node: "Macmini.modem" })).status).toBe(400);
		expect((await call("POST", "/stashes/drop", { runner_node: "Macmini.modem", dry_run: false })).status).toBe(400);
		callRunner.mockResolvedValue({ ok: true, dryRun: false });
		expect((await call("POST", "/branches/integrate", { branch: "f", expected_tip: TIP, runner_node: "Macmini.modem", dry_run: false })).status).toBe(200);
		expect(callRunner.mock.calls.at(-1)?.[2]).toMatchObject({ dryRun: false, expectedTip: TIP });
		expect((await call("POST", "/stashes/drop", { sha: TIP, runner_node: "Macmini.modem", dry_run: false })).status).toBe(200);
		expect(callRunner.mock.calls.at(-1)?.[2]).toMatchObject({ dryRun: false, sha: TIP });
	});

	it("a refusal the runner reports as a value is a 409 carrying the whole answer", async () => {
		callRunner.mockResolvedValue({ ok: false, reason: "stale_tip", error: "moved" });
		const res = await build().call("POST", "/branches/delete", { branch: "f", scope: "remote", runner_node: "Macmini.modem", expected_tip: TIP, dry_run: false });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ ok: true, result: { reason: "stale_tip" } });
	});

	it("a machine lost mid-call is 502 with outcome unknown and a readback instruction", async () => {
		callRunner.mockRejectedValue(new RunnerUnreachableError("the relay has no live socket"));
		const res = await build().call("POST", "/stashes/drop", { sha: TIP, runner_node: "Macmini.modem", dry_run: false });
		expect(res.status).toBe(502);
		expect(await res.json()).toMatchObject({ ok: false, reason: "unconfirmed", outcome: "unknown" });
	});
});

describe("runner route classification", () => {
	it("reads are repeatable, mutations are never re-sent", () => {
		for (const p of ["/coding/branches", "/coding/stashes"]) expect(RUNNER_ROUTES[p].retry).toBe("safe");
		for (const p of ["/coding/branch-integrate", "/coding/branch-delete", "/coding/stash-drop"]) expect(RUNNER_ROUTES[p].retry).toBe("never");
	});
});
