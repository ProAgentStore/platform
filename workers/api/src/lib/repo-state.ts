// What state is the checkout actually in? (#276)
//
// Delegation leaves a repo wherever the last run stopped. Live, across two subordinates of one
// Lead: FWS parked on `fix/36-assistant-bubble-order` after a run pushed a PR and never returned
// to `main`, and FAS carrying a real uncommitted fix a run was explicitly told to leave behind ~50
// hours earlier. Neither is wrong on its own — together they show there was no notion of repo
// state BETWEEN runs. `subordinate_status` reported "Last action" (the previous objective's
// summary) and nothing about the tree, and for the question a supervisor actually asks — "can this
// agent safely take a new goal?" — the tree is the more load-bearing fact.
//
// THE POLICY THIS ENCODES: a delegated run starts from wherever the repo was left, and is TOLD
// where that is. It is deliberately not "reset to the default branch first". Git cannot distinguish
// leftover junk from a fix somebody still wants, so an automatic checkout/reset would silently
// destroy work that a previous run was INSTRUCTED to leave in the tree — a far worse bug than the
// one being fixed, and unrecoverable, whereas being on the wrong branch is visible and cheap to
// correct. So: report it everywhere, refuse nothing, discard nothing.
//
// The read is one `git status --short --branch` through the existing read-only runner endpoint
// (`/coding/git`, whitelisted argv, no shell) — the same one the repo-local connector uses. Nothing
// here can write.
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "./runner-client.js";
import { getActiveSessionForRepo, listRepos } from "./coding-store.js";
import type { CodingRepo } from "./coding-types.js";
import type { Env } from "../types.js";

/** Branches treated as the trunk when a repo has no configured branch of its own. */
const IMPLICIT_TRUNK = ["main", "master"];

export interface RepoWorkingState {
	/** The branch the checkout is on. NULL means unknown — an older runner, or not a git repo. */
	branch: string | null;
	dirty: boolean;
	changedFiles: number;
}

export interface RepoStateReport extends RepoWorkingState {
	repoId: string;
	name: string;
	/** The repo's configured branch, when it has one. Null → the trunk is assumed. */
	configuredBranch: string | null;
	/**
	 * The one sentence a supervisor should read before handing over a goal. Null when there is
	 * nothing to say — an empty note is the healthy case and must not be padded with reassurance,
	 * or the signal stops being a signal.
	 */
	note: string | null;
	/** Repos beyond the one reported. Delegation runs in the first, so that is the one probed. */
	otherRepos: number;
}

/**
 * Parse `git status --short --branch`.
 *
 * The `--branch` header is the ONLY reason the runner's status argv carries that flag: `--short`
 * alone tells you a tree is dirty but never which branch it is dirty ON, which is exactly the half
 * of #276 that let a run push to a feature branch and leave the checkout there unnoticed.
 *
 * A runner too old to send the header yields `branch: null` — "unknown", never a guess. Reporting a
 * confidently wrong branch to a supervisor is worse than reporting none, because the supervisor
 * would then act on it.
 */
export function parseGitShortStatus(output: string): RepoWorkingState {
	let branch: string | null = null;
	let changedFiles = 0;
	for (const raw of String(output ?? "").split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (!line.trim()) continue;
		if (line.startsWith("## ")) {
			branch = parseBranchHeader(line.slice(3));
			continue;
		}
		// Every other non-empty line is one path in a porcelain-v1 short status: modified, added,
		// deleted, renamed or untracked. Counting lines is what makes "3 uncommitted files" a
		// number rather than a wall of paths the model has to summarise for itself.
		changedFiles++;
	}
	return { branch, dirty: changedFiles > 0, changedFiles };
}

function parseBranchHeader(header: string): string | null {
	let h = header.trim();
	// `## HEAD (no branch)` — detached. Named honestly rather than reported as a branch called
	// "HEAD", which a supervisor would compare against `main` and describe as a feature branch.
	if (h.startsWith("HEAD (no branch)")) return "HEAD (detached)";
	// `## No commits yet on main` — a fresh repo. The branch is real; the history is not.
	if (h.startsWith("No commits yet on ")) h = h.slice("No commits yet on ".length);
	// `## main...origin/main [ahead 1]` → drop the upstream, then any ahead/behind suffix.
	const dots = h.indexOf("...");
	if (dots >= 0) h = h.slice(0, dots);
	h = h.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
	return h || null;
}

