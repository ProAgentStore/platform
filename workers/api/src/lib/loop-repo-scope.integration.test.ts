/**
 * `coding_loop_start`'s repo_id against the REAL schema (#877): a repo is only ever chosen from the
 * repos registered on THIS instance for THIS owner. `pickLoopRepo` is pure; what makes the refusal
 * a tenancy guarantee is that `listRepos` is scoped by instance and user in SQL, so it is asserted
 * here on migrated tables rather than on a stub that returns whatever it is given.
 *
 * The coding driver picks the repo before it asks about a runner, so a refusal here never reaches
 * a machine — and an accepted repo proceeds to the runner check, whose refusal names the repo it
 * chose.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { loopDriverFor } from "./loop-drivers.js";
import type { AgentCapabilities } from "./agent-capabilities.js";
import type { Env } from "../types.js";

let d1: RealSchemaD1;
let env: Env;

const coding = { surfaces: [], runtime: null, workflow: "CODING_SESSION", tools: undefined } as unknown as AgentCapabilities;
const base = { objective: "fix it", budgetId: "b1", depth: 0, userId: "u1" };

function repo(id: string, instanceId: string, userId: string, name: string) {
	d1.exec(`INSERT INTO coding_repos (id, instance_id, user_id, name, default_client, workdir) VALUES ('${id}', '${instanceId}', '${userId}', '${name}', 'claude', '/w/${id}')`);
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["multi", "single", "other"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["theirs"] });
	repo("r-platform", "multi", "u1", "proappstore-online/platform");
	repo("r-template", "multi", "u1", "proappstore-online/template-app");
	repo("r-single", "single", "u1", "acme/only");
	repo("r-other-instance", "other", "u1", "acme/elsewhere");
	repo("r-other-owner", "theirs", "u2", "them/private");
	// No runner is registered: a repo that is ACCEPTED goes on to the connectivity check and is
	// refused there, by name — which is how these tests see which repo was chosen.
	env = { DB: d1.DB } as unknown as Env;
});

afterEach(() => d1.close());

const start = (instanceId: string, extra: { repoId?: string; requireRepoChoice?: boolean } = {}) =>
	loopDriverFor(coding).start({ env, ...base, instanceId, ...extra });

describe("coding_loop_start repo_id on the real schema (#877)", () => {
	it("a targeted repo is the one the run goes to", async () => {
		const out = await start("multi", { repoId: "r-template", requireRepoChoice: true });
		expect(out.ok).toBe(false); // no runner in this test — refused at connectivity, AFTER the pick
		if (!out.ok) expect(out.error).toContain("proappstore-online/template-app");
	});

	it("a repo of ANOTHER instance of the same owner is refused, never substituted", async () => {
		const out = await start("multi", { repoId: "r-other-instance", requireRepoChoice: true });
		expect(out).toMatchObject({ ok: false, status: 409 });
		if (!out.ok) {
			expect(out.error).toContain("(r-other-instance) is not on this agent");
			expect(out.error).toContain("r-platform");
			expect(out.error).not.toContain("acme/elsewhere");
		}
	});

	it("a repo of ANOTHER owner is refused, and its name never leaks", async () => {
		const out = await start("multi", { repoId: "r-other-owner", requireRepoChoice: true });
		expect(out).toMatchObject({ ok: false, status: 409 });
		if (!out.ok) {
			expect(out.error).toContain("is not on this agent");
			expect(out.error).not.toContain("them/private");
		}
	});

	it("omitted on the multi-repo instance: refused with exactly this instance's repo_ids", async () => {
		const out = await start("multi", { requireRepoChoice: true });
		expect(out).toMatchObject({ ok: false, status: 409 });
		if (!out.ok) {
			expect(out.error).toContain("r-platform (proappstore-online/platform)");
			expect(out.error).toContain("r-template (proappstore-online/template-app)");
			expect(out.error).not.toContain("r-single");
			expect(out.error).not.toContain("r-other");
		}
	});

	it("omitted on a single-repo instance: unchanged — its one repo is used", async () => {
		const out = await start("single", { requireRepoChoice: true });
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.error).toContain("acme/only");
			expect(out.error).not.toContain("needs a repo_id");
		}
	});
});

/**
 * Write-scope admission (#1402): the SAME incident `repo-write-scope.ts` halts mid-run — an
 * objective naming a different repo than the one chosen — refused here instead, before `pickLoopRepo`
 * even hands the run a runner to check. These run on the same real schema and `start()` helper above;
 * only the objective text (not the fixed `base.objective`) varies, so each call is built directly.
 */
describe("coding_loop_start write-scope admission (#1402)", () => {
	// The fixture repos above are registered with `name` as a human label only (`github_repo` is left
	// NULL — `pickLoopRepo`'s own refusal text reads `name`, never `github_repo`). Write-scope admission
	// specifically needs a real `github_repo` slug to compare the objective's text against, so these
	// two rows get one here rather than changing what the #877 tests above already rely on.
	beforeEach(() => {
		d1.exec("UPDATE coding_repos SET github_repo = 'acme/only' WHERE id = 'r-single'");
		d1.exec("UPDATE coding_repos SET github_repo = 'proappstore-online/platform' WHERE id = 'r-platform'");
	});

	it("refuses BEFORE connectivity when the objective names a repo this instance did not resolve to, naming the other coder", async () => {
		const out = await loopDriverFor(coding).start({ ...base, env, instanceId: "single", objective: "Implement proappstore-online/platform#1402: fix admission" });
		expect(out).toMatchObject({ ok: false, status: 409, reason: "write_scope" });
		if (!out.ok) {
			expect(out.error).toContain("proappstore-online/platform");
			expect(out.error).toContain("acme/only"); // the repo this instance actually resolved to
			expect(out.error).toContain("multi"); // the OTHER instance registered for the named repo
			expect(out.error).not.toContain("not reachable"); // never got far enough to ask about a runner
		}
	});

	it("passes through to the ordinary connectivity refusal when the objective names no repo, or names the resolved one", async () => {
		for (const objective of ["fix it, no repo named", "Implement acme/only#5: fix it"]) {
			const out = await loopDriverFor(coding).start({ ...base, env, instanceId: "single", objective });
			expect(out).toMatchObject({ ok: false, status: 409 });
			if (!out.ok) {
				expect(out.reason).not.toBe("write_scope");
				expect(out.error).toContain("acme/only"); // reached the connectivity refusal, which names the chosen repo
			}
		}
	});

	it("refuses even with no other coder registered for the named repo — says so, and names nobody", async () => {
		const out = await loopDriverFor(coding).start({ ...base, env, instanceId: "single", objective: "Implement nobody/elsewhere#1: do the thing" });
		expect(out).toMatchObject({ ok: false, status: 409, reason: "write_scope" });
		if (!out.ok) {
			expect(out.error).toContain("No coder on this account is registered for it");
			expect(out.detail).toEqual({ namedRepo: "nobody/elsewhere", githubRepo: "acme/only" });
		}
	});
});
