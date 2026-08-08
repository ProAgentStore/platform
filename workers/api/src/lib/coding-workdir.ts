/**
 * Is a local checkout actually there? (#405)
 *
 * A local repo used to become `clone_status = "ready"` the instant someone typed a path —
 * `ready` being the same word a successfully cloned repo gets — with nothing on either side of
 * the wire having looked at it. On the machine, `~/dev/pas/platform/apps/chess-academy` was an
 * empty directory that was not a git repo, created the minute the row was, and it stayed `ready`
 * for two days.
 *
 * Downstream, every read tool reported that absence as a SUCCESS: `repo_tree` answered
 * "(no files found at that path)" and `repo_remote` answered "(no git origin remote)". Both
 * sentences are TRUE of an empty subfolder of a healthy checkout, and neither says the configured
 * workdir is gone. The agent, asked about the code and handed two non-answers describing no
 * problem, had no diagnosis to relay — so it invented the repository, the issues and the file
 * contents (#395, whose guard catches that but cannot remove the reason for it).
 *
 * This module is the missing question, asked in one place and phrased once:
 *
 *   - `verdictFromCheck` is PURE — the whole mapping from what the runner saw to what the owner
 *     is told, unit-testable without a runner or a filesystem.
 *   - `checkWorkdirVia` is the one call site that reaches a machine.
 *
 * ── The distinction that must not collapse, in EITHER direction
 *
 * An empty SUBFOLDER of a real checkout is not a problem, and must keep answering
 * "(no files found at that path)" as a success. A configured WORKDIR that is empty is the whole
 * defect. The two look identical to `repo_tree` — same empty entry list — and are told apart only
 * by asking about the workdir ROOT, which is why every caller here passes the root and never the
 * tool's `path` argument.
 */
import { callRunner, type RunnerConn } from "./runner-client.js";
import type { CloneStatus } from "./coding-types.js";

/**
 * What is at the configured workdir.
 *
 * `unverified` is a first-class answer, not a failure: no runner is connected, the machine is
 * running a CLI that predates `/coding/repo-check`, or the call timed out. A repo must never be
 * condemned on it — an unreachable machine says nothing about the path on it.
 */
export type WorkdirState = "ok" | "missing" | "not_a_directory" | "empty" | "not_a_git_repo" | "unverified";

export interface WorkdirVerdict {
	state: WorkdirState;
	/** The path as configured (or as the runner resolved it) — every message names it. */
	path: string;
	/**
	 * One sentence, written to be RELAYED: an agent can say it to the owner verbatim and it is
	 * both true and actionable. Empty for `ok`.
	 */
	detail: string;
}

/** Raw `/coding/repo-check` shape. Every field optional — an older runner sends none of them. */
interface RawCheck {
	checked?: boolean;
	path?: string;
	exists?: boolean;
	isDirectory?: boolean;
	entryCount?: number;
	insideWorkTree?: boolean;
	gitChecked?: boolean;
	error?: string;
}

/**
 * Map what the runner saw onto what the owner is told. Pure.
 *
 * Order is the specification, cheapest and most certain first: a path that is not there cannot
 * also be "not a checkout", and saying so would send the owner looking for a `.git` in a folder
 * that does not exist.
 */
export function verdictFromCheck(workDir: string, raw: unknown): WorkdirVerdict {
	const r = (raw ?? {}) as RawCheck;
	// The version marker. An older runner answers `{error:"Not found"}` through the relay, and a
	// CLI skew must read as "unverified" — never as "this repo is broken", which would condemn
	// every healthy repo on the machine the moment someone upgraded the API before the CLI.
	if (r.checked !== true) {
		return {
			state: "unverified",
			path: workDir,
			detail: r.error
				? `The checkout could not be verified on the connected machine: ${r.error}`
				: "The checkout could not be verified on the connected machine.",
		};
	}
	const path = r.path || workDir;
	if (!r.exists) {
		return {
			state: "missing",
			path,
			detail: `The configured checkout \`${path}\` does not exist on the connected machine — it may have been moved, renamed or deleted.`,
		};
	}
	if (!r.isDirectory) {
		return { state: "not_a_directory", path, detail: `\`${path}\` is a file, not a directory — it cannot be a checkout.` };
	}
	if (!r.entryCount) {
		return {
			state: "empty",
			path,
			detail: `The configured checkout \`${path}\` exists but is EMPTY — nothing was ever cloned into it, or its contents were moved away. There is no code at that path to read.`,
		};
	}
	// `gitChecked:false` means git is not on that machine's PATH, so "not a work tree" is the
	// answer to a question that was never asked. A folder full of files is left usable.
	if (r.gitChecked !== false && !r.insideWorkTree) {
		return {
			state: "not_a_git_repo",
			path,
			detail: `The configured checkout \`${path}\` has files but is not inside a git working tree — it is a plain folder, not a clone of a repository.`,
		};
	}
	return { state: "ok", path, detail: "" };
}

/** Did the machine give a definite verdict that this path is unusable? */
export function isWorkdirBroken(v: WorkdirVerdict): boolean {
	return v.state !== "ok" && v.state !== "unverified";
}

/**
 * The `clone_status` a verdict justifies, or `null` when it justifies no change.
 *
 * `unknown` for an unverified path is the point of the ticket in one word: it is NOT `ready`.
 * `ready` is a claim, and the platform may only make it about a path it has looked at.
 */
export function cloneStatusForVerdict(v: WorkdirVerdict): CloneStatus | null {
	if (v.state === "ok") return "ready";
	if (v.state === "unverified") return null;
	return "needs_attention";
}

/** Read-type call: a wedged runner must not hold a repo list open for the full read timeout. */
export const WORKDIR_CHECK_TIMEOUT_MS = 5_000;

/**
 * Ask the machine that will use this path what is at it. Never throws — an unreachable or old
 * runner is `unverified`, which is a fact about the connection, not about the checkout.
 */
export async function checkWorkdirVia(conn: RunnerConn, workDir: string): Promise<WorkdirVerdict> {
	const raw = await callRunner<RawCheck>(conn, "/coding/repo-check", { workDir }, { timeoutMs: WORKDIR_CHECK_TIMEOUT_MS }).catch(
		(e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }) as RawCheck,
	);
	return verdictFromCheck(workDir, raw);
}
