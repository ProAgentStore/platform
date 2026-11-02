/**
 * `namedOtherRepo` / `namesOtherRepo` (#1402): the one place that pulls an explicit `owner/repo` slug
 * out of objective prose and compares it against the resolved repo. `namesOtherRepo` is kept as a
 * thin boolean wrapper over `namedOtherRepo` for its existing callers (`startIssueFor`, `linkRunToIssue`).
 */
import { describe, expect, it } from "vitest";
import { namedOtherRepo, namesOtherRepo } from "./issue-tickets.js";

describe("namedOtherRepo", () => {
	it("returns the named repo when it differs from the resolved one", () => {
		expect(namedOtherRepo("Implement proappstore-online/hiring#109: fix the apply form", "ProAgentStore/platform")).toBe("proappstore-online/hiring");
	});

	it("returns null when the objective names no repo at all", () => {
		expect(namedOtherRepo("fix the flaky test", "ProAgentStore/platform")).toBeNull();
	});

	it("returns null when the objective names the SAME repo, case-insensitively", () => {
		expect(namedOtherRepo("Implement ProAgentStore/Platform#1402", "ProAgentStore/platform")).toBeNull();
	});

	it("returns null when there is no resolved repo to compare against", () => {
		expect(namedOtherRepo("Implement proappstore-online/hiring#109", null)).toBeNull();
	});

	it("reads the FIRST owner/repo#N reference, not a later one", () => {
		expect(namedOtherRepo("See proappstore-online/hiring#109, related to acme/other#5", "ProAgentStore/platform")).toBe("proappstore-online/hiring");
	});
});

describe("namesOtherRepo", () => {
	it("is exactly namedOtherRepo !== null", () => {
		expect(namesOtherRepo("Implement proappstore-online/hiring#109", "ProAgentStore/platform")).toBe(true);
		expect(namesOtherRepo("Implement ProAgentStore/platform#1402", "ProAgentStore/platform")).toBe(false);
		expect(namesOtherRepo("fix it", "ProAgentStore/platform")).toBe(false);
	});
});
