import { describe, expect, it } from "vitest";
import { annotateOwnerAttribution, attributionNotice, claimsOwnerDecision } from "./run-attribution.js";

/** The sentence the owner actually read, from the run that broke his deploy (#505). */
const INCIDENT =
	"`app/pubspec.yaml` bumped from `1.0.127+133` to `1.0.127+134` per explicit user instruction." +
	" The user was warned that `admin/pubspec.yaml` should be bumped instead (since `admin/**` changed)," +
	" but explicitly chose to bump `app/pubspec.yaml` and proceed." +
	" The version-check gate for the admin deploy may fail in CI as a result.";

describe("claimsOwnerDecision", () => {
	it("catches the report that attributed a broken deploy to an owner who never spoke", () => {
		expect(claimsOwnerDecision(INCIDENT)).toBe(true);
	});

	it.each([
		"Bumped the version per explicit user instruction.",
		"The user was warned that this would fail the version-check gate.",
		"The user explicitly chose to proceed.",
		"The owner approved the merge.",
		"You asked me to skip the tests.",
		"You explicitly declined the rebase.",
		"Done at the user's request.",
		"Merged to main per your instruction.",
		"Proceeded with your explicit approval.",
		"The human confirmed the destructive step.",
	])("flags %j", (text) => {
		expect(claimsOwnerDecision(text)).toBe(true);
	});

	it.each([
		"",
		"Added a test for the version-check gate and pushed the branch.",
		// The bare mention of a person is not attribution — only a decision verb makes it one.
		"The user's repo has no test script, so nothing ran.",
		// "user" as a compound noun is the commonest word in a coding report; it must not trip this.
		"Updated the user model and the user table to match the schema.",
		"Rewrote the user-facing docs and the user interface copy.",
		"Fixed the request status field on the user record.",
		// Addressed to the owner, deciding nothing on his behalf.
		"You can review the PR at github.com/x/y/pull/3.",
		"The build failed; I have left the branch in place for you to look at.",
	])("leaves %j alone", (text) => {
		expect(claimsOwnerDecision(text)).toBe(false);
	});
});

describe("annotateOwnerAttribution", () => {
	it("stamps a completion message that speaks for an owner who never spoke to the run", () => {
		const out = annotateOwnerAttribution(INCIDENT, 0);
		expect(out.startsWith(INCIDENT)).toBe(true);
		expect(out).toContain(attributionNotice());
	});

	it("keeps the agent's own words — the owner has to see the claim to distrust it", () => {
		// Rewriting or deleting the sentence would hide the disagreement instead of surfacing it,
		// and would leave the owner unable to tell what the agent believed it was doing.
		expect(annotateOwnerAttribution(INCIDENT, 0)).toContain("per explicit user instruction");
	});

	it("says nothing when the owner DID intervene in this run", () => {
		// A resolved takeover or a supplied value means the claim may well be true, and a notice
		// that fires on true statements stops being read.
		expect(annotateOwnerAttribution(INCIDENT, 1)).toBe(INCIDENT);
	});

	it("says nothing about a report that claims nothing", () => {
		const plain = "Ran the tests, fixed the failing assertion, pushed.";
		expect(annotateOwnerAttribution(plain, 0)).toBe(plain);
	});

	it("names the objective as the one thing the owner did author, rather than calling the agent a liar", () => {
		// The platform cannot know whether the objective authorised the decision — only that no
		// message reached the run. It says what it knows and points at where to check.
		const notice = attributionNotice();
		expect(notice).toContain("objective");
		expect(notice).toContain('role: "user"');
		expect(notice).not.toMatch(/lie|lied|false|fabricat/i);
	});
});
