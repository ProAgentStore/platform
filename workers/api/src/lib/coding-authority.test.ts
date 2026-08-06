import { describe, expect, it } from "vitest";
import {
	DEFAULT_MERGE_POLICY,
	authorityInstruction,
	describeAuthority,
	describeViolation,
	forbiddenActKinds,
	mergePolicyPatch,
	parseMergePolicy,
	policyLabel,
	readMergePolicyForRun,
	recordAuthorityViolations,
	resolveMergePolicy,
	screenInstruction,
	unauthorizedActs,
} from "./coding-authority.js";
import type { EngineActReport } from "./engine-acts.js";
import type { Env } from "../types.js";

/** A D1 double: `first()` answers from `rows` keyed by a fragment of the SQL; writes are recorded. */
function mockEnv(rows: Record<string, unknown> = {}): { env: Env; writes: { sql: string; args: unknown[] }[] } {
	const writes: { sql: string; args: unknown[] }[] = [];
	const match = (sql: string) => Object.entries(rows).find(([k]) => sql.includes(k))?.[1] ?? null;
	const DB = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async run() {
							writes.push({ sql, args });
							return { meta: { changes: 1 } };
						},
						async all() {
							return { results: [] };
						},
						async first() {
							return match(sql);
						},
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, writes };
}

function act(kind: string, over: Partial<EngineActReport> = {}): EngineActReport {
	return { id: `t1:0`, kind, command: `gh pr merge 150 --squash`, target: "#150", irreversible: true, ok: true, at: "2026-08-07T00:00:00Z", ...over };
}

describe("the default is today's behaviour", () => {
	// The single most important assertion in this file. Defaulting to blocked would change how an
	// owner's Coder behaves without them asking — work they rely on starts failing. Every arm of the
	// gate must be a literal no-op under the default, so an owner who configures nothing sees
	// nothing change.
	it("permits everything and emits no prompt text", () => {
		expect(DEFAULT_MERGE_POLICY).toBe("merge");
		expect(resolveMergePolicy({})).toBe("merge");
		expect(forbiddenActKinds("merge").size).toBe(0);
		expect(authorityInstruction("merge")).toBeNull();
		expect(describeAuthority("merge", "claude")).toBeNull();
		expect(screenInstruction("merge", "gh pr merge 42 --squash")).toBeNull();
		expect(unauthorizedActs("merge", [{ kind: "pr.merge" }, { kind: "push.trunk" }])).toEqual([]);
	});
});

describe("resolveMergePolicy", () => {
	it("prefers the repo over the agent setting over the platform default", () => {
		expect(resolveMergePolicy({ repo: "none", agent: "pr" })).toBe("none");
		expect(resolveMergePolicy({ agent: "pr" })).toBe("pr");
		expect(resolveMergePolicy({ repo: "", agent: "" })).toBe("merge");
	});

	it("falls THROUGH an unrecognised value rather than inventing a policy", () => {
		// A typo must not become a policy nobody chose — in either direction.
		expect(resolveMergePolicy({ repo: "PR", agent: "none" })).toBe("none");
		expect(resolveMergePolicy({ repo: "block-everything" })).toBe("merge");
		expect(parseMergePolicy("nope")).toBeNull();
		expect(parseMergePolicy(7)).toBeNull();
	});
});

describe("forbiddenActKinds", () => {
	it("pr forbids exactly the two acts that put code on the trunk", () => {
		expect([...forbiddenActKinds("pr")].sort()).toEqual(["pr.merge", "push.trunk"]);
	});

	it("pr does NOT forbid force-push — rebasing a feature branch is ordinary in a PR workflow", () => {
		expect(forbiddenActKinds("pr").has("push.force")).toBe(false);
		expect(forbiddenActKinds("pr").has("pr.open")).toBe(false);
	});

	it("none forbids publishing outward at all", () => {
		const none = forbiddenActKinds("none");
		for (const k of ["pr.merge", "push.trunk", "push.force", "push", "pr.open", "branch.delete"]) {
			expect(none.has(k)).toBe(true);
		}
	});
});

