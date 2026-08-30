import { describe, expect, it } from "vitest";
import {
	describeRepoScopeViolation,
	recordRepoScopeViolations,
	repoSlugsInCommand,
	unscopedWrites,
} from "./repo-write-scope.js";
import type { EngineActReport } from "./engine-acts.js";
import type { Env } from "../types.js";

/** A D1 double: writes are recorded, reads answer nothing. Mirrors `coding-authority.test.ts`. */
function mockEnv(): { env: Env; writes: { sql: string; args: unknown[] }[] } {
	const writes: { sql: string; args: unknown[] }[] = [];
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
							return null;
						},
					};
				},
			};
		},
	};
	return { env: { DB } as unknown as Env, writes };
}

function act(over: Partial<EngineActReport> = {}): EngineActReport {
	return {
		id: "t1:0",
		kind: "pr.open",
		command: "gh pr create --repo ProAgentStore/platform --fill",
		target: null,
		irreversible: false,
		ok: true,
		at: "2026-08-16T01:55:44Z",
		atReliable: true,
		...over,
	};
}

/**
 * THE INCIDENT (#676), as the run actually recorded it.
 *
 * Instance `e4d2d031` ("PAS Coder") has exactly one registered repo,
 * `proappstore-online/platform`. Session `csess_f686f1ff` ran this literal command at
 * 2026-08-16T01:55:44Z and opened PR #675 in a different organisation, and the run reported
 * SUCCESS. This is the command string from the `act.consequential` row, not a reconstruction.
 */
const INCIDENT_COMMAND =
	"cd /Users/serge-ivo/dev/stores/pags/platform && gh pr create --repo ProAgentStore/platform --base main --head feat/update-board-ticket";

describe("the run that landed in the wrong organisation (#676)", () => {
	it("refuses the write and names the repository it was aimed at", () => {
		const found = unscopedWrites(["proappstore-online/platform"], [act({ kind: "pr.open", command: INCIDENT_COMMAND })]);
		expect(found).toHaveLength(1);
		expect(found[0].refused).toBe("ProAgentStore/platform");
	});

	it("states the refused target in the stop reason, not a generic failure", async () => {
		const { env, writes } = mockEnv();
		const reason = await recordRepoScopeViolations(
			env,
			{ userId: "u1", instanceId: "i1", sessionId: "csess_f686f1ff", repoLabel: "platform", traceId: null },
			["proappstore-online/platform"],
			[act({ kind: "pr.open", command: INCIDENT_COMMAND })],
		);
		// A silent refusal reproduces the defect with the opposite sign — the owner must read the
		// org that was written to, because that is the fact that was wrong.
		expect(reason).toContain("ProAgentStore/platform");
		expect(reason).toContain("not permitted");
		// And it must say what the agent IS allowed to write to, or the reader cannot tell a
		// misdirected run from a missing registration.
		expect(reason).toContain("proappstore-online/platform");
		// It is recorded, not merely returned: an error event AND a board card.
		expect(writes.length).toBeGreaterThan(0);
	});
});

describe("reads stay broad — only writes are scoped", () => {
	// The owner's stated reason (#676 item 3): a run legitimately consulted
	// `proappstore-online/platform` PR #138 while working on ProAgentStore/platform. Verified live:
	// the Engine ran `gh pr view 138 --repo proappstore-online/platform`. A read is not a
	// consequential act and must never reach this gate — but pin it, because the whole value of
	// the asymmetry is that it survives.
	it("does not fire on a cross-repo read", () => {
		expect(
			unscopedWrites(["ProAgentStore/platform"], [
				act({ kind: "file.delete", command: "gh pr view 138 --repo proappstore-online/platform --json title,body" }),
			]),
		).toEqual([]);
	});

	it("does not fire on a local-only act, whatever repo the command mentions", () => {
		for (const kind of ["reset.hard", "clean", "file.delete", "package.publish"]) {
			expect(unscopedWrites(["a/b"], [act({ kind, command: "git reset --hard github.com/other/repo" })])).toEqual([]);
		}
	});
});

