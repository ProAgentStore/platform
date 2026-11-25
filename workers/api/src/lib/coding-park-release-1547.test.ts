/**
 * #1547 — a parked run's checkout is released only when the runner could set aside work that is provably the run's.
 *
 * On 2026-11-05 a park captured another active editor's tracked and untracked application fixes out of a shared checkout and
 * the reflog recorded `reset: moving to HEAD` three seconds later. The runner now leaves a dirty checkout of unknown ownership
 * exactly as it is and says so (`conflict: "ownership_unknown"`, the dirty paths as `unowned`); this is the cloud's half: it
 * must keep the checkout HELD, change nothing about the run or its session, and tell the owner which paths are in the way.
 * Over the real schema; only the runner's answer is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "./d1-sqlite.js";
import type { RunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";

const runnerAnswer = vi.hoisted(() => ({ value: null as unknown, calls: [] as Array<{ path: string; body: unknown }> }));
vi.mock("./runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./runner-client.js")>()),
	callRunner: async (_conn: unknown, path: string, body: unknown) => {
		runnerAnswer.calls.push({ path, body });
		if (runnerAnswer.value instanceof Error) throw runnerAnswer.value;
		return runnerAnswer.value;
	},
}));
const { releaseCheckout } = await import("./coding-park.js");

const INSTANCE = "a185b1db-c560-456d-9522-f7792bd95cca";
const RUN = "a8dc0cf8-f5b8-40da-9396-d6c09a888f6a";
const SCOPE = { instanceId: INSTANCE, userId: "u1", repoId: "r1", runId: RUN, sessionId: "csess_1" };
const conn = { runnerNode: "pink-laptop" } as unknown as RunnerConn;
let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	env = { DB: d1.DB } as unknown as Env;
	seedTenant(d1, { userId: "u1", instanceIds: [INSTANCE] });
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, clone_status) VALUES ('r1', '${INSTANCE}', 'u1', 'ProAgentStore/platform', '/w/platform', 'ready')`);
	d1.exec(`INSERT INTO coding_sessions (id, instance_id, user_id, repo_id, client_type, status) VALUES ('csess_1', '${INSTANCE}', 'u1', 'r1', 'codex', 'active')`);
	runnerAnswer.calls = [];
	runnerAnswer.value = null;
});
afterEach(() => d1.close());

const sessionStatus = () => d1.DB.prepare("SELECT status FROM coding_sessions WHERE id = 'csess_1'").first<{ status: string }>().then((r) => r?.status);

describe("releaseCheckout when the runner could not show the dirty paths are the run's (#1547)", () => {
	it("keeps the checkout HELD, leaves the session active, and names the paths that are in the way", async () => {
		runnerAnswer.value = { snapshot: null, files: 0, clean: false, ref: null, pushed: null, unowned: ["src/application.ts", "src/new-fix.ts"], conflict: "ownership_unknown" };
		const r = await releaseCheckout(env, conn, SCOPE);
		expect(r.released).toBe(false);
		expect(r.line).toMatch(/stays held/);
		expect(r.line).toContain("`src/application.ts`");
		expect(r.line).toContain("`src/new-fix.ts`");
		expect(r.line).toMatch(/2 uncommitted paths/);
		expect(r.line).toMatch(/NOTHING was set aside, stashed or cleaned/);
		expect(r.line).toMatch(/exactly as they were/);
		// Nothing about the run or its session moved: it is still the owner, its session still active.
		expect(await sessionStatus()).toBe("active");
		expect(r.onStop).toBeUndefined();
	});

	it("says 'path' for one, and abbreviates a long list instead of printing hundreds", async () => {
		runnerAnswer.value = { snapshot: null, files: 0, clean: false, ref: null, pushed: null, unowned: ["only.ts"], conflict: "ownership_unknown" };
		expect((await releaseCheckout(env, conn, SCOPE)).line).toMatch(/1 uncommitted path in it \(`only\.ts`\)/);
		runnerAnswer.value = { snapshot: null, files: 0, clean: false, ref: null, pushed: null, unowned: Array.from({ length: 30 }, (_, i) => `f${i}.ts`), conflict: "ownership_unknown" };
		const long = (await releaseCheckout(env, conn, SCOPE)).line;
		expect(long).toContain("`f9.ts`");
		expect(long).not.toContain("`f10.ts`");
		expect(long).toMatch(/and 20 more/);
	});

	it("#1718: a raw engine on an explicit shared-direct repo is told why nothing can be attributed to it", async () => {
		d1.exec("UPDATE coding_repos SET strategy = 'shared-direct' WHERE id = 'r1'");
		runnerAnswer.value = { snapshot: null, files: 0, clean: false, ref: null, pushed: null, unowned: ["src/a.ts"], conflict: "ownership_unknown" };
		const r = await releaseCheckout(env, conn, SCOPE);
		expect(r.released).toBe(false);
		expect(r.line).toMatch(/The codex engine reports no record of the files it edits or the commands it runs/);
	});

	it("#1718: Claude, and a repo with no stored strategy, keep the line they had", async () => {
		runnerAnswer.value = { snapshot: null, files: 0, clean: false, ref: null, pushed: null, unowned: ["src/a.ts"], conflict: "ownership_unknown" };
		expect((await releaseCheckout(env, conn, SCOPE)).line).not.toMatch(/engine reports no record/);
		d1.exec("UPDATE coding_repos SET strategy = 'shared-direct' WHERE id = 'r1'");
		d1.exec("UPDATE coding_sessions SET client_type = 'claude' WHERE id = 'csess_1'");
		expect((await releaseCheckout(env, conn, SCOPE)).line).not.toMatch(/engine reports no record/);
	});

	it("a runner that reports unowned paths WITHOUT the conflict flag (an older shape) is still never released", async () => {
		runnerAnswer.value = { snapshot: "abc", files: 1, clean: false, ref: "refs/pags/parked/x", unowned: ["theirs.txt"] };
		const r = await releaseCheckout(env, conn, SCOPE);
		expect(r.released).toBe(false);
		expect(r.line).toContain("`theirs.txt`");
	});

	it("CONTROL: a clean checkout is still released at once, as before", async () => {
		runnerAnswer.value = { snapshot: null, files: 0, clean: true, ref: null, pushed: null };
		const r = await releaseCheckout(env, conn, SCOPE);
		expect(r.released).toBe(true);
		expect(r.line).toMatch(/had no uncommitted changes/);
		expect(await sessionStatus()).toBe("suspended");
	});

	it("CONTROL: work the runner DID set aside (verified ownership) is released and reported by its exact id", async () => {
		runnerAnswer.value = { snapshot: "962966b2c2c17c2b490de21f33b78f6e31d82a3b", files: 2, clean: true, ref: `refs/pags/parked/${RUN}`, pushed: true };
		const r = await releaseCheckout(env, conn, SCOPE);
		expect(r.released).toBe(true);
		expect(r.line).toContain("962966b2c2c17c2b490de21f33b78f6e31d82a3b");
	});

	it("CONTROL: a runner that is not clean for any other reason keeps the old, generic line", async () => {
		runnerAnswer.value = { snapshot: null, files: 0, clean: false, ref: null, pushed: null };
		const r = await releaseCheckout(env, conn, SCOPE);
		expect(r).toEqual({ released: false, line: "The checkout stays held while it waits: it was not clean after setting the work aside." });
	});

	it("asks the runner without any ownership claim: the cloud never sends `exclusive`, so the whole-tree save cannot be requested", async () => {
		runnerAnswer.value = { snapshot: null, files: 0, clean: true, ref: null, pushed: null };
		await releaseCheckout(env, conn, SCOPE);
		const sent = runnerAnswer.calls.find((c) => c.path === "/coding/park-snapshot")?.body as Record<string, unknown>;
		expect(sent).toMatchObject({ repoId: "r1", runId: RUN });
		expect(sent).not.toHaveProperty("exclusive");
	});

	it("#1714: no stored strategy sends the request it always did - no session name, so the runner cannot infer ownership", async () => {
		runnerAnswer.value = { snapshot: null, files: 0, clean: true, ref: null, pushed: null };
		await releaseCheckout(env, conn, SCOPE);
		expect(runnerAnswer.calls.find((c) => c.path === "/coding/park-snapshot")?.body).not.toHaveProperty("sessionId");
	});

	it("#1714: an explicit shared-direct repository names the session, so the runner can prove which paths its engine wrote", async () => {
		d1.exec("UPDATE coding_repos SET strategy = 'shared-direct' WHERE id = 'r1'");
		runnerAnswer.value = { snapshot: "a".repeat(40), files: 1, clean: false, ref: `refs/pags/parked/${RUN}`, pushed: false, unowned: ["theirs.txt"] };
		const r = await releaseCheckout(env, conn, SCOPE);
		expect(runnerAnswer.calls.find((c) => c.path === "/coding/park-snapshot")?.body).toMatchObject({ sessionId: "csess_1" });
		expect(r.released).toBe(false); // a stranger's path is still in the way: held, and named
		expect(r.line).toContain("`theirs.txt`");
	});

	it("#1714: an isolated run holds its edits in its own worktree - nothing is asked of the shared checkout and nothing is set aside", async () => {
		d1.exec("UPDATE coding_repos SET strategy = 'isolated-direct' WHERE id = 'r1'");
		const r = await releaseCheckout(env, conn, SCOPE);
		expect(runnerAnswer.calls).toEqual([]);
		expect(r.released).toBe(true);
		expect(r.line).toMatch(/its own worktree/);
		expect(r.onStop).toBeUndefined();
		expect(await sessionStatus()).toBe("suspended");
	});
});
