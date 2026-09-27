/**
 * The Local Coder (#868) as a subscriber meets it, against the REAL migrated schema — the seeded
 * `local-coder` row from 0164, not a fixture standing in for it.
 *
 *   · the runner setup checklist: each step's verdict follows the state the platform records, and
 *     reads only the caller's own machines, installations and repositories;
 *   · the billing gate: with the paywall enforced, a coding run on a non-Pro account is refused with
 *     402 before a budget pool is opened, and a Pro account passes the gate;
 *   · tenancy: a second account cannot see the owner's machines, start work on the owner's
 *     instance, or reach the owner's runner through the relay.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "../lib/d1-sqlite.js";
import { RUNNER_SETUP_STEPS, runnerSetupChecklist } from "../lib/runner-setup.js";
import type { Env, SessionPayload } from "../types.js";

let current: SessionPayload = { uid: "u1", roles: [] } as unknown as SessionPayload;
vi.mock("../lib/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth.js")>("../lib/auth.js");
	return { ...actual, requireUser: async () => current };
});

const { registerRunnerSetupRoutes } = await import("./instances-runner-setup.js");
const { toolRoutes } = await import("./tools.js");
const { terminalRoutes } = await import("./terminals.js");
const { relayRoutes } = await import("./relay.js");
const { codingRoutes } = await import("./coding.js");
const { mirrorRuntimeTask } = await import("./instances-runtime.js");

let d1: RealSchemaD1;
let env: Env;
/** Every relay DO name anything reached, so "never reached the owner's runner" is observable. */
let relayReached: string[];

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const as = (uid: string) => {
	current = { uid, roles: [] } as unknown as SessionPayload;
};
const one = <T>(sql: string): T => d1.sqlite.prepare(sql).get() as T;
/** D1's own `datetime('now')` shape, `ms` in the past. */
const d1Time = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace("T", " ").slice(0, 19);

function app() {
	const router = new Hono<{ Bindings: Env }>();
	const instances = new Hono<{ Bindings: Env }>();
	registerRunnerSetupRoutes(instances);
	router.route("/v1/instances", instances);
	router.route("/v1/instances", toolRoutes);
	router.route("/v1/instances", codingRoutes);
	router.route("/v1/terminals", terminalRoutes);
	router.route("/v1/relay", relayRoutes);
	router.onError((e, c) => (e instanceof HttpError ? c.json({ error: e.message }, e.status as 404) : c.json({ error: String(e) }, 500)));
	return router;
}

const get = (path: string) => app().request(path, {}, env);
const post = (path: string, body: unknown = {}) =>
	app().request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);

function localCoder(id: string, user: string) {
	d1.exec(`INSERT INTO agent_instances (id, agent_id, user_id) VALUES (${q(id)}, 'agent_local_coder', ${q(user)})`);
}

function node(instanceId: string, user: string, name: string, lastSeen: string | null) {
	d1.exec(
		`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, last_seen_at)
		  VALUES (${q(instanceId)}, ${q(user)}, ${q(name)}, 'relay://x', ${lastSeen ? q(lastSeen) : "NULL"})`,
	);
}

function repo(id: string, instanceId: string, user: string, opts: { github?: string; cloneStatus?: string; cloneError?: string } = {}) {
	d1.exec(
		`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, provider, clone_status, clone_error, workdir)
		  VALUES (${q(id)}, ${q(instanceId)}, ${q(user)}, 'app', ${opts.github ? q(opts.github) : "NULL"}, ${q(opts.github ? "github" : "local")},
		          ${q(opts.cloneStatus ?? "ready")}, ${opts.cloneError ? q(opts.cloneError) : "NULL"}, '/home/me/app')`,
	);
}

function install(user: string, account: string, installationId = 1) {
	d1.exec(`INSERT INTO github_installations (id, user_id, installation_id, account_login) VALUES (${q(`gi-${user}-${installationId}`)}, ${q(user)}, ${installationId}, ${q(account)})`);
}

