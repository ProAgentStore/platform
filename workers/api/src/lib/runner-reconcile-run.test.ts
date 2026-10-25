/**
 * #1211 — the sweep: gather the pinned repos from the real schema, read GitHub, plan, execute — off by default, idempotent.
 * D1 is the real schema; GitHub is simulated and holds each repo's variable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { reconcileMode, type SweepDeps, sweepRunnerRoutes } from "./runner-reconcile-run.js";
import type { Env } from "../types.js";

const NODE = "mac-mini";
const LABELS = JSON.stringify(["self-hosted", "pags-mac-mini"]);
const NOW = Date.parse("2026-10-26T12:00:00Z");
const ts = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1", "inst-2"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

const pin = (instanceId: string, node: string) => d1.exec(`UPDATE agent_instances SET config = '{"runnerNode":"${node}"}' WHERE id = '${instanceId}'`);
const repo = (id: string, instanceId: string, githubRepo: string) =>
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, provider) VALUES ('${id}', '${instanceId}', 'u1', '${githubRepo.split("/")[1]}', '${githubRepo}', 'github')`);
const machine = (instanceId: string, node: string, seen: number) =>
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, last_seen_at) VALUES ('${instanceId}', 'u1', '${node}', 'http://x', '${ts(seen)}')`);

interface Gh extends SweepDeps {
	variables: Map<string, string>;
	visibility: Map<string, string>;
	used: number;
	queued: Array<{ id: number; labels: string[] }>;
	calls: string[];
}

function gh(over: { used?: number; visibility?: Record<string, string> } = {}): Gh {
	const g: Gh = {
		variables: new Map(),
		visibility: new Map(Object.entries(over.visibility ?? {})),
		used: over.used ?? 100,
		queued: [],
		calls: [],
		now: () => NOW,
		sleep: async () => {},
		forUser: () => ({
			installationToken: async () => "ghs",
			fetch: async (url, init) => {
				const method = init?.method ?? "GET";
				if (method !== "GET") g.calls.push(`${method} ${url.replace("https://api.github.com/", "")}`);
				if (/\/orgs\/[^/]+$/.test(url)) return Response.json({ plan: { name: "free" } });
				if (url.includes("billing/usage")) return Response.json({ usageItems: [{ product: "Actions", unitType: "Minutes", sku: "Actions Linux", quantity: g.used }] });
				const variable = /repos\/([^/]+\/[^/]+)\/actions\/variables(?:\/PAGS_RUNNER)?$/.exec(url);
				if (variable) {
					const name = variable[1];
					if (method === "GET") return g.variables.has(name) ? Response.json({ value: g.variables.get(name) }) : new Response("{}", { status: 404 });
					if (method === "DELETE") {
						g.variables.delete(name);
						return new Response(null, { status: 204 });
					}
					g.variables.set(name, (JSON.parse(String(init?.body)) as { value: string }).value);
					return new Response(null, { status: 204 });
				}
				if (url.includes("/actions/runs?status=queued")) return Response.json({ workflow_runs: g.queued.map((q) => ({ id: q.id })) });
				const jobs = /actions\/runs\/(\d+)\/jobs/.exec(url);
				if (jobs) return Response.json({ jobs: [{ labels: g.queued.find((q) => q.id === Number(jobs[1]))?.labels ?? [] }] });
				if (/actions\/runs\/\d+$/.test(url)) return Response.json({ status: "completed" });
				if (/actions\/runs\/\d+\/(cancel|rerun)$/.test(url)) return new Response(null, { status: 202 });
				const repoInfo = /api\.github\.com\/repos\/([^/]+\/[^/]+)$/.exec(url);
				if (repoInfo) return Response.json({ visibility: g.visibility.get(repoInfo[1]) ?? "private" });
				return new Response("{}", { status: 404 });
			},
		}),
	};
	return g;
}

describe("the mode switch", () => {
	it("is off unless RUNNER_RECONCILE says plan or apply", () => {
		expect(reconcileMode({})).toBe("off");
		expect(reconcileMode({ RUNNER_RECONCILE: "yes" })).toBe("off");
		expect(reconcileMode({ RUNNER_RECONCILE: " Plan " })).toBe("plan");
		expect(reconcileMode({ RUNNER_RECONCILE: "APPLY" })).toBe("apply");
	});

	it("off does nothing at all — not even a read", async () => {
		pin("inst-1", NODE);
		repo("r1", "inst-1", "proappstore-online/interns");
		const g = gh({ used: 2900 });
		const r = await sweepRunnerRoutes(env, g, "off");
		expect(r).toMatchObject({ mode: "off", repos: 0, plan: null });
		expect(g.variables.size).toBe(0);
	});
});

describe("the sweep, over the real schema", () => {
	beforeEach(() => {
		pin("inst-1", NODE);
		repo("r1", "inst-1", "proappstore-online/interns");
		machine("inst-1", NODE, NOW - 30_000);
	});

	it("plan mode computes the plan and CHANGES NOTHING", async () => {
		const g = gh({ used: 2900 });
		const r = await sweepRunnerRoutes(env, g, "plan");
		expect(r.plan?.ops.map((o) => o.op)).toEqual(["set_variable"]);
		expect(r.outcomes).toEqual([]);
		expect(g.variables.size).toBe(0);
		expect(g.calls).toEqual([]);
	});

	it("apply mode: a pinned private repo in an org with low minutes gets exactly the pinned machine's label set", async () => {
		const g = gh({ used: 2900 });
		const r = await sweepRunnerRoutes(env, g, "apply");
		expect(r.outcomes).toEqual([expect.objectContaining({ status: "done" })]);
		expect(g.variables.get("proappstore-online/interns")).toBe(LABELS);
	});

	it("is idempotent: a second sweep over the settled state plans and does nothing", async () => {
		const g = gh({ used: 2900 });
		await sweepRunnerRoutes(env, g, "apply");
		g.calls.length = 0;
		const again = await sweepRunnerRoutes(env, g, "apply");
		expect(again.plan?.ops).toEqual([]);
		expect(g.calls).toEqual([]);
	});

	it("enough minutes: the repo stays on GitHub-hosted and nothing is written", async () => {
		const g = gh({ used: 100 });
		const r = await sweepRunnerRoutes(env, g, "apply");
		expect(r.plan?.ops).toEqual([]);
		expect(g.variables.size).toBe(0);
	});

	it("the billing cycle resets: the self-hosted route is removed", async () => {
		const g = gh({ used: 2900 });
		await sweepRunnerRoutes(env, g, "apply");
		g.used = 20;
		await sweepRunnerRoutes(env, g, "apply");
		expect(g.variables.has("proappstore-online/interns")).toBe(false);
	});

	it("UNPIN: the repo leaves the pinned set, but its org's other known repos are still swept, so its stale route is removed", async () => {
		const g = gh({ used: 2900 });
		await sweepRunnerRoutes(env, g, "apply");
		expect(g.variables.has("proappstore-online/interns")).toBe(true);
		repo("r2", "inst-2", "proappstore-online/other"); // keeps the org in view once inst-1 is unpinned
		d1.exec(`UPDATE agent_instances SET config = '{}' WHERE id = 'inst-1'`);
		pin("inst-2", NODE);
		const r = await sweepRunnerRoutes(env, g, "apply");
		expect(r.repos).toBeGreaterThanOrEqual(2);
		expect(g.variables.has("proappstore-online/interns")).toBe(false);
	});

	it("a PUBLIC repo is never routed to a machine", async () => {
		const g = gh({ used: 2900, visibility: { "proappstore-online/interns": "public" } });
		await sweepRunnerRoutes(env, g, "apply");
		expect(g.variables.size).toBe(0);
	});

	it("a repo pinned to two machines is a conflict: unrouted, and reported", async () => {
		repo("r2", "inst-2", "proappstore-online/interns");
		pin("inst-2", "dell");
		const g = gh({ used: 2900 });
		const r = await sweepRunnerRoutes(env, g, "apply");
		expect(r.conflicts).toEqual([{ repo: "proappstore-online/interns", nodes: expect.arrayContaining([NODE, "dell"]) }]);
		expect(g.variables.size).toBe(0);
	});

	it("an offline pinned machine with minutes left stays GitHub-hosted", async () => {
		d1.exec("DELETE FROM instance_runtime_nodes");
		machine("inst-1", NODE, NOW - 60 * 60_000);
		const g = gh({ used: 2900 });
		const r = await sweepRunnerRoutes(env, g, "apply");
		expect(g.variables.size).toBe(0);
		expect(r.plan?.ops.map((o) => o.op)).toEqual(["alert"]);
	});

	it("a run queued on the old machine's label is cancelled and re-run once the route is set", async () => {
		const g = gh({ used: 2900 });
		g.queued = [{ id: 55, labels: ["self-hosted", "pags-dell"] }];
		await sweepRunnerRoutes(env, g, "apply");
		expect(g.calls).toContain("POST repos/proappstore-online/interns/actions/runs/55/cancel");
		expect(g.calls).toContain("POST repos/proappstore-online/interns/actions/runs/55/rerun");
		expect(g.calls.findIndex((c) => c.includes("/actions/variables"))).toBeLessThan(g.calls.findIndex((c) => c.endsWith("/cancel")));
	});
});