/**
 * The supervisor-facing sentence, or null when the repo is where you would expect it.
 *
 * Phrased as fact + consequence, never as a refusal: both conditions are frequently INTENDED (you
 * may well want the next goal to continue on that branch), so the model must be able to weigh them
 * rather than treat them as a block. The dirty clause states outright that nothing will discard the
 * work, because the alternative reading — "clean this up first" — is how an agent talks itself into
 * running `git checkout .`.
 */
export function describeRepoState(state: RepoWorkingState, opts: { configuredBranch?: string | null } = {}): string | null {
	const parts: string[] = [];
	const configured = (opts.configuredBranch || "").trim() || null;
	const offTrunk = state.branch
		? configured
			? state.branch !== configured
			: !IMPLICIT_TRUNK.includes(state.branch)
		: false;
	if (offTrunk) {
		parts.push(
			`on branch \`${state.branch}\`${configured ? ` rather than its configured \`${configured}\`` : " rather than the trunk"} — a new goal will run on that branch unless you say otherwise`,
		);
	}
	if (state.dirty) {
		parts.push(
			`${state.changedFiles} uncommitted file${state.changedFiles === 1 ? "" : "s"} left in the working tree by earlier work — it will NOT be discarded, and it may be a change somebody still wants`,
		);
	}
	if (!parts.length) return null;
	return `This checkout is ${parts.join("; ")}.`;
}

/**
 * Read one repo's state over the relay. Returns null when the runner cannot answer (offline, an
 * endpoint it doesn't have, no workdir it can resolve) — an absent report reads as "unknown", which
 * is true, whereas a fabricated clean/`main` would be a lie a supervisor acts on.
 */
export async function readRepoWorkingState(
	conn: RunnerConn,
	input: { repo: CodingRepo; sessionId?: string | null },
): Promise<RepoWorkingState | null> {
	// `sessionId` first: the runner resolves a tracked session's REAL workDir, which is the only
	// way to reach a managed clone dir (whose path D1 never learns). `workDir` covers a local
	// checkout with no session open. Sending both lets the runner prefer the authoritative one.
	const body = {
		sessionId: input.sessionId || undefined,
		workDir: input.repo.workdir || undefined,
		cmd: "status" as const,
	};
	if (!body.sessionId && !body.workDir) return null;
	const res = await callRunner<{ output?: string; error?: string }>(conn, "/coding/git", body, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
	if (!res || typeof res.output !== "string" || res.error) return null;
	return parseGitShortStatus(res.output);
}

/**
 * The state of the repo a delegated goal would actually run in.
 *
 * `listRepos` orders by `updated_at DESC` and the coding driver takes `repos[0]`, so that is the
 * one probed — reporting a different repo than the one delegation would use is worse than
 * reporting none. `otherRepos` says how many were not looked at, so the number is never silently
 * partial.
 */
export async function repoStateForInstance(env: Env, instanceId: string, userId: string): Promise<RepoStateReport | null> {
	const repos = await listRepos(env, instanceId, userId).catch(() => []);
	const repo = repos[0];
	if (!repo) return null;
	const conn = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
	if (!conn) return null;
	const session = await getActiveSessionForRepo(env, instanceId, userId, repo.id).catch(() => null);
	const state = await readRepoWorkingState(conn, { repo, sessionId: session?.id ?? null });
	if (!state) return null;
	return {
		...state,
		repoId: repo.id,
		name: repo.name,
		configuredBranch: (repo.branch || "").trim() || null,
		note: describeRepoState(state, { configuredBranch: repo.branch }),
		otherRepos: Math.max(0, repos.length - 1),
	};
}

/**
 * How many subordinates one `subordinate_status` call will probe for repo state.
 *
 * Each is a relay round trip on top of the connectivity probe, so this is the second unbounded
 * cost in that tool. A supervisor with more subordinates than this still gets every row — the tail
 * simply carries no `repo`, i.e. the behaviour before this existed — rather than the whole tool
 * timing out.
 */
export const MAX_REPO_PROBES = 8;

export async function repoStateForInstances(
	env: Env,
	userId: string,
	ids: readonly string[],
): Promise<Map<string, RepoStateReport>> {
	const out = new Map<string, RepoStateReport>();
	const probe = ids.slice(0, MAX_REPO_PROBES);
	const states = await Promise.all(probe.map((id) => repoStateForInstance(env, id, userId).catch(() => null)));
	for (const [i, id] of probe.entries()) {
		const s = states[i];
		if (s) out.set(id, s);
	}
	return out;
}
