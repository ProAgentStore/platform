import { describe, expect, it } from "vitest";
import { agentActLabel, anyPullInFlight, checksState, mergeTone, reviewLabel, type PullRow } from "./pulls-view";

const pull = (over: Partial<PullRow> = {}): PullRow => ({
	number: 1,
	title: "t",
	state: "open",
	draft: false,
	merged: false,
	author: "a",
	branch: "b",
	baseBranch: "main",
	labels: [],
	updatedAt: "2026-08-01T00:00:00Z",
	url: "u",
	mergeable: null,
	mergeableState: "unknown",
	review: "none",
	checks: null,
	agentAct: null,
	...over,
});

describe("mergeTone — an unknown is never rendered as a conflict", () => {
	/**
	 * The list endpoint omits `mergeable` and the detail endpoint answers null until GitHub's
	 * background job finishes. Both are "not known". Rendering that as "Conflicts" would send an
	 * owner to rebase a branch that merges fine — the false alarm this panel exists to avoid.
	 */
	it("shows nothing at all when mergeability is not known", () => {
		expect(mergeTone(pull({ mergeable: null }))).toBeNull();
	});

	it("shows Conflicts only when GitHub itself said false", () => {
		expect(mergeTone(pull({ mergeable: false }))).toMatchObject({ tone: "conflict", label: "Conflicts" });
	});

	it("distinguishes blocked and behind from a clean merge", () => {
		expect(mergeTone(pull({ mergeable: true, mergeableState: "clean" }))).toMatchObject({ tone: "clean" });
		expect(mergeTone(pull({ mergeable: true, mergeableState: "blocked" }))).toMatchObject({ tone: "blocked", label: "Blocked" });
		expect(mergeTone(pull({ mergeable: true, mergeableState: "behind" }))).toMatchObject({ tone: "blocked", label: "Behind base" });
	});

	it("says Draft first — a draft's mergeability is not the thing to report", () => {
		expect(mergeTone(pull({ draft: true, mergeable: true, mergeableState: "clean" }))).toMatchObject({ label: "Draft" });
	});
});

describe("reviewLabel", () => {
	it("badges only the states that carry information", () => {
		expect(reviewLabel("approved")).toBe("Approved");
		expect(reviewLabel("changes_requested")).toBe("Changes requested");
		expect(reviewLabel("commented")).toBe("Commented");
		// A "No reviews" chip on every fresh PR is noise, and "unknown" is not a review state at all.
		expect(reviewLabel("none")).toBeNull();
		expect(reviewLabel("unknown")).toBeNull();
	});
});

describe("checksState — the same mapping the Builds panel uses", () => {
	it("maps a run's status + conclusion", () => {
		expect(checksState(pull({ checks: { status: "completed", conclusion: "success" } }))).toBe("success");
		expect(checksState(pull({ checks: { status: "completed", conclusion: "failure" } }))).toBe("failed");
		expect(checksState(pull({ checks: { status: "in_progress", conclusion: null } }))).toBe("running");
		expect(checksState(pull({ checks: { status: "queued", conclusion: null } }))).toBe("pending");
	});

	it("calls a missing run unknown, never a pass", () => {
		expect(checksState(pull({ checks: null }))).toBe("unknown");
	});
});

describe("anyPullInFlight — the poll cadence signal", () => {
	it("is false for a settled list, so the panel drops to the passive interval", () => {
		expect(anyPullInFlight([pull({ checks: { status: "completed", conclusion: "success" } })])).toBe(false);
		expect(anyPullInFlight([])).toBe(false);
	});

	it("is true while any PR's checks are still moving", () => {
		expect(anyPullInFlight([pull(), pull({ checks: { status: "in_progress" } })])).toBe(true);
	});
});

describe("agentActLabel — exact attribution or none", () => {
	it("names what the agent did", () => {
		expect(agentActLabel({ traceId: "r", act: "pr.open", at: "", sessionId: null })).toBe("Opened by your agent");
		expect(agentActLabel({ traceId: "r", act: "pr.merge", at: "", sessionId: null })).toBe("Merged by your agent");
	});

	it("shows nothing when there is no act, and nothing for an act it cannot phrase", () => {
		expect(agentActLabel(null)).toBeNull();
		expect(agentActLabel({ traceId: "r", act: "push.force", at: "", sessionId: null })).toBeNull();
	});
});
