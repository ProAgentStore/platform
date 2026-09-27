import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	describeRepoScopeViolation,
	outOfScopeWrite,
	recordRepoScopeViolations,
	remoteWriteText,
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

describe("prose about the change is not where it was written (#872)", () => {
	// The CRM run that was halted for writing to "mcp/apps": instance d9027b1e, run 61199405,
	// registered for proappstore-online/crm. It added CRM files and pushed `origin main`; the
	// commit message, in a heredoc, named the CRM app's MCP URL.
	const CRM_COMMAND = [
		"git add CLAUDE.md docs/mcp.md scripts/smoke-pas-mcp.mjs && git commit -m \"$(cat <<'EOF'",
		"docs: document the PAS MCP endpoint",
		"",
		"The CRM app is served at https://mcp.proappstore.online/mcp/apps/crm.",
		"EOF",
		')" && git push origin main',
	].join("\n");

	it("a URL path in a heredoc commit message does not make the push out of scope", () => {
		expect(unscopedWrites(["proappstore-online/crm"], [act({ kind: "push.trunk", command: CRM_COMMAND })])).toEqual([]);
	});

	it("nor does a URL in an inline -m message, an unquoted heredoc, or a PR's title and body", () => {
		for (const command of [
			'git commit -m "see https://mcp.proappstore.online/mcp/apps/crm" && git push origin main',
			"git commit -F - <<EOF\nlinks https://github.com/other/repo/issues/9\nEOF\ngit push origin main",
			'gh pr create --repo proappstore-online/crm --title "Port https://github.com/other/repo" --body "Mirrors https://github.com/other/repo/pull/3"',
			"gh pr merge 12 --squash --subject 'from https://github.com/other/repo' --body=https://github.com/other/repo/pull/3",
		]) {
			expect(unscopedWrites(["proappstore-online/crm"], [act({ kind: "push", command })]), command).toEqual([]);
		}
	});

	it("a heredoc line that LOOKS like a push is still prose", () => {
		const command = "git commit -F - <<'MSG'\nnever run: git push https://github.com/other/repo.git main\nMSG\ngit push origin main";
		expect(unscopedWrites(["proappstore-online/crm"], [act({ kind: "push.trunk", command })])).toEqual([]);
	});

	it("a real push to an unregistered remote is still refused — after the same heredoc commit", () => {
		const command = CRM_COMMAND.replace("git push origin main", "git push https://github.com/other-org/other-repo.git main");
		const found = unscopedWrites(["proappstore-online/crm"], [act({ kind: "push.trunk", command })]);
		expect(found.map((f) => f.refused)).toEqual(["other-org/other-repo"]);
	});

	it("still refuses an unregistered ssh remote, --repo target, dry-run push, and mutating gh api call", () => {
		const cases: Array<[string, string]> = [
			["git push git@github-personal:other-org/other-repo.git main", "other-org/other-repo"],
			['gh pr create --repo other-org/other-repo --title "x" --body "y"', "other-org/other-repo"],
			["git push -n https://github.com/other-org/other-repo.git main", "other-org/other-repo"],
			["git push origin main && gh api repos/other-org/other-repo/pulls -X POST -f title=x", "other-org/other-repo"],
		];
		for (const [command, refused] of cases) {
			expect(outOfScopeWrite(["proappstore-online/crm"], { kind: "push", command }), command).toBe(refused);
		}
	});

	it("a cross-repo READ on the same line as an in-scope push is not judged", () => {
		const command = "gh api repos/other-org/other-repo/pulls/138 && git push origin main";
		expect(outOfScopeWrite(["proappstore-online/crm"], { kind: "push", command })).toBeNull();
	});
});

describe("body payloads of any gh command are not targets (#873)", () => {
	// Run 9f2e7ddc posted the #872 closing comment with `gh issue comment 872 --repo
	// ProAgentStore/platform --body-file - <<'EOF'`; its body named the CRM URL and `git push`, and
	// the guard refused "mcp/apps" three times. The fixture is that command; `stored` is the first
	// 400 characters, as the trace holds it — cut inside the body, with no terminator.
	const full = readFileSync(new URL("../../../../packages/browser-runner/src/coding/fixtures/trace-9f2e7ddc/issue-comment.sh", import.meta.url), "utf8");
	const stored = full.trim().slice(0, 400);
	const registered = ["ProAgentStore/platform"];

	it("the trace's issue-comment command, stored or whole, is not a write to mcp/apps", () => {
		for (const command of [stored, full]) {
			for (const kind of ["pr.open", "push"]) expect(outOfScopeWrite(registered, { kind, command })).toBeNull();
		}
	});

	it("a body cut before its terminator is still body — even a line that reads as a push", () => {
		// The gap #872's terminator-only pattern left: this was refused as "mcp/apps".
		const command = "gh issue comment 872 --repo ProAgentStore/platform --body-file - <<'EOF'\nFor example git push https://mcp.proappstore.online/mcp/apps/crm main";
		expect(outOfScopeWrite(registered, { kind: "push", command })).toBeNull();
	});

	it("genuine cross-repo writes are still refused — including right after a body", () => {
		const cases: Array<[string, string]> = [
			["git push https://mcp.proappstore.online/mcp/apps/crm main", "mcp/apps"],
			['gh pr create --repo other-org/other-repo --title "x"', "other-org/other-repo"],
			["gh issue comment 1 --repo ProAgentStore/platform --body-file - <<'EOF'\nbody\nEOF\ngit push https://github.com/other-org/other-repo.git main", "other-org/other-repo"],
			["git commit -F - <<'EOF' && git push git@github.com:other-org/other-repo.git main\nmsg\nEOF", "other-org/other-repo"],
		];
		for (const [command, refused] of cases) expect(outOfScopeWrite(registered, { kind: "push", command }), command).toBe(refused);
	});
});

describe("remoteWriteText keeps the Git operation and drops the prose", () => {
	it("keeps only the write segments, without heredoc bodies or gh prose values", () => {
		const text = remoteWriteText("git add a && git commit -m \"$(cat <<'EOF'\nhttps://x.test/a/b\nEOF\n)\" && git push origin main && gh pr create --body 'https://x.test/c/d' --fill");
		expect(text).toContain("git push origin main");
		expect(text).toContain("gh pr create");
		expect(text).not.toMatch(/x\.test|git add|git commit/);
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
