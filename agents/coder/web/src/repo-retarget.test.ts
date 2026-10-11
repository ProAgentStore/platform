import { describe, expect, it } from "vitest";
import { describeRetargetBlocker, retargetRequestBody } from "./repo-retarget";

/** The console's retarget request (#1012): explicit expected-current from the listed row, nothing guessed. */
describe("retargetRequestBody", () => {
	const repo = { id: "r1", name: "platform", githubRepo: "acme/platform", githubRepositoryId: 100, bindingVersion: 3 };

	it("sends the listed identity and version as expected-current", () => {
		expect(retargetRequestBody(repo, { owner: " acme ", name: "platform-archive", githubId: "100" }, true)).toEqual({
			expectedCurrent: { owner: "acme", name: "platform", version: 3, githubId: 100 },
			destination: { owner: "acme", name: "platform-archive", githubId: 100 },
			dryRun: true,
		});
	});

	it("asserts the destination id for a binding with none recorded yet", () => {
		const body = retargetRequestBody({ id: "r1", name: "p", githubRepo: "acme/platform" }, { owner: "acme", name: "x", githubId: "100" }, false);
		expect(body?.expectedCurrent).toEqual({ owner: "acme", name: "platform", version: 1, githubId: 100 });
	});

	it.each([
		["no id", { owner: "acme", name: "x", githubId: "" }],
		["a non-numeric id", { owner: "acme", name: "x", githubId: "abc" }],
		["no name", { owner: "acme", name: " ", githubId: "100" }],
	])("is incomplete with %s", (_l, dest) => {
		expect(retargetRequestBody(repo, dest, true)).toBeNull();
	});

	it("names known blockers and passes unknown codes through", () => {
		expect(describeRetargetBlocker("queued_work")).toMatch(/queued/);
		expect(describeRetargetBlocker("something_new")).toBe("something_new");
	});
});
