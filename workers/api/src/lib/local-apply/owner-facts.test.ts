import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../types.js";
import { realSchemaD1, type RealSchemaD1 } from "../d1-sqlite.js";
import { upsertProfile } from "../profile.js";
import { ownerFactsReceipt, ownerFactsSnapshot, readOwnerFactValues } from "./owner-facts.js";

let d1: RealSchemaD1;
const env = () => ({ DB: d1.DB }) as Env;
const scope = { instanceId: "apply", applicationId: "application", runId: "run" };
beforeEach(() => { d1 = realSchemaD1(); d1.exec("INSERT INTO users(id, github_login) VALUES ('owner', 'owner')"); });
afterEach(() => d1.close());

describe("current owner facts at dispatch (#1538)", () => {
	it("keeps identity and verbatim saved answers separate from job preferences without interpreting question wording", async () => {
		const longAnswer = "A saved answer with job-specific applicability. ".repeat(15);
		await upsertProfile(env(), "owner", { linkedin: "https://example.test/current", salaryExpectation: "180000", targetRoles: "Old role", voiceStopWordsLegacy: "stop", why_this_company: longAnswer });
		const values = await readOwnerFactValues(env(), "owner", "0.4.222");
		expect(values).toEqual({ identity: { linkedin: "https://example.test/current" }, savedAnswers: { why_this_company: longAnswer } });
		const facts = await ownerFactsSnapshot(values, scope, 1000);
		expect(facts).toMatchObject({ ...scope, capturedAt: "1970-01-01T00:00:01.000Z", source: "account_profile" });
		expect(ownerFactsReceipt(facts!)).toMatchObject({ sha256: facts!.revision, count: 2 });
		expect(JSON.stringify(ownerFactsReceipt(facts!))).not.toContain(longAnswer);
	});
	it("revisions identify content independently of dispatch time and change for updated identity", async () => {
		await upsertProfile(env(), "owner", { linkedin: "https://example.test/old" });
		const old = await readOwnerFactValues(env(), "owner", "0.4.222");
		const a = await ownerFactsSnapshot(old, scope, 1000);
		const b = await ownerFactsSnapshot(old, { ...scope, runId: "second" }, 2000);
		expect(b!.revision).toBe(a!.revision);
		await upsertProfile(env(), "owner", { linkedin: "https://example.test/current" });
		const c = await ownerFactsSnapshot(await readOwnerFactValues(env(), "owner", "0.4.222"), scope, 3000);
		expect(c!.revision).not.toBe(a!.revision);
		expect(a!.identity.linkedin).toBe("https://example.test/old");
	});
	it("refuses unsupported runners with facts, but preserves empty-profile compatibility", async () => {
		expect(await readOwnerFactValues(env(), "owner", "0.4.221")).toBeUndefined();
		await upsertProfile(env(), "owner", { firstName: "Owner" });
		await expect(readOwnerFactValues(env(), "owner", "0.4.221")).rejects.toThrow("0.4.222");
		await expect(readOwnerFactValues(env(), "owner")).rejects.toThrow("0.4.222");
	});
	it("fails closed instead of silently truncating saved answers", async () => {
		await upsertProfile(env(), "owner", { note: "x".repeat(65_536) });
		await expect(readOwnerFactValues(env(), "owner", "0.4.222")).rejects.toThrow("silently truncated");
	});
});
