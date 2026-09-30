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