describe("authorityInstruction", () => {
	it("tells the Pilot what to do when the OBJECTIVE contradicts the policy", () => {
		const text = authorityInstruction("pr") ?? "";
		expect(text).toContain("OVERRIDES the objective");
		expect(text).toContain("must NOT merge");
		// The incident's failure mode was silent compliance; silent refusal is the other one.
		expect(text).toContain("SAY PLAINLY");
	});

	it("none forbids pushing and opening a PR too", () => {
		expect(authorityInstruction("none")).toContain("must NOT push");
	});
});

describe("screenInstruction — the Pilot cannot relay a merge order", () => {
	// The literal shape of the incident: run 73ffc073's objective said "merge each before starting
	// the next" and the Pilot relayed it three times.
	it.each([
		"Merge PR #150 with --squash, then start on issue #83",
		"run gh pr merge 151 --squash --delete-branch",
		"Now squash and merge it",
		"merge the pull request once CI is green",
		"merge this branch into main",
	])("refuses %j under policy pr", (text) => {
		expect(screenInstruction("pr", text)).toMatch(/not permitted/i);
	});

	it("allows ordinary work, and allows the policy being RELAYED", () => {
		expect(screenInstruction("pr", "Open a PR for the fix and report the number")).toBeNull();
		expect(screenInstruction("pr", "git push -u origin fix/314 then gh pr create --fill")).toBeNull();
		// Without the negation check the guard would fire on the very sentence it caused the brain
		// to write, which reads as the feature being broken.
		expect(screenInstruction("pr", "Do not merge the PR — the owner has to approve it")).toBeNull();
		expect(screenInstruction("pr", "Never merge to main in this repo")).toBeNull();
	});

	it("does not treat merging main INTO a feature branch as a trunk merge", () => {
		expect(screenInstruction("pr", "git merge main to pick up the latest changes")).toBeNull();
	});

	it("none additionally refuses pushing and opening a PR", () => {
		expect(screenInstruction("none", "git push -u origin fix/314")).toMatch(/not permitted/i);
		expect(screenInstruction("none", "open a pull request for the change")).toMatch(/not permitted/i);
		expect(screenInstruction("none", "Commit the change with a clear message")).toBeNull();
	});

	it("ignores empty text", () => {
		expect(screenInstruction("pr", "   ")).toBeNull();
	});
});

describe("unauthorizedActs", () => {
	const acts = [
		{ kind: "pr.open", target: "#150", ok: true },
		{ kind: "pr.merge", target: "#150", ok: true },
		{ kind: "push", target: "origin fix", ok: null },
	];

	it("catches the merge under pr and leaves the rest alone", () => {
		expect(unauthorizedActs("pr", acts).map((a) => a.kind)).toEqual(["pr.merge"]);
	});

	it("counts an attempt whose outcome is unknown or failed — the breach is running it", () => {
		expect(unauthorizedActs("pr", [{ kind: "pr.merge", ok: null }, { kind: "pr.merge", ok: false }])).toHaveLength(2);
	});
});

describe("describeViolation", () => {
	it("never presents an unobserved or failed command as a completed merge", () => {
		expect(describeViolation("pr", { kind: "pr.merge", target: "#150", ok: true })).toBe(
			"Not permitted by this repository's merge policy (pr): the agent merged a pull request #150.",
		);
		expect(describeViolation("pr", { kind: "pr.merge", target: "#150", ok: false })).toContain("the command FAILED");
		expect(describeViolation("pr", { kind: "pr.merge", target: null, ok: null })).toContain("outcome not observed");
	});
});

describe("describeAuthority — the honest limit on a non-reporting engine", () => {
	it("states the policy plainly on an engine whose acts are observed", () => {
		const note = describeAuthority("pr", "claude") ?? "";
		expect(note).toContain("Merge policy: pr");
		expect(note).toContain(policyLabel("pr"));
		expect(note).not.toContain("does not report");
	});

	it.each(["codex", "grok", "gemini"])("says out loud that %s reports nothing to check", (engine) => {
		// A gate that silently permits everything on these engines while looking like protection is
		// worse than no gate. This is the sentence that stops it looking like protection.
		expect(describeAuthority("pr", engine)).toContain("does not report what it ran");
	});

	it("claims nothing at all under the default policy, on any engine", () => {
		expect(describeAuthority("merge", "codex")).toBeNull();
	});
});

