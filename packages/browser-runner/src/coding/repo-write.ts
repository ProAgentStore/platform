import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { InspectError } from "./inspect.js";

/**
 * The ONE thing the platform may change in a checkout by itself (#322, the acting half).
 *
 * ── Why this is a separate file with a one-member enum
 *
 * `inspect.ts` states the design rule this file is the single, deliberate exception to: *reads
 * belong to the Co-pilot, writes belong to the Engine*. A standing policy has to be able to restore
 * an invariant with no human in the room, and the only two actuators that existed for that were the
 * Pilot and the Engine — a general coding CLI running `claude --dangerously-skip-permissions` on the
 * owner's own machine. Delegating "put the repo back on its branch" to one of those closes the
 * policy vocabulary at the NAME of the policy and leaves it wide open at the hands.
 *
 * So the vocabulary is closed HERE, at the hands: a fixed argv, one verb, no shell, and a branch
 * name that has to survive a character allowlist before it can become a git token. Adding a second
 * verb is a code review, and every argument in the git `checkout .` / `reset` / `clean` / `stash`
 * family is deliberately absent rather than gated — nothing in this module can discard a byte of
 * anyone's work.
 *
 * ── Why switching a branch is safe and committing a tree is not
 *
 * `git checkout <branch>` on a CLEAN tree moves a pointer. It destroys nothing, and the undo is
 * `git checkout <the branch you were on>`, which the caller is told verbatim. That is the whole
 * safety argument, and it is why the clean-tree precondition is checked HERE and not only in the
 * cloud: git carries uncommitted changes ACROSS a checkout, so switching a dirty tree silently
 * relocates somebody's work onto the target branch — the exact harm #276 exists to prevent, reached
 * from the other direction. A dirty tree is REFUSED, not stashed: `git stash` is repo-global across
 * worktrees and is how work gets swallowed.
 *
 * There is deliberately no `commit` verb. An unattended `add -A` runs over a tree that is unreviewed
 * BY CONSTRUCTION — if anyone had reviewed it, it would not be dirty — and `-A` sweeps in files git
 * was never told about. `repo.tree_clean` therefore has no actuator at all and stays observe-only;
 * see `workers/api/src/lib/repo-policies.ts`, which refuses to even accept `act` for it.
 *
 * ── The precondition that is NOT here, and why
 *
 * #322's assessment preferred "and the branch is pushed" alongside the clean-tree rule. It is not
 * enforced: leaving an unpushed branch loses nothing — the commits stay on it, the branch stays
 * where it was, and the printed undo puts the checkout back on it. Requiring a remote would make
 * the policy inert on exactly the local-only branches it is most useful on, in exchange for a
 * safety property a pointer move does not need.
 */

/** The closed write vocabulary. One member, and adding a second is a code review. */
export type GitWriteCmd = "switch-branch";

/**
 * May this string become a git token?
 *
 * An allowlist, not a denylist: `execFile` means there is no shell to escape, but a name beginning
 * `-` would still be read by git as an OPTION, which is the one injection this argv shape is open
 * to. The rest is `git check-ref-format` reduced to the subset a real branch uses.
 */
export function isSwitchableBranchName(name: unknown): name is string {
	if (typeof name !== "string") return false;
	const n = name.trim();
	if (!n || n.length > 200) return false;
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(n)) return false; // no leading `-` or `.`, no spaces, no `~^:?*[\`
	if (n.includes("..") || n.includes("//") || n.endsWith("/") || n.endsWith(".lock") || n.includes("@{")) return false;
	return true;
}

/** Map the enum to a fixed argv. The branch is the only caller-supplied token, and it is validated. */
export function gitWriteArgv(cmd: GitWriteCmd, opts: { branch?: string } = {}): string[] {
	switch (cmd) {
		case "switch-branch": {
			if (!isSwitchableBranchName(opts.branch)) throw new InspectError(`unusable branch name: ${String(opts.branch)}`);
			// `--` terminates option parsing AND says "what follows is a ref, not a path", so a branch
			// that shares a name with a file cannot turn this into a file checkout — which WOULD
			// discard work.
			return ["checkout", opts.branch.trim(), "--"];
		}
		default:
			throw new InspectError(`unsupported git write command: ${cmd as string}`);
	}
}

/** Why the runner declined. Every one of these leaves the checkout byte-identical. */
export type SwitchRefusal = "not-a-repo" | "dirty" | "unknown-branch" | "unknown-head";