describe("an in-scope write is untouched", () => {
	it("permits a write to the registered repo", () => {
		expect(unscopedWrites(["proappstore-online/platform"], [act({ command: "gh pr create --repo proappstore-online/platform --fill" })])).toEqual([]);
	});

	it("matches case-insensitively — GitHub owners are not case-sensitive", () => {
		expect(unscopedWrites(["ProAppStore-Online/Platform"], [act({ command: "gh pr create --repo proappstore-online/platform" })])).toEqual([]);
	});

	it("permits a write to ANY of several registered repos", () => {
		expect(unscopedWrites(["a/one", "b/two"], [act({ command: "gh pr create --repo b/two" })])).toEqual([]);
	});
});

describe("unknown is never a violation", () => {
	// The conservative direction, and the one that matters: this gate HALTS a run. A command that
	// names no repository is the ordinary shape of `git push` in a checkout, and inferring the repo
	// from a working directory this record does not carry would be a guess. A guess that stops a
	// working run is worse than the gap it closes.
	it("says nothing when the command names no repository", () => {
		expect(unscopedWrites(["a/b"], [act({ command: "git push -u origin feat/thing" })])).toEqual([]);
		expect(unscopedWrites(["a/b"], [act({ command: "gh pr create --fill" })])).toEqual([]);
	});

	it("says nothing when the instance has no registered GitHub repo to compare against", () => {
		// A local-path repo with no `github_repo` gives us no scope at all. Refusing every write
		// there would break every local-only Coder; permitting is stated, not assumed.
		expect(unscopedWrites([], [act({ command: INCIDENT_COMMAND })])).toEqual([]);
	});
});

describe("repoSlugsInCommand only reads positions that DENOTE a repository", () => {
	it("reads gh's own --repo/-R flag", () => {
		expect(repoSlugsInCommand("gh pr create --repo owner/name")).toEqual(["owner/name"]);
		expect(repoSlugsInCommand("gh pr merge 12 -R owner/name --merge")).toEqual(["owner/name"]);
		expect(repoSlugsInCommand("gh pr create --repo=owner/name")).toEqual(["owner/name"]);
	});

	it("reads an https remote, with or without .git", () => {
		expect(repoSlugsInCommand("git push https://github.com/owner/name.git HEAD")).toEqual(["owner/name"]);
		expect(repoSlugsInCommand("open https://github.com/owner/name/pull/675")).toEqual(["owner/name"]);
	});

	it("reads an scp-style remote through a CUSTOM ssh host alias", () => {
		// The owner's machine rewrites github.com to `github-personal` via ~/.ssh/config, so a rule
		// anchored on the literal host would miss every push this account makes.
		expect(repoSlugsInCommand("git push git@github-personal:ProAgentStore/platform.git main")).toEqual(["ProAgentStore/platform"]);
		expect(repoSlugsInCommand("git remote add origin git@github.com:owner/name.git")).toEqual(["owner/name"]);
	});

	it("reads a gh api repos/ path", () => {
		expect(repoSlugsInCommand("gh api repos/owner/name/pulls -X POST")).toEqual(["owner/name"]);
	});

	it("does NOT read a ref, a path, or a flag as a repository", () => {
		// Every one of these would be a false positive that halts a legitimate run.
		for (const cmd of [
			"git push origin refs/heads/main",
			"git push origin main:main",
			"git rm src/lib/foo.ts",
			"gh pr create --head feat/update-board-ticket --base main",
			"git push --force-with-lease origin/main",
		]) {
			expect(repoSlugsInCommand(cmd)).toEqual([]);
		}
	});
});

describe("describeRepoScopeViolation", () => {
	it("leads with the refused target, and is honest about an unobserved outcome", () => {
		const s = describeRepoScopeViolation("ProAgentStore/platform", ["proappstore-online/platform"], {
			kind: "pr.open",
			ok: null,
		});
		expect(s).toContain('Attempted write to "ProAgentStore/platform"');
		expect(s).toContain("not permitted");
		expect(s).toContain("outcome not observed");
	});
});
