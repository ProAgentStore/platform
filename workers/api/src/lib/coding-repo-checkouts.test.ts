import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
	deleteCheckout,
	effectiveWorkdir,
	getCheckout,
	listCheckoutsForInstance,
	listCheckoutsForMachine,
	listCheckoutsForRepo,
	machineIdForNode,
	upsertCheckout,
} from "./coding-repo-checkouts.js";
import { deleteRepo } from "./coding-store.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i3"] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, workdir) VALUES ('r1', 'i1', 'u1', 'app', 'acme/app', '~/dev/app')`);
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r3', 'i3', 'u2', 'other', 'acme/other')`);
	env = { DB: d1.DB } as unknown as Env;
});

describe("per-machine checkouts (#1142)", () => {
	it("holds one binding with a checkout per machine, and updates in place on conflict", async () => {
		expect(await upsertCheckout(env, "i1", "u1", "r1", "m-a", { cloneStatus: "ready", verified: true })).toBe(true);
		expect(await upsertCheckout(env, "i1", "u1", "r1", "m-b", { cloneStatus: "cloning", workdir: "~/code/app" })).toBe(true);
		const rows = await listCheckoutsForRepo(env, "i1", "u1", "r1");
		expect(rows.map((r) => [r.machineId, r.cloneStatus, r.workdir])).toEqual([
			["m-a", "ready", null],
			["m-b", "cloning", "~/code/app"],
		]);
		expect(rows[0].lastVerifiedAt).not.toBeNull();
		expect(rows[1].lastVerifiedAt).toBeNull();

		// Same (repo, machine) again: one row, new status, the path kept when the patch does not name one,
		// and the verification stamp kept when this write is not a verdict.
		await upsertCheckout(env, "i1", "u1", "r1", "m-b", { cloneStatus: "error", cloneError: "auth refused" });
		const again = await getCheckout(env, "i1", "u1", "r1", "m-b");
		expect(again).toMatchObject({ cloneStatus: "error", cloneError: "auth refused", workdir: "~/code/app", lastVerifiedAt: null });
		expect(await listCheckoutsForRepo(env, "i1", "u1", "r1")).toHaveLength(2);
		// A definite verdict clears the error and stamps the check.
		await upsertCheckout(env, "i1", "u1", "r1", "m-b", { cloneStatus: "ready", verified: true });
		expect(await getCheckout(env, "i1", "u1", "r1", "m-b")).toMatchObject({ cloneStatus: "ready", cloneError: null });
		// null falls back to the binding's own path.
		await upsertCheckout(env, "i1", "u1", "r1", "m-b", { cloneStatus: "ready", workdir: null });
		expect((await getCheckout(env, "i1", "u1", "r1", "m-b"))?.workdir).toBeNull();
	});

	it("is owner-scoped: another user's or instance's binding is neither written nor read", async () => {
		expect(await upsertCheckout(env, "i3", "u1", "r3", "m-a", { cloneStatus: "ready" })).toBe(false);
		expect(await upsertCheckout(env, "i2", "u1", "r1", "m-a", { cloneStatus: "ready" })).toBe(false);
		expect(await upsertCheckout(env, "i1", "u1", "r1", "", { cloneStatus: "ready" })).toBe(false);
		await upsertCheckout(env, "i1", "u1", "r1", "m-a", { cloneStatus: "ready" });
		expect(await getCheckout(env, "i1", "u2", "r1", "m-a")).toBeNull();
		expect(await listCheckoutsForRepo(env, "i3", "u2", "r1")).toEqual([]);
		expect(await deleteCheckout(env, "i1", "u2", "r1", "m-a")).toBe(false);
		expect(await getCheckout(env, "i1", "u1", "r1", "m-a")).not.toBeNull();
		expect(await deleteCheckout(env, "i1", "u1", "r1", "m-a")).toBe(true);
	});

	it("lists by instance (grouped by repo) and by machine", async () => {
		await upsertCheckout(env, "i1", "u1", "r1", "m-a", { cloneStatus: "ready" });
		await upsertCheckout(env, "i1", "u1", "r1", "m-b", { cloneStatus: "cloning" });
		const byRepo = await listCheckoutsForInstance(env, "i1", "u1");
		expect([...byRepo.keys()]).toEqual(["r1"]);
		expect(byRepo.get("r1")).toHaveLength(2);
		const onB = await listCheckoutsForMachine(env, "u1", "m-b");
		expect(onB).toMatchObject([{ repoId: "r1", instanceId: "i1", githubRepo: "acme/app", cloneStatus: "cloning" }]);
		expect(await listCheckoutsForMachine(env, "u2", "m-b")).toEqual([]);
	});

	it("is removed with its binding", async () => {
		await upsertCheckout(env, "i1", "u1", "r1", "m-a", { cloneStatus: "ready" });
		// (The test double's batch() does not report change counts, so the effect is read back instead.)
		await deleteRepo(env, "i1", "u1", "r1");
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM coding_repos WHERE id = 'r1'").get()).toEqual({ n: 0 });
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM coding_repo_checkouts").get()).toEqual({ n: 0 });
	});

	it("resolves a node name to its machine id from the registry, else from the instance's own pin", async () => {
		d1.exec(`INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id) VALUES ('i1', 'u1', 'laptop', 'https://x', 'm-lap')`);
		expect(await machineIdForNode(env, "i1", "u1", "laptop")).toBe("m-lap");
		expect(await machineIdForNode(env, "i1", "u1", "elsewhere")).toBeNull();
		d1.exec(`UPDATE agent_instances SET config = '{"runnerNode":"studio","runnerMachineId":"m-stu"}' WHERE id = 'i2'`);
		expect(await machineIdForNode(env, "i2", "u1", "studio")).toBe("m-stu");
		expect(await machineIdForNode(env, "i2", "u1", "laptop")).toBeNull();
		expect(await machineIdForNode(env, "i1", "u1", "")).toBeNull();
	});

	it("prefers the checkout's own path over the binding's", () => {
		expect(effectiveWorkdir({ workdir: "~/code/app" }, "~/dev/app")).toBe("~/code/app");
		expect(effectiveWorkdir({ workdir: null }, "~/dev/app")).toBe("~/dev/app");
		expect(effectiveWorkdir(null, undefined)).toBeUndefined();
	});
});

