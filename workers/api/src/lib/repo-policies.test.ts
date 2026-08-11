import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
	it("no policy ACTS by default — the acting half changes nothing on any repo until a human says so", () => {
		// The deploy-day property. `act` now exists, so this is the test that has to hold instead of
		// "there is no act": a fallback of `act` would promote every repo in the fleet at once.
		for (const p of REPO_POLICIES) expect(p.fallback).not.toBe("act");
	});

	it("refuses `act` for a policy with no actuator — declined, not unimplemented", () => {
		// tree_clean is the policy the ticket wanted most and the one that cannot act: an unattended
		// `add -A` runs over a tree that is unreviewed BY CONSTRUCTION. The refusal says so, because
		// "act is not in the list" reads as a gap somebody should close.
		const res = sanitizeRepoPolicies({ "repo.tree_clean": "act" });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toContain("must be one of: off, observe");
			expect(res.error).toContain("has no actuator");
		}
		expect(REPO_POLICIES.find((p) => p.id === "repo.tree_clean")?.actuator).toBeNull();
	});

	it("a policy that CAN act reaches exactly one verb", () => {
		// The safety property moved from "there is no act" to "act is closed at the HANDS": the verb
		// maps to a fixed argv on the runner (packages/browser-runner/src/coding/repo-write.ts), not
		// to a goal handed to a general coding Engine.
		const acting = REPO_POLICIES.filter((p) => p.actuator);
		expect(acting.map((p) => p.id)).toEqual(["repo.on_default_branch"]);
		expect(acting.map((p) => p.actuator?.verb)).toEqual(["switch_branch"]);
		expect(sanitizeRepoPolicies({ "repo.on_default_branch": "act" })).toEqual({
			ok: true,
			value: { "repo.on_default_branch": "act" },
		});
	});

	it("a stored `act` on a policy whose actuator was withdrawn degrades to observing", () => {
		// The reader refuses it too, not only the writer: a row written by a build where a policy
		// COULD act must not keep acting on a verb that no longer exists.
		expect(resolveRepoPolicyMode({ "repo.tree_clean": "act" }, "repo.tree_clean")).toBe("observe");
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

	it("an OBSERVING violation plans nothing — no mode but `act` may produce a remediation", () => {
		const f = find(evaluateRepoPolicies({ ...base, configuredBranch: "main", declared: { "repo.on_default_branch": "observe" }, state: offTrunkClean }), "repo.on_default_branch");
		expect(f.status).toBe("violated");
		expect(f.remediation).toBeNull();
		expect(f.refusal).toBeNull();
	});

	it("plans the switch when the repo declared `act`, the tree is clean and a branch is declared", () => {
		const f = find(evaluateRepoPolicies({ ...base, configuredBranch: "main", declared: { "repo.on_default_branch": "act" }, state: offTrunkClean }), "repo.on_default_branch");
		expect(f.mode).toBe("act");
		expect(f.remediation).toEqual({ verb: "switch_branch", branch: "main" });
	});

	it("REFUSES to act on a dirty tree, and the card says why", () => {
		// git carries uncommitted changes across a checkout, so acting here relocates work somebody
		// left deliberately (#276) onto the target branch — the same harm, reached the other way.
		const f = find(evaluateRepoPolicies({ ...base, configuredBranch: "main", declared: { "repo.on_default_branch": "act" }, state: offTrunkDirty }), "repo.on_default_branch");
		expect(f.remediation).toBeNull();
		expect(f.refusal).toContain("3 uncommitted files would be carried onto `main`");
		expect(f.card?.description).toContain("Not switched:");
	});

	it("REFUSES to act when the repo declares no branch — a target is never inferred", () => {
		// Off-trunk is decided against main/master when nothing is configured. That is enough to
		// REPORT and not enough to ACT: the cloud does not know which of the two this checkout has,
		// and picking one is inventing the target — the false-premise failure #440 is about.
		const f = find(evaluateRepoPolicies({ ...base, configuredBranch: null, declared: { "repo.on_default_branch": "act" }, state: offTrunkClean }), "repo.on_default_branch");
		expect(f.remediation).toBeNull();
		expect(f.refusal).toContain("declares no branch");
	});

	it("never plans anything on an UNOBSERVED repo — a transport failure cannot move a branch", () => {
		// `state: null` is what a dropped socket looks like. #440 stored one of those as the repo's
		// own verdict for five days; an actuator that acted on a stale row would act on a lie.
		const f = find(evaluateRepoPolicies({ ...base, configuredBranch: "main", declared: { "repo.on_default_branch": "act" }, state: null }), "repo.on_default_branch");
		expect(f.status).toBe("unknown");
		expect(f.remediation).toBeNull();
	});

	it("an ACTING branch policy owns the branch fact, exactly as an observing one does", () => {
		// `!== "off"`, not `=== "observe"`: promoting to act must not make the dirty card start
		// repeating the branch clause, which would read as two problems.
		const findings = evaluateRepoPolicies({ ...base, configuredBranch: "main", declared: { "repo.on_default_branch": "act" }, state: offTrunkDirty });
		expect(find(findings, "repo.tree_clean").card?.description).not.toContain("on branch");
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

/**
 * WHO MAY PROMOTE A POLICY TO `act` — asserted over the SOURCE, because it is an absence.
 *
 * A policy is the one thing on this platform that acts with nobody present, so an agent able to
 * create or promote one converts a single prompt injection into a STANDING capability. #322 states
 * the rule: promotion is an explicit human action, per policy per repo, and never a value an agent
 * can write. Today that holds because exactly one route accepts the field and no agent-facing
 * surface calls it — which is invisible, and would be silently undone by one new MCP tool.
 *
 * The offender sets are compared EXACTLY rather than "⊆ allowed", the shape `security-invariants.ts`
 * uses: removing a caller fails the guard too, so the list can only change deliberately.
 */
describe("promotion is a human action", () => {
	const API = new URL("../", import.meta.url).pathname; // workers/api/src
	const MCP = new URL("../../../mcp/src/", import.meta.url).pathname;

	function walk(dir: string): string[] {
		const out: string[] = [];
		for (const entry of readdirSync(dir)) {
			const p = join(dir, entry);
			if (statSync(p).isDirectory()) out.push(...walk(p));
			else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) out.push(p);
		}
		return out;
	}

	it("exactly one route accepts a policy declaration", () => {
		const callers = walk(API)
			.filter((p) => readFileSync(p, "utf-8").includes("sanitizeRepoPolicies"))
			.map((p) => p.slice(API.length))
			.sort();
		expect(callers).toEqual(["lib/repo-policies.ts", "routes/coding-repos.ts"]);
	});

	it("no MCP tool can reach the route that accepts one", () => {
		// The MCP worker talks to the API over HTTP, so the guard is on the PATH it names. Both known
		// references are the collection (list repos / add a repo); the promotion route is the
		// per-repo `PUT …/coding/repos/:repoId`, which nothing here may construct.
		const paths = new Set<string>();
		for (const p of walk(MCP)) {
			for (const m of readFileSync(p, "utf-8").matchAll(/["'`]([^"'`]*coding\/repos[^"'`]*)["'`]/g)) paths.add(m[1]);
		}
		// Spelled by concatenation so the literal is not itself a template placeholder — biome reads
		// `${…}` inside a plain string as a mistake, and here it is the exact text being asserted.
		expect([...paths].sort()).toEqual([`/v1/instances/$\{instance_id}/coding/repos`]);
	});
});