describe("mergePolicyPatch", () => {
	it("distinguishes not-set from cleared from chosen", () => {
		expect(mergePolicyPatch(undefined)).toEqual({ ok: true });
		expect(mergePolicyPatch("")).toEqual({ ok: true, value: "" });
		expect(mergePolicyPatch("pr")).toEqual({ ok: true, value: "pr" });
	});

	it("REFUSES an unrecognised value rather than quietly keeping the old one", () => {
		// A caller who believes they tightened the policy and did not is worse off than one who got
		// an error, because they now trust a gate that is not there.
		const r = mergePolicyPatch("block");
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.error).toMatch(/must be one of/);
	});
});

describe("readMergePolicyForRun", () => {
	it("prefers the repo column over the agent's typed setting", async () => {
		const { env } = mockEnv({
			"FROM coding_repos": { merge_policy: "none" },
			"FROM agent_instances": { config: JSON.stringify({ settings: { merge_policy: "pr" } }) },
		});
		expect(await readMergePolicyForRun(env, { instanceId: "i", userId: "u", repoId: "r" })).toBe("none");
	});

	it("falls back to the agent setting when the repo has no override", async () => {
		const { env } = mockEnv({
			"FROM coding_repos": { merge_policy: "" },
			"FROM agent_instances": { config: JSON.stringify({ settings: { merge_policy: "pr" } }) },
		});
		expect(await readMergePolicyForRun(env, { instanceId: "i", userId: "u", repoId: "r" })).toBe("pr");
	});

	it("degrades to the PERMISSIVE default on unreadable config — a blip must not invent a restriction", async () => {
		const { env } = mockEnv({ "FROM agent_instances": { config: "{not json" } });
		expect(await readMergePolicyForRun(env, { instanceId: "i", userId: "u", repoId: "r" })).toBe("merge");
	});
});

describe("recordAuthorityViolations", () => {
	const ctx = { userId: "u", instanceId: "i", sessionId: "s1", repoLabel: "fws/platform", traceId: "run-1" };

	it("writes nothing and stops nothing under the default policy", async () => {
		const { env, writes } = mockEnv();
		expect(await recordAuthorityViolations(env, ctx, "merge", [act("pr.merge")])).toBeNull();
		expect(writes).toEqual([]);
	});

	it("records the breach at error level, raises a board card, and returns the stop reason", async () => {
		const { env, writes } = mockEnv();
		const reason = await recordAuthorityViolations(env, ctx, "pr", [act("pr.open", { kind: "pr.open" }), act("pr.merge")]);
		expect(reason).toMatch(/merged a pull request #150/);
		const trace = writes.find((w) => w.sql.includes("INSERT INTO agent_events"));
		expect(trace).toBeTruthy();
		// `error`, not the `warn` #294 gives an ordinary irreversible act — this is a breach.
		expect(trace?.args).toContain("error");
		expect(trace?.args).toContain("act.unauthorized");
		// The permitted pr.open must not be reported as a violation.
		expect(writes.filter((w) => w.sql.includes("INSERT INTO agent_events"))).toHaveLength(1);
		// A pending human decision belongs on the board, not only in a log nobody opens.
		expect(writes.some((w) => /instance_runtime_tasks|board/i.test(w.sql))).toBe(true);
	});

	it("uses a deterministic id so a retried step cannot report the same merge twice", async () => {
		const a = mockEnv();
		const b = mockEnv();
		await recordAuthorityViolations(a.env, ctx, "pr", [act("pr.merge")]);
		await recordAuthorityViolations(b.env, ctx, "pr", [act("pr.merge")]);
		const idOf = (w: { sql: string; args: unknown[] }[]) => w.find((x) => x.sql.includes("INSERT INTO agent_events"))?.args[0];
		expect(idOf(a.writes)).toBe(idOf(b.writes));
		expect(idOf(a.writes)).toBe("authz:s1:t1:0");
	});
});
