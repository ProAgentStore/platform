/**
 * Admission-time write-scope refusal (#1402): the objective's own text is checked before any
 * coding work happens, catching the exact shape of the 15-run incident the issue cites — an
 * objective naming a different repository than the one the run actually resolved to.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";
import { writeScopeAdmissionRefusal } from "./write-scope-admission.js";

let d1: RealSchemaD1;
let env: Env;

function registerRepo(instanceId: string, userId: string, githubRepo: string) {
	d1.exec(
		`INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('repo-${instanceId}-${githubRepo.replace(/[^a-z0-9]/gi, "")}', '${instanceId}', '${userId}', 'r', '${githubRepo}')`,
	);
}

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1", "i2"] });
	env = { DB: d1.DB } as unknown as Env;
});

describe("writeScopeAdmissionRefusal (#1402)", () => {
	it("passes when the objective names the SAME repo this run resolved to", async () => {
		const r = await writeScopeAdmissionRefusal(env, { userId: "u1", instanceId: "i1", githubRepo: "ProAgentStore/platform", objective: "Implement ProAgentStore/platform#1402" });
		expect(r).toBeNull();
	});

	it("passes when the objective names no repo at all", async () => {
		const r = await writeScopeAdmissionRefusal(env, { userId: "u1", instanceId: "i1", githubRepo: "ProAgentStore/platform", objective: "fix the flaky test" });
		expect(r).toBeNull();
	});

	it("passes when this run's own repo has no GitHub slug (nothing to compare against — unknown is not a violation)", async () => {
		const r = await writeScopeAdmissionRefusal(env, { userId: "u1", instanceId: "i1", githubRepo: null, objective: "Implement proappstore-online/hiring#109" });
		expect(r).toBeNull();
	});

	it("refuses and names the owning coder when another of this user's instances is registered for the named repo", async () => {
		registerRepo("i2", "u1", "proappstore-online/hiring");
		const r = await writeScopeAdmissionRefusal(env, { userId: "u1", instanceId: "i1", githubRepo: "ProAgentStore/platform", objective: "Implement proappstore-online/hiring#109: fix the apply form" });
		expect(r?.reason).toBe("write_scope");
		expect(r?.detail).toEqual({ namedRepo: "proappstore-online/hiring", githubRepo: "ProAgentStore/platform", ownerInstanceId: "i2" });
		expect(r?.error).toContain("proappstore-online/hiring");
		expect(r?.error).toContain("ProAgentStore/platform");
		expect(r?.error).toContain("i2");
	});

	it("refuses and says so plainly when NO coder on the account is registered for the named repo", async () => {
		const r = await writeScopeAdmissionRefusal(env, { userId: "u1", instanceId: "i1", githubRepo: "ProAgentStore/platform", objective: "Implement ProAgentStore/runner-router#7" });
		expect(r?.reason).toBe("write_scope");
		expect(r?.detail).toEqual({ namedRepo: "ProAgentStore/runner-router", githubRepo: "ProAgentStore/platform" });
		expect(r?.error).toContain("No coder on this account is registered for it");
	});

	it("never attributes another ACCOUNT's coder — otherCodersOnRepo is scoped to the same userId", async () => {
		d1.exec("INSERT OR IGNORE INTO users (id, github_login) VALUES ('u2', 'u2')");
		d1.exec("INSERT OR IGNORE INTO agents (id, owner_id, slug, name) VALUES ('agent-2', 'u2', 'seeded2', 'Seeded2')");
		d1.exec("INSERT OR IGNORE INTO agent_instances (id, agent_id, user_id) VALUES ('i3', 'agent-2', 'u2')");
		registerRepo("i3", "u2", "proappstore-online/hiring"); // a DIFFERENT owner's coder on the same repo slug
		const r = await writeScopeAdmissionRefusal(env, { userId: "u1", instanceId: "i1", githubRepo: "ProAgentStore/platform", objective: "Implement proappstore-online/hiring#109" });
		expect(r?.detail.ownerInstanceId).toBeUndefined();
		expect(r?.error).toContain("No coder on this account is registered for it");
	});

	it("a D1 failure resolving the owner degrades to refusing without naming one, never throws", async () => {
		const broken: Env = { DB: { prepare: () => ({ bind: () => ({ all: () => Promise.reject(new Error("down")) }) }) } } as unknown as Env;
		const r = await writeScopeAdmissionRefusal(broken, { userId: "u1", instanceId: "i1", githubRepo: "ProAgentStore/platform", objective: "Implement proappstore-online/hiring#109" });
		expect(r?.reason).toBe("write_scope");
		expect(r?.detail.ownerInstanceId).toBeUndefined();
	});
});
