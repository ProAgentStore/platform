import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { InspectError, networkGitEnv } from "./inspect.js";

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

/**
 * The closed write vocabulary. Two members, and adding a third is a code review.
 *
 * `fast-forward` (#802) is the second: `git pull --ff-only` on a CLEAN tree that is ON its declared
 * branch and HAS an upstream. It shares the safety argument with `switch-branch` — a fast-forward
 * moves a pointer along a line git has already verified is a straight line; it creates no merge
 * commit, rewrites nothing, and refuses by construction the moment local history has diverged. The
 * undo is `git reset --keep <the sha it came from>`, which the caller is told verbatim. Nothing in
 * the `checkout .` / `reset --hard` / `clean` / `stash` family is reachable through it.
 */
export type GitWriteCmd = "switch-branch" | "fast-forward";

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
		case "fast-forward":
			// No caller-supplied token at all: the branch is whatever HEAD is (checked against the
			// declared one BEFORE this runs), the remote is the upstream git records for it. `--ff-only`
			// is the whole contract — git aborts, touching nothing, when the histories have diverged.
			// `--no-rebase` so a `pull.rebase=true` config on the owner's machine cannot turn the
			// abort into a rebase of their local commits.
			return ["pull", "--ff-only", "--no-rebase"];
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

function git(workDir: string, argv: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): string {
	// stderr is PIPED rather than inherited: git narrates a checkout on stderr, and the runner's
	// console is a user-facing log, not a place for `Switched to branch 'main'`. Piping it is also
	// what makes `e.stderr` available, which is the only honest sentence to put on the card when git
	// itself refuses.
	return execFileSync("git", argv, {
		cwd: workDir,
		encoding: "utf-8",
		timeout: opts.timeout ?? 15_000,
		maxBuffer: 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
		env: opts.env,
	}).toString();
}

