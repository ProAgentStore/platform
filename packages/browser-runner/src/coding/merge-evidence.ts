/**
 * Structured evidence for a SYNCHRONOUS pull-request merge (#1350, contract `merge.v === 1`).
 *
 * A direct push proves its own range: `git push` prints `old..new`. `gh pr merge` prints neither SHA, and
 * `gh pr merge --auto` returns while the merge is only scheduled, so the command succeeding proves nothing
 * about what reached the default branch. After the command's own result arrives, the runner therefore asks
 * GitHub (through the same `gh` and credentials the engine just used) what that merge did, and attaches the
 * answer to the act:
 *
 *   { v: 1, repo, pr, baseRef, method, beforeSha, afterSha, mergedAt, mergedBy, actor }
 *
 * `beforeSha` is read from the merge RESULT, not observed beforehand. For a merge commit or a squash it is the first
 * parent of the result: the exact tip of the base branch at the moment GitHub performed this merge, atomic, so there is
 * no window between "the SHA we observed" and "the merge" for another update to slip into. A rebase writes the PR's N
 * commits one after another, so there it is the parent of the first of those N (one `commits?sha=<result>` read, each
 * linked to the next). `afterSha` is GitHub's `merge_commit_sha` for the PR. Neither is ever read from what the
 * branch head happens to be later.
 *
 * Anything short of that is recorded as `mergeUnverified` with a code, never as a guess:
 *   auto                  the command asked for `--auto` / the merge queue: only a request, not a merge
 *   scheduled             the output says the merge is scheduled or queued
 *   unrecognized_output   the output does not say the PR was merged
 *   not_merged            GitHub says the PR is not merged
 *   wrong_branch          merged into something other than the repository's default branch
 *   method_unknown        no --merge/--squash/--rebase to read the method from
 *   method_mismatch       the merge result's shape is not what that method produces
 *   actor_mismatch        merged_by is not the account that ran the command, or merged outside this act's window
 *   unreadable            a GitHub read failed or returned something unusable
 * The cloud re-verifies every field against GitHub itself and never trusts these as proof: this is the claim
 * the cloud checks, not the check.
 */
import type { EngineActRecord } from "./engine-acts.js";

export const MERGE_CONTRACT_VERSION = 1;

export type MergeMethod = "merge" | "squash" | "rebase";

export interface MergeEvidence {
	v: 1;
	repo: string;
	pr: number;
	baseRef: string;
	method: MergeMethod;
	beforeSha: string;
	afterSha: string;
	mergedAt: string;
	mergedBy: string;
	actor: string;
}

export type MergeUnverified = "auto" | "scheduled" | "unrecognized_output" | "not_merged" | "wrong_branch" | "method_unknown" | "method_mismatch" | "actor_mismatch" | "unreadable";

/** Run `gh <args>` where the engine ran, with its credentials. Resolves rather than throws; code -1 is "could not run". */
export type GhRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;

/** What the command line asked for. */
export interface MergeCommand {
	pr: number | null;
	repo: string | null;
	method: MergeMethod | null;
	auto: boolean;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
/** The window around the act within which a merge counts as this act's: GitHub and runner clocks differ a little. */
const SKEW_MS = 2 * 60_000;
const AFTER_MS = 10 * 60_000;
/** A rebase is mapped by reading back this many commits at most (one request); a longer PR is unverified, not guessed. */
const REBASE_COMMITS_MAX = 100;

/** The `gh pr merge …` segment of a (possibly compound) command, read for what it asked. Null when there is none. */
export function parseMergeCommand(command: string): MergeCommand | null {
	const seg = command.split(/&&|\|\||;|\n/).find((s) => /\bgh\s+pr\s+merge\b/.test(s));
	if (!seg) return null;
	const words = seg.trim().split(/\s+/);
	const at = words.findIndex((w, i) => w === "merge" && words[i - 1] === "pr");
	const args = words.slice(at + 1);
	let pr: number | null = null;
	let repo: string | null = null;
	let method: MergeMethod | null = null;
	let auto = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--auto" || a === "--merge-queue") auto = true;
		else if (a === "--squash" || a === "-s") method = "squash";
		else if (a === "--rebase" || a === "-r") method = "rebase";
		else if (a === "--merge" || a === "-m") method = "merge";
		else if ((a === "--repo" || a === "-R") && args[i + 1]) repo = args[++i].replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
		else if (a.startsWith("--repo=")) repo = a.slice(7);
		else if (/^https?:\/\/\S+\/pull\/\d+/.test(a)) {
			const m = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(a);
			if (m) { repo ??= m[1]; pr = Number(m[2]); }
		} else if (/^\d+$/.test(a)) pr = Number(a);
	}
	return { pr, repo, method, auto };
}