export interface SwitchBranchResult {
	/** True only when the checkout is verifiably ON `to` afterwards. */
	ok: boolean;
	/** False when it was already there — a no-op is a success with nothing to undo. */
	changed: boolean;
	/** The branch it was on before, or the short SHA when HEAD was detached. Null = unreadable. */
	from: string | null;
	to: string;
	/** Read back AFTER the checkout, from git, not assumed from the exit code. */
	branch: string | null;
	/**
	 * Whether the tree has uncommitted work. `null` means git would not say (#291).
	 *
	 * It cannot default to `false`, because "clean" is the load-bearing word here: it is the
	 * precondition that makes an unattended checkout safe, and it is the clause the card prints to
	 * explain why nothing came along. This same function treats an unreadable `git status` as fatal
	 * BEFORE the switch — so answering "clean" after it would make one failure mean opposite things
	 * ten lines apart.
	 */
	dirty: boolean | null;
	refused?: SwitchRefusal;
	error?: string;
}

function git(workDir: string, argv: string[]): string {
	// stderr is PIPED rather than inherited: git narrates a checkout on stderr, and the runner's
	// console is a user-facing log, not a place for `Switched to branch 'main'`. Piping it is also
	// what makes `e.stderr` available, which is the only honest sentence to put on the card when git
	// itself refuses.
	return execFileSync("git", argv, {
		cwd: workDir,
		encoding: "utf-8",
		timeout: 15_000,
		maxBuffer: 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	}).toString();
}

/** The current branch, or the short SHA when detached, or null when even that fails. */
function currentBranch(workDir: string): string | null {
	try {
		const name = git(workDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
		if (name && name !== "HEAD") return name;
		return git(workDir, ["rev-parse", "--short", "HEAD"]).trim() || null;
	} catch {
		return null;
	}
}

function isDirty(workDir: string): boolean {
	// `--porcelain` alone: untracked files COUNT as dirty here, because they are exactly the ones a
	// checkout would carry across without git saying a word about it.
	return git(workDir, ["status", "--porcelain"]).trim().length > 0;
}

/**
 * Put the checkout back on `branch`, or refuse and change nothing.
 *
 * Never creates a branch, never fetches, never touches the remote: the target must already exist
 * locally, because inventing one would be deciding what should be true rather than restoring what
 * was declared. Every refusal path returns BEFORE any write.
 *
 * The repo test is `.git` at THIS path, not `git rev-parse --is-inside-work-tree` — the opposite of
 * the choice #405 made for the read side, and deliberately so. `rev-parse` answers yes from a
 * subdirectory, so a workdir that happens to sit inside a larger checkout (`~/dev/stores` is one)
 * would have its ENCLOSING repo switched by a policy declared on something else. A write acts only
 * on the repo the owner actually named; the cost is a refusal on a subdirectory workdir, which is
 * visible on the card and safe.
 */
export function switchRepoBranch(workDir: string, branch: string): SwitchBranchResult {
	if (!isSwitchableBranchName(branch)) throw new InspectError(`unusable branch name: ${String(branch)}`);
	const to = branch.trim();
	const base: SwitchBranchResult = { ok: false, changed: false, from: null, to, branch: null, dirty: false };
	if (!existsSync(resolve(workDir, ".git"))) return { ...base, refused: "not-a-repo" };

	const from = currentBranch(workDir);
	if (!from) return { ...base, refused: "unknown-head" };

	let dirty: boolean;
	try {
		dirty = isDirty(workDir);
	} catch (e) {
		return { ...base, from, branch: from, error: (e as Error).message?.slice(0, 200) };
	}
	// THE PRECONDITION. Uncommitted work rides along through a checkout; refusing is the only
	// answer that cannot move somebody's diff onto a branch they did not put it on.
	if (dirty) return { ...base, from, branch: from, dirty: true, refused: "dirty" };

	if (from === to) return { ok: true, changed: false, from, to, branch: from, dirty: false };

	try {
		git(workDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${to}`]);
	} catch {
		return { ...base, from, branch: from, refused: "unknown-branch" };
	}

	try {
		git(workDir, gitWriteArgv("switch-branch", { branch: to }));
	} catch (e) {
		const err = e as { stderr?: string; message?: string };
		return { ...base, from, branch: currentBranch(workDir), error: (err.stderr || err.message || "git checkout failed").slice(0, 200) };
	}

	// CONFIRM, do not assume. The exit code says the command ran; only reading HEAD back says where
	// the checkout actually is, and that is the only thing the cloud is allowed to report as done.
	const after = currentBranch(workDir);
	// And the same rule for the tree: `null` when git would not answer, never `false`. Nothing in
	// the cloud reads this field today — `repo-policy-act.ts` acts on `refused`, `error` and its own
	// independent read — so this is prophylactic rather than a live defect, and it is recorded that
	// way. What makes it worth changing anyway is that the value is a CLAIM and the next reader
	// inherits it: `dirty: false` off a failed `git status` says "clean" in the one field whose
	// whole job is to say whether anything came across. Absent is degraded; manufactured is wrong.
	let dirtyAfter: boolean | null;
	try {
		dirtyAfter = isDirty(workDir);
	} catch {
		dirtyAfter = null;
	}
	return { ok: after === to, changed: after === to, from, to, branch: after, dirty: dirtyAfter };
}
