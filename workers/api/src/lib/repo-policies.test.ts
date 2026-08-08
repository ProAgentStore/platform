import { describe, expect, it } from "vitest";
import { dirtyClause, offTrunkClause, type RepoWorkingState } from "./repo-observation.js";
import {
	evaluateRepoPolicies,
	parseRepoPolicies,
	REPO_POLICIES,
	repoPolicyCardId,
	resolveRepoPolicyMode,
	sanitizeRepoPolicies,
	type RepoPolicyId,
} from "./repo-policies.js";
import { describeRepoState } from "./repo-state.js";

const clean: RepoWorkingState = { branch: "main", dirty: false, changedFiles: 0 };
const dirty: RepoWorkingState = { branch: "main", dirty: true, changedFiles: 3 };
const offTrunkDirty: RepoWorkingState = { branch: "fix/36", dirty: true, changedFiles: 3 };
const offTrunkClean: RepoWorkingState = { branch: "fix/36", dirty: false, changedFiles: 0 };

function find(findings: ReturnType<typeof evaluateRepoPolicies>, id: RepoPolicyId) {
	const f = findings.find((x) => x.policy === id);
	if (!f) throw new Error(`no finding for ${id}`);
	return f;
}

describe("the vocabulary is closed", () => {
	it("has no `act` mode — the safety property is that it is ABSENT, not gated", () => {
		// If this ever fails, an actuator was added. It needs a fixed-argv runner write surface and
		// an explicit per-repo human promotion, not a new enum member.
		const modes = new Set<string>();
		for (const p of REPO_POLICIES) modes.add(p.fallback);
		expect(modes.has("act")).toBe(false);
		expect(sanitizeRepoPolicies({ "repo.tree_clean": "act" })).toEqual({
			ok: false,
			error: "policy `repo.tree_clean` must be one of: off, observe",
		});
	});

	it("refuses an unknown policy instead of silently dropping it", () => {
		// A dropped key would read to the owner as "declared", and a policy that quietly never
		// applies is indistinguishable from one that is holding.
		const res = sanitizeRepoPolicies({ "repo.fix_everything": "observe" });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("unknown policy `repo.fix_everything`");
	});

	it("accepts a valid declaration, an empty one, and null", () => {
		expect(sanitizeRepoPolicies({ "repo.on_default_branch": "observe" })).toEqual({
			ok: true,
			value: { "repo.on_default_branch": "observe" },
		});
		expect(sanitizeRepoPolicies({})).toEqual({ ok: true, value: {} });
		expect(sanitizeRepoPolicies(null)).toEqual({ ok: true, value: {} });
	});

	it("refuses non-objects", () => {
		expect(sanitizeRepoPolicies("observe").ok).toBe(false);
		expect(sanitizeRepoPolicies(["repo.tree_clean"]).ok).toBe(false);
		expect(sanitizeRepoPolicies(7).ok).toBe(false);
	});
});

describe("stored column", () => {
	it("reads a declaration back", () => {
		expect(parseRepoPolicies('{"repo.tree_clean":"off"}')).toEqual({ "repo.tree_clean": "off" });
	});

	it("treats corrupt, empty and absent JSON as declared-nothing rather than throwing", () => {
		expect(parseRepoPolicies("not json")).toBeUndefined();
		expect(parseRepoPolicies("{}")).toBeUndefined();
		expect(parseRepoPolicies(null)).toBeUndefined();
		expect(parseRepoPolicies(undefined)).toBeUndefined();
		// A row written by a future version carrying a policy this build does not implement must
		// not take the repo's whole declaration down with it.
		expect(parseRepoPolicies('{"repo.from_the_future":"observe"}')).toBeUndefined();
	});
});

describe("defaults preserve what shipped", () => {
	it("tree_clean observes by default — the #276 card is unconditional today", () => {
		expect(resolveRepoPolicyMode(undefined, "repo.tree_clean")).toBe("observe");
		expect(resolveRepoPolicyMode({}, "repo.tree_clean")).toBe("observe");
	});

	it("on_default_branch is off by default — a feature branch is frequently intended", () => {
		expect(resolveRepoPolicyMode(undefined, "repo.on_default_branch")).toBe("off");
	});

	it("an explicit declaration overrides the default in both directions", () => {
		expect(resolveRepoPolicyMode({ "repo.tree_clean": "off" }, "repo.tree_clean")).toBe("off");
		expect(resolveRepoPolicyMode({ "repo.on_default_branch": "observe" }, "repo.on_default_branch")).toBe("observe");
	});
});

describe("card ids are the ones already in production", () => {
	it("tree_clean keeps #276's id, so cards open right now still close", () => {
		expect(repoPolicyCardId("repo.tree_clean", "repo_1")).toBe("repo-dirty-repo_1");
	});

	it("on_default_branch has its own", () => {
		expect(repoPolicyCardId("repo.on_default_branch", "repo_1")).toBe("repo-branch-repo_1");
	});
});