const SCHEDULED = /\bwill be (?:automatically )?merged\b|auto-?merge\b.*\benabled\b|\bmerge queue\b|\bqueued\b|\bscheduled\b/i;
const MERGED = /\bmerged\b/i;

const parse = (stdout: string): Record<string, unknown> | null => {
	try {
		const v = JSON.parse(stdout) as unknown;
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
};
const parseList = (stdout: string): Array<Record<string, unknown>> | null => {
	try {
		const v = JSON.parse(stdout) as unknown;
		return Array.isArray(v) && v.every((e) => e && typeof e === "object") ? (v as Array<Record<string, unknown>>) : null;
	} catch {
		return null;
	}
};
const str = (o: Record<string, unknown> | null | undefined, k: string) => (typeof o?.[k] === "string" ? (o[k] as string) : "");
const obj = (o: Record<string, unknown> | null | undefined, k: string) => (o?.[k] && typeof o[k] === "object" ? (o[k] as Record<string, unknown>) : null);

/**
 * Ask GitHub what a successful, non-`--auto` `gh pr merge` did. Never throws.
 * `now` is when the lookup runs, used only to bound how late the merge may have happened.
 */
export async function collectMergeEvidence(gh: GhRunner, act: Pick<EngineActRecord, "command" | "target" | "at">, result: string, now = Date.now()): Promise<{ merge: MergeEvidence } | { unverified: MergeUnverified; detail: string }> {
	const no = (unverified: MergeUnverified, detail: string) => ({ unverified, detail });
	const cmd = parseMergeCommand(act.command);
	if (!cmd) return no("unreadable", "the merge command could not be read");
	if (cmd.auto) return no("auto", "--auto (or the merge queue) only schedules a merge");
	if (SCHEDULED.test(result)) return no("scheduled", "the output says the merge is scheduled, not done");
	if (!MERGED.test(result)) return no("unrecognized_output", "the output does not say the pull request was merged");
	if (!cmd.method) return no("method_unknown", "no --merge, --squash or --rebase says how it was merged");
	const prNumber = cmd.pr ?? (act.target && /^#\d+$/.test(act.target) ? Number(act.target.slice(1)) : null);
	if (!prNumber) return no("unreadable", "the pull request number is unknown");

	let repo = cmd.repo;
	if (!repo) {
		const view = await gh(["repo", "view", "--json", "nameWithOwner"]);
		repo = view.code === 0 ? str(parse(view.stdout), "nameWithOwner") : "";
	}
	if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return no("unreadable", "the repository could not be determined");

	const [pullRaw, repoRaw, userRaw] = await Promise.all([gh(["api", `repos/${repo}/pulls/${prNumber}`]), gh(["api", `repos/${repo}`]), gh(["api", "user"])]);
	const pull = pullRaw.code === 0 ? parse(pullRaw.stdout) : null;
	const repoInfo = repoRaw.code === 0 ? parse(repoRaw.stdout) : null;
	const user = userRaw.code === 0 ? parse(userRaw.stdout) : null;
	if (!pull || !repoInfo || !user) return no("unreadable", "GitHub could not be read for the pull request, repository or account");
	if (pull.merged !== true || !str(pull, "merged_at")) return no("not_merged", "GitHub says the pull request is not merged");
	const baseRef = str(obj(pull, "base"), "ref");
	const baseRepo = str(obj(obj(pull, "base"), "repo"), "full_name");
	if (!baseRef || baseRepo.toLowerCase() !== repo.toLowerCase() || baseRef !== str(repoInfo, "default_branch")) return no("wrong_branch", `merged into ${baseRepo || "?"}:${baseRef || "?"}, not this repository's default branch`);
	const afterSha = str(pull, "merge_commit_sha").toLowerCase();
	if (!FULL_SHA.test(afterSha)) return no("unreadable", "GitHub reported no merge commit for the pull request");
	const mergedBy = str(obj(pull, "merged_by"), "login");
	const actor = str(user, "login");
	const mergedAt = str(pull, "merged_at");
	const mergedMs = Date.parse(mergedAt);
	const actMs = Date.parse(act.at);
	if (!mergedBy || !actor || mergedBy.toLowerCase() !== actor.toLowerCase() || !Number.isFinite(mergedMs) || (Number.isFinite(actMs) && (mergedMs < actMs - SKEW_MS || mergedMs > now + SKEW_MS || mergedMs > actMs + AFTER_MS))) {
		return no("actor_mismatch", "the pull request was not merged by this account during this command");
	}

	const commitRaw = await gh(["api", `repos/${repo}/commits/${afterSha}`]);
	const commit = commitRaw.code === 0 ? parse(commitRaw.stdout) : null;
	const parents = Array.isArray(commit?.parents) ? (commit?.parents as Array<{ sha?: unknown }>).map((p) => (typeof p?.sha === "string" ? p.sha.toLowerCase() : "")) : [];
	if (!commit || str(commit, "sha").toLowerCase() !== afterSha || !parents.length || parents.some((p) => !FULL_SHA.test(p))) return no("unreadable", "the merge commit and its parents could not be read");
	// merge → a merge commit (two parents); squash and rebase → one commit on top of the branch (one parent).
	if ((cmd.method === "merge" && parents.length !== 2) || (cmd.method !== "merge" && parents.length !== 1)) return no("method_mismatch", `a ${cmd.method} merge does not produce a commit with ${parents.length} parent(s)`);

	let beforeSha = parents[0];
	if (cmd.method === "rebase") {
		const n = pull.commits;
		if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) >= REBASE_COMMITS_MAX) return no("method_mismatch", "a rebase of this many commits cannot be mapped exactly");
		const listRaw = await gh(["api", `repos/${repo}/commits?sha=${afterSha}&per_page=${(n as number) + 1}`]);
		const list = listRaw.code === 0 ? parseList(listRaw.stdout) : null;
		if (!list) return no("unreadable", "the rebased commits could not be read back");
		const chain = list.map((e) => ({ sha: str(e, "sha").toLowerCase(), parents: Array.isArray(e.parents) ? (e.parents as Array<{ sha?: unknown }>).map((p) => (typeof p?.sha === "string" ? p.sha.toLowerCase() : "")) : [] }));
		// The N rebased commits, newest first, each on top of the next, and the one under them is the prior tip.
		const ok = chain.length === (n as number) + 1 && chain[0].sha === afterSha && chain.slice(0, n as number).every((e, i) => e.parents.length === 1 && e.parents[0] === chain[i + 1].sha && FULL_SHA.test(e.parents[0]));
		if (!ok) return no("method_mismatch", "the rebased commits are not one line on top of the prior branch tip");
		beforeSha = chain[n as number].sha;
	}
	return { merge: { v: MERGE_CONTRACT_VERSION, repo, pr: prNumber, baseRef, method: cmd.method, beforeSha, afterSha, mergedAt, mergedBy, actor } };
}

