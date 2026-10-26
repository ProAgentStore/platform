/**
 * #1379 — the trail of how a repo's home-relative folder was expanded on the machine that ran it. Real migrated schema.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RealSchemaD1, realSchemaD1 } from "./d1-sqlite.js";
import { createRepo, getRepo } from "./coding-store.js";
import { recordWorkdirResolution } from "./coding-workdir-resolution.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;
beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'u1')");
	d1.exec("INSERT INTO agents (id, owner_id, slug, name) VALUES ('ag', 'u1', 't1379', 'A')");
	d1.exec("INSERT INTO agent_instances (id, agent_id, user_id, status, config) VALUES ('i1', 'ag', 'u1', 'active', '{}')");
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

describe("a repo stores its folder home-relative and keeps the translation as a trail", () => {
	it("a new repo has no trail until a machine starts a session on it", async () => {
		const repo = await createRepo(env, "i1", "u1", { name: "hiring", workdir: "~/dev/stores/pas/apps/hiring" });
		expect(repo).toMatchObject({ workdir: "~/dev/stores/pas/apps/hiring" });
		expect(repo.workdirResolved).toBeUndefined();
	});

	it("records the absolute path and the rule beside the source-of-truth workdir, which it never changes", async () => {
		const repo = await createRepo(env, "i1", "u1", { name: "hiring", workdir: "~/dev/stores/pas/apps/hiring" });
		await recordWorkdirResolution(env, repo.id, { path: "/Users/sergeivo/dev/stores/pas/apps/hiring", via: "tilde" });
		const after = await getRepo(env, "i1", "u1", repo.id);
		expect(after).toMatchObject({ workdir: "~/dev/stores/pas/apps/hiring", workdirResolved: "/Users/sergeivo/dev/stores/pas/apps/hiring", workdirResolvedVia: "tilde" });
		expect(after?.workdirResolvedAt).toBeTruthy();
	});

	it("a coder moved to another machine shows the new machine's translation", async () => {
		const repo = await createRepo(env, "i1", "u1", { name: "hiring", workdir: "~/dev/stores/pas/apps/hiring" });
		await recordWorkdirResolution(env, repo.id, { path: "/Users/serge/dev/stores/pas/apps/hiring", via: "tilde" });
		await recordWorkdirResolution(env, repo.id, { path: "C:\\Users\\Dell\\dev\\stores\\pas\\apps\\hiring", via: "tilde" });
		expect((await getRepo(env, "i1", "u1", repo.id))?.workdirResolved).toBe("C:\\Users\\Dell\\dev\\stores\\pas\\apps\\hiring");
	});

	it("does not rewrite the row on every start when nothing changed, but refreshes a stale stamp", async () => {
		const repo = await createRepo(env, "i1", "u1", { name: "hiring", workdir: "~/dev/x" });
		await recordWorkdirResolution(env, repo.id, { path: "/Users/a/dev/x", via: "tilde" });
		const stamp = (): string | undefined => d1.sqlite.prepare("SELECT workdir_resolved_at AS at FROM coding_repos WHERE id = ?").get(repo.id) ? (d1.sqlite.prepare("SELECT workdir_resolved_at AS at FROM coding_repos WHERE id = ?").get(repo.id) as { at: string }).at : undefined;
		d1.exec(`UPDATE coding_repos SET workdir_resolved_at = datetime('now', '-5 minutes') WHERE id = '${repo.id}'`);
		const recent = stamp();
		await recordWorkdirResolution(env, repo.id, { path: "/Users/a/dev/x", via: "tilde" });
		expect(stamp()).toBe(recent);
		d1.exec(`UPDATE coding_repos SET workdir_resolved_at = datetime('now', '-2 hours') WHERE id = '${repo.id}'`);
		const old = stamp();
		await recordWorkdirResolution(env, repo.id, { path: "/Users/a/dev/x", via: "tilde" });
		expect(stamp()).not.toBe(old);
	});
});