function session(id: string, instanceId: string, repoId: string, user: string) {
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, repo_id, user_id) VALUES (${q(id)}, ${q(instanceId)}, ${q(repoId)}, ${q(user)})`);
}

/** Written by the same writer the sign-in relay uses, so the checklist reads the real row shape. */
async function signinCard(instanceId: string, user: string) {
	const now = new Date().toISOString();
	await mirrorRuntimeTask(env, instanceId, user, { id: "signin-s1", type: "engine.signin", status: "needs_human", title: "Sign in to the coding engine", createdAt: now, updatedAt: now });
}

const pro = (user: string) => d1.exec(`UPDATE users SET subscription_status = 'active' WHERE id = ${q(user)}`);
const verdicts = (steps: { step: string; done: boolean }[]) => Object.fromEntries(steps.map((s) => [s.step, s.done]));

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: [] });
	d1.exec("INSERT OR IGNORE INTO users (id, github_login) VALUES ('u2', 'u2')");
	relayReached = [];
	const RELAY = {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => ({
			async fetch() {
				relayReached.push(id.name);
				return Response.json({ connected: true });
			},
		}),
	};
	env = { DB: d1.DB, SESSION_SIGNING_KEY: "k", RELAY } as unknown as Env;
	as("u1");
	localCoder("lc-1", "u1");
});

afterEach(() => d1.close());

describe("GET /v1/instances/:id/runner-setup — the checklist (#868)", () => {
	it("a fresh subscriber: five steps in order, none done, not ready", async () => {
		const res = await get("/v1/instances/lc-1/runner-setup");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { instanceId: string; ready: boolean; steps: { step: string; done: boolean; instruction: string }[] };
		expect(body.instanceId).toBe("lc-1");
		expect(body.ready).toBe(false);
		expect(body.steps.map((s) => s.step)).toEqual([...RUNNER_SETUP_STEPS]);
		expect(body.steps.every((s) => !s.done && s.instruction.length > 0)).toBe(true);
		// The first thing a subscriber who has never used the CLI must be told.
		expect(body.steps[0].instruction).toMatch(/npm i -g @proagentstore\/cli/);
		expect(body.steps[0].instruction.indexOf("pags login")).toBeLessThan(body.steps[0].instruction.indexOf("pags up"));
	});

	it("every step done: ready", async () => {
		node("lc-1", "u1", "my-mac", d1Time());
		install("u1", "Acme");
		repo("r1", "lc-1", "u1", { github: "acme/app" });
		session("s1", "lc-1", "r1", "u1");
		const body = await runnerSetupChecklist(env, "lc-1", "u1");
		expect(verdicts(body.steps)).toEqual({ runner_connected: true, instance_attached: true, github_app: true, repo_bound: true, engine_signed_in: true });
		expect(body.ready).toBe(true);
	});

	it("a runner up for another agent but not this one: connected, not attached", async () => {
		localCoder("lc-other", "u1");
		node("lc-other", "u1", "my-mac", d1Time());
		const v = verdicts((await runnerSetupChecklist(env, "lc-1", "u1")).steps);
		expect(v.runner_connected).toBe(true);
		expect(v.instance_attached).toBe(false);
	});

	it("a stale heartbeat is not a connected runner", async () => {
		node("lc-1", "u1", "my-mac", d1Time(10 * 60_000));
		const v = verdicts((await runnerSetupChecklist(env, "lc-1", "u1")).steps);
		expect(v.runner_connected).toBe(false);
		expect(v.instance_attached).toBe(false);
	});

	it("the App installed on a different account does not cover the bound repository's owner", async () => {
		install("u1", "someone-else");
		repo("r1", "lc-1", "u1", { github: "acme/app" });
		const step = (await runnerSetupChecklist(env, "lc-1", "u1")).steps.find((s) => s.step === "github_app");
		expect(step?.done).toBe(false);
		expect(step?.instruction).toMatch(/acme/);
	});

	it("a bound checkout the machine refused is not a bound repository, and says why", async () => {
		repo("r1", "lc-1", "u1", { cloneStatus: "needs_attention", cloneError: "The configured checkout `/home/me/app` is not a git working tree." });
		const step = (await runnerSetupChecklist(env, "lc-1", "u1")).steps.find((s) => s.step === "repo_bound");
		expect(step?.done).toBe(false);
		expect(step?.instruction).toMatch(/not a git working tree/);
	});

	it("an engine waiting for its sign-in is not signed in", async () => {
		repo("r1", "lc-1", "u1");
		session("s1", "lc-1", "r1", "u1");
		await signinCard("lc-1", "u1");
		const step = (await runnerSetupChecklist(env, "lc-1", "u1")).steps.find((s) => s.step === "engine_signed_in");
		expect(step?.done).toBe(false);
		expect(step?.instruction).toMatch(/waiting for you to sign in/);
	});

	it("refuses an agent that has no local coding runner", async () => {
		d1.exec("INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('chat-1', 'agent-1', 'u1')");
		const res = await get("/v1/instances/chat-1/runner-setup");
		expect(res.status).toBe(409);
	});
});

describe("POST /v1/instances/:id/loop — a coding run is a Pro feature (#868)", () => {
	const budgets = () => one<{ n: number }>("SELECT COUNT(*) AS n FROM delegation_budgets").n;

	it("with the paywall enforced, a non-Pro subscriber gets 402 and no budget pool is opened", async () => {
		env.PAYWALL_ENFORCE = "true";
		const res = await post("/v1/instances/lc-1/loop", { objective: "fix the build" });
		expect(res.status).toBe(402);
		expect(budgets()).toBe(0);
		expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM agent_loop_runs").n).toBe(0);
	});

	it("with the paywall enforced, a Pro subscriber passes the gate", async () => {
		env.PAYWALL_ENFORCE = "true";
		pro("u1");
		const res = await post("/v1/instances/lc-1/loop", { objective: "fix the build" });
		// Past the gate: refused only by the driver, because this agent has no repository yet.
		expect(res.status).not.toBe(402);
		expect(res.status).toBe(409);
		expect(budgets()).toBe(1);
	});

	it("with the paywall off (soft launch), a non-Pro subscriber is not refused on billing", async () => {
		const res = await post("/v1/instances/lc-1/loop", { objective: "fix the build" });
		expect(res.status).not.toBe(402);
	});
});

describe("tenancy — a second account and the owner's Local Coder (#868)", () => {
	beforeEach(() => {
		node("lc-1", "u1", "owner-mac", d1Time());
		repo("r1", "lc-1", "u1", { github: "acme/app" });
		install("u1", "acme");
		// The stranger is Pro and has a Local Coder of their own, so nothing below is refused for
		// billing or for having no instance — only for not being the owner.
		pro("u2");
		localCoder("lc-2", "u2");
		env.PAYWALL_ENFORCE = "true";
		pro("u1");
	});

	it("cannot see the owner's machines", async () => {
		as("u1");
		const mine = JSON.stringify(await (await get("/v1/terminals/nodes")).json());
		expect(mine).toContain("owner-mac"); // not vacuous: the owner does see it
		as("u2");
		const res = await get("/v1/terminals/nodes");
		expect(res.status).toBe(200);
		expect(JSON.stringify(await res.json())).not.toContain("owner-mac");
	});

	it("cannot read the owner's checklist, and their own does not see the owner's runner or App", async () => {
		as("u2");
		expect((await get("/v1/instances/lc-1/runner-setup")).status).toBe(404);
		const own = verdicts((await runnerSetupChecklist(env, "lc-2", "u2")).steps);
		expect(own.runner_connected).toBe(false);
		expect(own.github_app).toBe(false);
		// And naming the owner's instance with the stranger's id finds nothing of the owner's.
		const probe = verdicts((await runnerSetupChecklist(env, "lc-1", "u2")).steps);
		expect(probe).toEqual({ runner_connected: false, instance_attached: false, github_app: false, repo_bound: false, engine_signed_in: false });
	});

	it("cannot start a coding run or open a coding session on the owner's instance", async () => {
		as("u2");
		expect((await post("/v1/instances/lc-1/loop", { objective: "exfiltrate" })).status).toBe(404);
		expect((await post("/v1/instances/lc-1/coding/sessions", { repoId: "r1" })).status).toBe(404);
		expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM agent_loop_runs").n).toBe(0);
		expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM coding_sessions").n).toBe(0);
		expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM delegation_budgets").n).toBe(0);
	});

	it("cannot reach the owner's runner through the relay", async () => {
		as("u2");
		expect((await post("/v1/relay/lc-1/token")).status).toBe(404);
		expect((await get("/v1/relay/lc-1/status?node=owner-mac")).status).toBe(404);
		expect(relayReached).toEqual([]);
		// Not vacuous: the owner's own status call does reach it.
		as("u1");
		expect((await get("/v1/relay/lc-1/status?node=owner-mac")).status).toBe(200);
		expect(relayReached.length).toBe(1);
	});
});