/**
 * The act as it is published once its result is in. A successful `gh pr merge` gets `merge` (verified claim) or
 * `mergeUnverified` + `mergeDetail`; every other act passes through untouched.
 */
export async function withMergeEvidence(act: EngineActRecord, result: string, gh: GhRunner, now = Date.now()): Promise<EngineActRecord> {
	if (act.kind !== "pr.merge" || act.ok !== true) return act;
	try {
		const found = await collectMergeEvidence(gh, act, result, now);
		return "merge" in found ? { ...act, merge: found.merge } : { ...act, mergeUnverified: found.unverified, mergeDetail: found.detail };
	} catch {
		return { ...act, mergeUnverified: "unreadable", mergeDetail: "the merge lookup failed" };
	}
}

/**
 * Start the GitHub lookups for the completed merges among `acts` and publish each act when its answer is in (`publish`
 * is called exactly once per act, with the evidence or the reason it has none). Returns false, publishing nothing, when
 * no act needs a lookup, so the caller publishes them as before. `pending` holds the in-flight lookups.
 */
export function trackMergeLookups(acts: EngineActRecord[], result: string, gh: () => GhRunner, publish: (act: EngineActRecord) => void, pending: Set<Promise<void>>): boolean {
	if (!acts.some((a) => a.kind === "pr.merge" && a.ok === true)) return false;
	const run = gh();
	const job: Promise<void> = (async () => {
		for (const a of acts) publish(await withMergeEvidence(a, result, run));
	})()
		.catch(() => {
			for (const a of acts) publish(a);
		})
		.finally(() => void pending.delete(job));
	pending.add(job);
	return true;
}

/** Wait for the lookups in `pending`, but never longer than `timeoutMs`: a stuck `gh` must not hold a run's end. */
export async function settleMergeLookups(pending: Set<Promise<void>>, timeoutMs = 25_000): Promise<void> {
	if (!pending.size) return;
	await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs))]);
}