describe("migration 0292 seed", () => {
	const seedSql = (() => {
		const sql = readFileSync(new URL("../../migrations/0292_coding_repo_checkouts.sql", import.meta.url).pathname, "utf8");
		return sql.slice(sql.indexOf("INSERT OR IGNORE INTO coding_repo_checkouts"));
	})();

	it("attributes an existing checkout to the machine its instance is pinned to, and skips what has no machine", () => {
		d1.exec(`UPDATE agent_instances SET config = '{"runnerNode":"laptop","runnerMachineId":"m-lap"}' WHERE id = 'i1'`);
		d1.exec(`UPDATE agent_instances SET config = 'not json' WHERE id = 'i2'`);
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo, clone_status) VALUES ('r2', 'i2', 'u1', 'unpinned', 'acme/unpinned', 'ready')`);
		d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('r4', 'i1', 'u1', 'bare', 'acme/bare')`);
		d1.exec("DELETE FROM coding_repo_checkouts");
		d1.exec(seedSql);
		const rows = d1.sqlite.prepare("SELECT repo_id, machine_id, workdir, clone_status FROM coding_repo_checkouts ORDER BY repo_id").all();
		// r1 has a folder and is pinned; r2's instance has an unreadable config (no machine); r4 has nothing on record; r3's instance has no pin.
		expect(rows).toEqual([{ repo_id: "r1", machine_id: "m-lap", workdir: "~/dev/app", clone_status: expect.any(String) }]);
		// Re-running changes nothing.
		d1.exec(seedSql);
		expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM coding_repo_checkouts").get()).toEqual({ n: 1 });
	});
});
