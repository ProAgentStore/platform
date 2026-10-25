import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
import type { Env } from "../types.js";

// #1142: the repo list carries per-machine checkouts, and the mirror route answers per machine.
vi.mock("../lib/runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/runner-client.js")>()),
	getBoundRunnerConn: vi.fn(async () => null),
	getRunnerConn: vi.fn(async (_e: unknown, _i: string, _u: string, n?: string | null) => (n ? { runnerNode: n } : null)),
	callRunner: vi.fn(async () => ({ state: "cloning" })),
}));
vi.mock("../lib/coding-workdir.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/coding-workdir.js")>()),
	checkWorkdirVia: vi.fn(async (_c: unknown, path: string) => ({ state: "missing", path, detail: `${path} is missing` })),
}));

const { registerRepoRoutes } = await import("./coding-repos.js");
const { upsertCheckout } = await import("../lib/coding-repo-checkouts.js");

const SECRET = "checkouts-routes-test-secret";
let d1: RealSchemaD1;
let env: Env;
let app: Hono<{ Bindings: Env }>;

const call = async (method: string, path: string, user = "u1") => {
	const token = await signSession(user, SECRET, { roles: [] });
	return app.request(`/v1/instances/${path}`, { method, headers: { Authorization: `Bearer ${token}` } }, env);
};

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, provider) VALUES ('r1', 'i1', 'u1', 'app', 'acme/app', 'github')`);
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id) VALUES ('i1', 'u1', 'studio', 'https://s', 'm-stu')`);
	env = { SESSION_SIGNING_KEY: SECRET, DB: d1.DB } as unknown as Env;
	app = new Hono<{ Bindings: Env }>();
	app.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 404) : c.json({ error: String(e) }, 500)));
	const routes = new Hono<{ Bindings: Env }>();
	registerRepoRoutes(routes);
	app.route("/v1/instances", routes);
});

describe("per-machine checkouts on the coding repo routes (#1142)", () => {
	it("GET /coding/repos lists each repo's checkouts beside the binding's own state", async () => {
		await upsertCheckout(env, "i1", "u1", "r1", "m-stu", { cloneStatus: "ready", workdir: "~/code/app", verified: true });
		await upsertCheckout(env, "i1", "u1", "r1", "m-lap", { cloneStatus: "cloning" });
		const res = await call("GET", "i1/coding/repos");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { repos: Array<{ id: string; checkouts: Array<Record<string, unknown>> }> };
		expect(body.repos[0].checkouts.map((c) => [c.machineId, c.cloneStatus, c.workdir])).toEqual([
			["m-lap", "cloning", null],
			["m-stu", "ready", "~/code/app"],
		]);
		expect(body.repos[0].checkouts[1]).toHaveProperty("lastVerifiedAt");
	});

	it("a repo with no checkout rows lists an empty array, not a missing field", async () => {
		const body = (await (await call("GET", "i1/coding/repos")).json()) as { repos: Array<{ checkouts: unknown[] }> };
		expect(body.repos[0].checkouts).toEqual([]);
	});

	it("POST /coding/repos/:id/mirror answers per machine; unknown repo and stranger are 404", async () => {
		d1.exec(`UPDATE coding_repos SET workdir = '~/dev/app' WHERE id = 'r1'`);
		const ok = await call("POST", "i1/coding/repos/r1/mirror");
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ repoId: "r1", machines: [{ machineId: "m-stu", runnerNode: "studio", status: "cloning" }] });
		expect((await call("POST", "i1/coding/repos/nope/mirror")).status).toBe(404);
		expect((await call("POST", "i1/coding/repos/r1/mirror", "u2")).status).toBe(404);
	});
});