describe("evaluate", () => {
	const base = { repoId: "repo_1", repoLabel: "fws/platform", configuredBranch: null };

	it("raises a violation for a dirty tree, attributed to the policy that raised it", () => {
		const f = find(evaluateRepoPolicies({ ...base, declared: undefined, state: dirty }), "repo.tree_clean");
		expect(f.status).toBe("violated");
		expect(f.cardId).toBe("repo-dirty-repo_1");
		expect(f.card?.type).toBe("coding.uncommitted");
		expect(f.card?.title).toBe("Uncommitted work in fws/platform");
		expect(f.card?.subtitle).toBe("on main");
		// The acceptance criterion of #322: "why is there a card about this" answerable without
		// reading a diff.
		expect(f.card?.description).toContain("(standing policy `repo.tree_clean`)");
		expect(f.card?.description).toContain("3 uncommitted files");
	});

	it("holds — and so closes the card — when the tree is clean", () => {
		const f = find(evaluateRepoPolicies({ ...base, declared: undefined, state: clean }), "repo.tree_clean");
		expect(f.status).toBe("held");
		expect(f.card).toBeNull();
	});

	it("an unobserved repo is UNKNOWN, never held — the card is left exactly as it is", () => {
		// The rule inherited verbatim from repo-state.ts: an absent report says nothing. A machine
		// that is off must not be able to close a card by failing to answer.
		const findings = evaluateRepoPolicies({ ...base, declared: { "repo.on_default_branch": "observe" }, state: null });
		expect(find(findings, "repo.tree_clean").status).toBe("unknown");
		expect(find(findings, "repo.on_default_branch").status).toBe("unknown");
	});

	it("a policy the repo no longer claims is UNCLAIMED even when unobserved — its card is retired", () => {
		// Turning a policy off must not leave a needs_human card open forever, and that has to work
		// with the machine offline, which is exactly when someone is turning things off.
		const f = find(evaluateRepoPolicies({ ...base, declared: { "repo.tree_clean": "off" }, state: null }), "repo.tree_clean");
		expect(f.status).toBe("unclaimed");
		expect(f.cardId).toBe("repo-dirty-repo_1");
	});

	it("does not raise a branch card for a repo that has not claimed the invariant", () => {
		const f = find(evaluateRepoPolicies({ ...base, declared: undefined, state: offTrunkClean }), "repo.on_default_branch");
		expect(f.status).toBe("unclaimed");
	});

	it("raises a branch card when the invariant IS claimed", () => {
		const findings = evaluateRepoPolicies({ ...base, declared: { "repo.on_default_branch": "observe" }, state: offTrunkClean });
		const f = find(findings, "repo.on_default_branch");
		expect(f.status).toBe("violated");
		expect(f.card?.type).toBe("coding.off_branch");
		expect(f.card?.title).toBe("fws/platform is not on the trunk");
		expect(f.card?.description).toContain("`fix/36`");
		expect(f.card?.description).toContain("(standing policy `repo.on_default_branch`)");
	});

	it("compares against the CONFIGURED branch when the repo has one", () => {
		const findings = evaluateRepoPolicies({
			...base,
			configuredBranch: "develop",
			declared: { "repo.on_default_branch": "observe" },
			state: { branch: "main", dirty: false, changedFiles: 0 },
		});
		const f = find(findings, "repo.on_default_branch");
		expect(f.status).toBe("violated");
		expect(f.card?.title).toBe("fws/platform is not on develop");
	});

	it("never calls an unknown branch off-trunk", () => {
		// An older runner sends no status header. Reporting a confidently wrong branch to a
		// supervisor is worse than reporting none.
		const findings = evaluateRepoPolicies({
			...base,
			declared: { "repo.on_default_branch": "observe" },
			state: { branch: null, dirty: false, changedFiles: 0 },
		});
		expect(find(findings, "repo.on_default_branch").status).toBe("held");
	});

	it("keeps the branch fact on the dirty card while nothing else claims it", () => {
		// The default configuration must not LOSE information: today's card carries both clauses.
		const f = find(evaluateRepoPolicies({ ...base, declared: undefined, state: offTrunkDirty }), "repo.tree_clean");
		expect(f.card?.description).toContain("on branch `fix/36`");
		expect(f.card?.description).toContain("3 uncommitted files");
	});

	it("moves the branch fact off the dirty card once the branch policy owns it", () => {
		// …and does not say it twice, which would read as two problems.
		const findings = evaluateRepoPolicies({ ...base, declared: { "repo.on_default_branch": "observe" }, state: offTrunkDirty });
		expect(find(findings, "repo.tree_clean").card?.description).not.toContain("on branch");
		expect(find(findings, "repo.on_default_branch").card?.description).toContain("on branch `fix/36`");
	});

	it("caps the description including its attribution", () => {
		const long = "x".repeat(500);
		const findings = evaluateRepoPolicies({ ...base, repoLabel: long, declared: undefined, state: dirty });
		const f = find(findings, "repo.tree_clean");
		expect(f.card?.title.length).toBeLessThanOrEqual(200);
		expect((f.card?.description ?? "").length).toBeLessThanOrEqual(300);
		expect(f.card?.description).toContain("(standing policy `repo.tree_clean`)");
	});

	it("returns a finding for every policy in the registry", () => {
		const findings = evaluateRepoPolicies({ ...base, declared: undefined, state: clean });
		expect(findings.map((f) => f.policy).sort()).toEqual(REPO_POLICIES.map((p) => p.id).sort());
	});
});

describe("the clauses stay the ones #276 wrote", () => {
	it("composes into the unchanged supervisor sentence", () => {
		// The whole reason the clauses live here: one definition each. If describeRepoState ever
		// stops reading exactly like this, the card and the supervisor note have drifted apart.
		expect(describeRepoState(offTrunkDirty)).toBe(
			`This checkout is ${offTrunkClause(offTrunkDirty)}; ${dirtyClause(offTrunkDirty)}.`,
		);
		expect(describeRepoState(clean)).toBeNull();
	});

	it("still states that nothing will discard the work", () => {
		expect(dirtyClause(dirty)).toContain("it will NOT be discarded");
	});
});
