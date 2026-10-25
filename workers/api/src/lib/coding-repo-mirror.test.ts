import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkdirVerdict } from "./coding-workdir.js";
import type { Env } from "../types.js";

vi.mock("./runner-client.js", () => ({
	READ_TIMEOUT_MS: 15_000,
	callRunner: vi.fn(),
	getRunnerConn: vi.fn(),
}));
vi.mock("./coding-workdir.js", () => ({ checkWorkdirVia: vi.fn() }));

const runner = await import("./runner-client.js");
const workdir = await import("./coding-workdir.js");
const { MIRROR_CONCURRENCY, ensureCheckoutsOnRepin, mirrorRepoToAllMachines } = await import("./coding-repo-mirror.js");
const { getCheckout, upsertCheckout } = await import("./coding-repo-checkouts.js");
const { realSchemaD1, seedTenant } = await import("./d1-sqlite.js");

let d1: ReturnType<typeof realSchemaD1>;
let env: Env;
const verdicts = new Map<string, WorkdirVerdict["state"]>();
const clones: Array<{ node: string; body: unknown }> = [];
let inFlight = 0;
let peak = 0;

const node = (name: string, machine: string | null) =>
	d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id) VALUES ('i1', 'u1', '${name}', 'https://${name}', ${machine ? `'${machine}'` : "NULL"})`);

beforeEach(() => {
	vi.clearAllMocks();
	verdicts.clear();
	clones.length = 0;
	inFlight = 0;
	peak = 0;
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, workdir, provider) VALUES ('r1', 'i1', 'u1', 'app', 'acme/app', '~/dev/app', 'github')`);
	env = { DB: d1.DB } as unknown as Env;
	// A connection is just its node name; offline nodes resolve to null.
	vi.mocked(runner.getRunnerConn).mockImplementation((async (_e: unknown, _i: string, _u: string, n?: string | null) => (n && !n.startsWith("off-") ? { runnerNode: n } : null)) as never);
	vi.mocked(workdir.checkWorkdirVia).mockImplementation((async (conn: { runnerNode: string }, path: string) => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise((r) => setTimeout(r, 5));
		inFlight--;
		const state = verdicts.get(conn.runnerNode) ?? "missing";
		return { state, path, detail: state === "ok" ? "" : `${path} is ${state}` };
	}) as never);
	vi.mocked(runner.callRunner).mockImplementation((async (conn: { runnerNode: string }, path: string, body: unknown) => {
		if (path === "/coding/clone-start") clones.push({ node: conn.runnerNode, body });
		return { state: "cloning" };
	}) as never);
});