/** git's diagnosis is the FIRST `fatal:`/`error:` line of stderr; the tail is boilerplate. */
function gitFailureLine(e: unknown): string {
	const err = e as { stderr?: string; message?: string };
	const lines = String(err.stderr || err.message || "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? "git failed";
	return line.replace(/^(fatal|error):\s*/i, "").slice(0, 200);
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

/**
 * Why the runner declined to fast-forward. Every one of these leaves the checkout byte-identical.
 *
 * `dirty` is deliberately NOT here any more (#804). It was, at 0.4.59, and the first run it met
 * was a checkout 18 commits behind with one untracked `.claude/` folder — tooling cruft that a
 * fast-forward would never have touched — refused for being "dirty", with a human told to go and
 * remove it by hand. A fast-forward is not a checkout: it carries nothing across, and git itself
 * refuses, atomically and naming the file, when an incoming commit would overwrite a local change
 * or an untracked path. THAT is the precondition, checked against the real history by the tool
 * that owns it, and it surfaces below as `error`. The tree is reported (`dirty`, before and after)
 * so the caller can still say what was there.
 */
export type FastForwardRefusal = "not-a-repo" | "unknown-head" | "detached" | "off-branch" | "no-upstream";

export interface FastForwardResult {
	/** True only when the pull ran AND HEAD was read back afterwards. */
	ok: boolean;
	/** False when there was nothing to bring in — a no-op is a success with nothing to undo. */
	changed: boolean;
	/** The branch the checkout is on. Null when HEAD could not be read. */
	branch: string | null;
	/** The remote-tracking ref pulled from, e.g. `origin/main`. Null when there is none. */
	upstream: string | null;
	/** Full SHAs, read from git before and after — the `from` is what the undo needs. */
	from: string | null;
	to: string | null;
	/** How many commits the fast-forward brought in. Null when git would not count. */
	commits: number | null;
	/**
	 * Whether the tree has uncommitted work — read BEFORE the pull on every path, re-read after a
	 * pull that ran. `null` means git would not say (#291). Informational: a dirty tree does not
	 * refuse a fast-forward (see {@link FastForwardRefusal}), but the owner is told it was there.
	 */
	dirty: boolean | null;
	refused?: FastForwardRefusal;
	error?: string;
}

/**
 * Bring a CLEAN checkout up to its upstream, or refuse and change nothing (#802).
 *
 * Every precondition is checked HERE, at the hands, not only in the cloud — the same rule
 * `switchRepoBranch` follows and for the same reason: the cloud's picture of the tree is a read
 * taken moments earlier over a relay, and the write has to be safe against the tree as it IS.
 *
 *   dirty        NOT refused (#804 — it was at 0.4.59). Unlike a checkout, a fast-forward carries
 *                nothing across: an uncommitted edit to a file the incoming commits do not touch is
 *                the same edit afterwards, and one they DO touch makes git abort before writing a
 *                byte ("Your local changes … would be overwritten"). Untracked files likewise —
 *                left alone, unless an incoming commit adds that path, which git refuses by name.
 *                The check is therefore git's own, against the real history, and arrives as
 *                `error`. Nothing here stashes, cleans or commits on the owner's behalf.
 *   off-branch   refused when `branch` is given and HEAD is elsewhere. The declared branch is the
 *                one the cloud judged stale; pulling whatever the checkout happens to be on would
 *                be acting on a verdict about a different ref.
 *   detached     refused — there is no branch for a pull to advance.
 *   no-upstream  refused — `git pull` with no tracking information is a prompt, and a guess about
 *                which remote was meant is exactly the decision this module must never make.
 *   diverged     NOT a precondition: `--ff-only` is the check, and git makes it atomically against
 *                the real history. It surfaces as `error`, with the tree untouched.
 *
 * Never creates a branch, never sets an upstream, never stashes.
 */
export function fastForwardRepo(workDir: string, opts: { branch?: string } = {}): FastForwardResult {
	const want = typeof opts.branch === "string" && opts.branch.trim() ? opts.branch.trim() : null;
	if (want !== null && !isSwitchableBranchName(want)) throw new InspectError(`unusable branch name: ${String(opts.branch)}`);
	const base: FastForwardResult = { ok: false, changed: false, branch: null, upstream: null, from: null, to: null, commits: null, dirty: false };
	if (!existsSync(resolve(workDir, ".git"))) return { ...base, refused: "not-a-repo" };

	let abbrev: string;
	try {
		abbrev = git(workDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
	} catch {
		return { ...base, refused: "unknown-head" };
	}
	if (!abbrev) return { ...base, refused: "unknown-head" };
	if (abbrev === "HEAD") return { ...base, refused: "detached" };
	const branch = abbrev;

	// Read, reported, never a refusal (see the doc above). A status git will not give is `null`,
	// not `false` — "clean" is a claim, and this is the field the owner's sentence is built from.
	let dirty: boolean | null;
	try {
		dirty = isDirty(workDir);
	} catch {
		dirty = null;
	}
	if (want !== null && branch !== want) return { ...base, branch, dirty, refused: "off-branch" };

	let upstream: string;
	try {
		upstream = git(workDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).trim();
	} catch {
		return { ...base, branch, dirty, refused: "no-upstream" };
	}
	if (!upstream) return { ...base, branch, dirty, refused: "no-upstream" };

	let from: string | null;
	try {
		from = git(workDir, ["rev-parse", "HEAD"]).trim() || null;
	} catch {
		from = null;
	}

	try {
		// The one network call in this file: the no-prompt environment `inspect.ts` uses for
		// fetches, and a timeout above the runner's fetch cap, because a pull IS a fetch first.
		git(workDir, gitWriteArgv("fast-forward"), { timeout: 30_000, env: networkGitEnv() });
	} catch (e) {
		// `--ff-only` refused, an incoming commit would overwrite a local change or an untracked
		// path, the network failed, or auth was needed and (correctly) not prompted for. In every
		// case git left the tree as it was; the sentence says which, and names the file when there
		// is one.
		return { ...base, branch, upstream, from, to: from, dirty, error: gitFailureLine(e) };
	}

	// CONFIRM, do not assume — read HEAD back and count what arrived from git, not from the
	// exit code.
	let to: string | null;
	try {
		to = git(workDir, ["rev-parse", "HEAD"]).trim() || null;
	} catch {
		to = null;
	}
	let commits: number | null = null;
	if (from && to) {
		try {
			const n = Number.parseInt(git(workDir, ["rev-list", "--count", `${from}..${to}`]).trim(), 10);
			commits = Number.isFinite(n) ? n : null;
		} catch {
			commits = null;
		}
	}
	let dirtyAfter: boolean | null;
	try {
		dirtyAfter = isDirty(workDir);
	} catch {
		dirtyAfter = null;
	}
	return { ok: to !== null, changed: Boolean(from && to && from !== to), branch, upstream, from, to, commits, dirty: dirtyAfter };
}
