import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ownerFactsReceipt, ownerFactSources, parseOwnerFacts } from "./owner-facts.js";

const scope = { instanceId: "apply", applicationId: "application", runId: "run" };
function snapshot() {
	const content = { identity: { linkedin: "https://example.test/current" }, savedAnswers: { "Use which profile?": "Use the current one." } };
	return { schemaVersion: 1, source: "account_profile", ...scope, capturedAt: "2026-11-05T00:00:00Z", revision: createHash("sha256").update(JSON.stringify(content)).digest("hex"), ...content };
}

describe("owner source integrity (#1538)", () => {
	it("provides distinct current identity and saved-answer sources without replacing historical input", () => {
		const historical = { label: "profile", text: "Historical link https://example.test/old and salary 180000" };
		const facts = parseOwnerFacts(snapshot(), scope)!;
		const sources = [historical, ...ownerFactSources(facts)];
		expect(sources[0]).toEqual(historical);
		expect(JSON.parse(sources[1].text)).toMatchObject({ facts: facts.identity, revision: facts.revision, runId: "run" });
		expect(JSON.parse(sources[2].text)).toMatchObject({ answers: facts.savedAnswers });
		expect(ownerFactsReceipt(facts)).toMatchObject({ sha256: facts.revision, count: 2 });
		expect(JSON.stringify(ownerFactsReceipt(facts))).not.toContain("example.test");
	});
	it.each(["instanceId", "applicationId", "runId"] as const)("rejects a snapshot from another %s", (key) => {
		expect(() => parseOwnerFacts({ ...snapshot(), [key]: "other" }, scope)).toThrow("run binding");
	});
	it("rejects tampered values and malformed sources before model input", () => {
		const raw = snapshot();
		raw.identity.linkedin = "https://example.test/tampered";
		expect(() => parseOwnerFacts(raw, scope)).toThrow("revision");
		for (const bad of [null, {}, { ...snapshot(), savedAnswers: [] }, { ...snapshot(), capturedAt: "unknown" }]) expect(() => parseOwnerFacts(bad, scope)).toThrow();
		expect(parseOwnerFacts(undefined, scope)).toBeUndefined();
		expect(ownerFactSources(undefined)).toEqual([]);
	});
});