describe("mirrorRepoToAllMachines (#1142)", () => {
	it("starts a background clone on each connected machine that lacks the repo, and leaves a good checkout alone", async () => {
		node("laptop", "m-lap");
		node("studio", "m-stu");
		node("off-box", "m-off");
		verdicts.set("laptop", "ok");
		const result = await mirrorRepoToAllMachines(env, "i1", "u1", "r1");
		expect(result).toEqual([
			{ machineId: "m-lap", runnerNode: "laptop", status: "ready" },
			{ machineId: "m-stu", runnerNode: "studio", status: "cloning" },
		]);
		// One clone, on the machine without the repo, into the binding's home-relative folder, by the same job `coding_repo_add` uses.
		expect(clones).toEqual([{ node: "studio", body: { workDir: "~/dev/app", slug: "acme/app", protocol: "auto" } }]);
		expect(await getCheckout(env, "i1", "u1", "r1", "m-lap")).toMatchObject({ cloneStatus: "ready" });
		expect((await getCheckout(env, "i1", "u1", "r1", "m-lap"))?.lastVerifiedAt).not.toBeNull();
		expect(await getCheckout(env, "i1", "u1", "r1", "m-stu")).toMatchObject({ cloneStatus: "cloning", lastVerifiedAt: null });
		// The offline machine is not listed and has no row: nothing is claimed about a machine nobody asked.
		expect(await getCheckout(env, "i1", "u1", "r1", "m-off")).toBeNull();
	});

	it("uses the checkout's own path on a machine that has one", async () => {
		node("studio", "m-stu");
		await upsertCheckout(env, "i1", "u1", "r1", "m-stu", { cloneStatus: "error", workdir: "~/code/app" });
		await mirrorRepoToAllMachines(env, "i1", "u1", "r1");
		expect(clones).toEqual([{ node: "studio", body: { workDir: "~/code/app", slug: "acme/app", protocol: "auto" } }]);
	});

	it("records a refused clone as an error with the reason, and never clones over a folder with content", async () => {
		node("laptop", "m-lap");
		node("studio", "m-stu");
		verdicts.set("laptop", "not_a_git_repo");
		vi.mocked(runner.callRunner).mockRejectedValueOnce(new Error("HTTP 500 boom"));
		const result = await mirrorRepoToAllMachines(env, "i1", "u1", "r1");
		const byMachine = Object.fromEntries((result ?? []).map((r) => [r.machineId, r]));
		expect(byMachine["m-lap"]).toMatchObject({ status: "error", detail: "~/dev/app is not_a_git_repo" });
		expect(byMachine["m-stu"]).toMatchObject({ status: "error" });
		expect(clones.map((c) => c.node)).toEqual([]);
		expect(await getCheckout(env, "i1", "u1", "r1", "m-lap")).toMatchObject({ cloneStatus: "needs_attention" });
		expect(await getCheckout(env, "i1", "u1", "r1", "m-stu")).toMatchObject({ cloneStatus: "error", cloneError: expect.stringContaining("boom") });
	});

	it("skips a binding with no folder, and answers null for a repo that is not the caller's", async () => {
		node("laptop", "m-lap");
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, provider) VALUES ('r2', 'i1', 'u1', 'nofolder', 'acme/nofolder', 'github')`);
		expect(await mirrorRepoToAllMachines(env, "i1", "u1", "r2")).toEqual([{ machineId: "m-lap", runnerNode: "laptop", status: "skipped", detail: expect.stringContaining("no folder") }]);
		expect(await mirrorRepoToAllMachines(env, "i1", "u2", "r1")).toBeNull();
		expect(await mirrorRepoToAllMachines(env, "i9", "u1", "r1")).toBeNull();
	});

	it("works at most MIRROR_CONCURRENCY machines at a time", async () => {
		for (let n = 0; n < 12; n++) node(`n${n}`, `m${n}`);
		const result = await mirrorRepoToAllMachines(env, "i1", "u1", "r1");
		expect(result).toHaveLength(12);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(MIRROR_CONCURRENCY);
	});

	it("counts a machine once however many names it registered under", async () => {
		node("laptop", "m-lap");
		node("laptop.local", "m-lap");
		expect(await mirrorRepoToAllMachines(env, "i1", "u1", "r1")).toHaveLength(1);
	});
});

describe("ensureCheckoutsOnRepin (#1142)", () => {
	it("clones what the new machine lacks, and skips checkouts already ready or cloning", async () => {
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, workdir, provider) VALUES ('r2', 'i1', 'u1', 'ready', 'acme/ready', '~/dev/ready', 'github')`);
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, workdir, provider) VALUES ('r3', 'i1', 'u1', 'busy', 'acme/busy', '~/dev/busy', 'github')`);
		await upsertCheckout(env, "i1", "u1", "r2", "m-new", { cloneStatus: "ready", verified: true });
		await upsertCheckout(env, "i1", "u1", "r3", "m-new", { cloneStatus: "cloning" });
		const done = await ensureCheckoutsOnRepin(env, "i1", "u1", "new", "m-new");
		expect(done.map((d) => d.status)).toEqual(["cloning"]);
		expect(clones).toEqual([{ node: "new", body: { workDir: "~/dev/app", slug: "acme/app", protocol: "auto" } }]);
		expect(await getCheckout(env, "i1", "u1", "r1", "m-new")).toMatchObject({ cloneStatus: "cloning" });
	});

	it("does nothing when the machine is not connected, or waits a bounded moment for it", async () => {
		expect(await ensureCheckoutsOnRepin(env, "i1", "u1", "off-new", "m-new")).toEqual([]);
		expect(await ensureCheckoutsOnRepin(env, "i1", "u1", "off-new", "m-new", { waitMs: 20, pollMs: 5 })).toEqual([]);
		expect(clones).toEqual([]);
		// It comes up during the wait.
		let calls = 0;
		vi.mocked(runner.getRunnerConn).mockImplementation((async () => (++calls > 2 ? { runnerNode: "new" } : null)) as never);
		const done = await ensureCheckoutsOnRepin(env, "i1", "u1", "new", "m-new", { waitMs: 500, pollMs: 5 });
		expect(done).toHaveLength(1);
	});
});
