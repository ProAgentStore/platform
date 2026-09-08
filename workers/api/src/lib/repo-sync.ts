/**
 * Where a checkout stands against its upstream, and what to SAY about it (#785).
 *
 * ── The incident
 *
 * Coder run 97903fb3 pushed 6da7c9a1 to `main`. A later orchestrator session read the same
 * folder through `repo_read_file`/`repo_find`/`repo_git`, found none of the shipped files — they
 * genuinely were not on disk, nothing had fetched since the push — and filed #782 against a
 * feature that existed. A full investigation cycle spent on a checkout that was one `git pull`
 * behind, and not one tool result said so.
 *
 * ── The shape of the fix
 *
 * The machine answers (`/coding/sync`, packages/browser-runner/src/coding/inspect.ts): fetch,
 * cached a minute, then count ahead/behind. This module is the cloud half — the mapping from
 * what the runner saw to what a reader is told — and it is PURE apart from `readRepoSync`, for
 * the reason `coding-workdir.ts` is: every sentence here can be asserted without a runner.
 *
 * Nothing here pulls. A pull merges into the branch the Engine may be committing on, and the
 * issue is explicit that the caller decides. What this guarantees is the narrower thing that was
 * missing: a stale read is never SILENT.
 *
 * ── Two audiences, two sentences
 *
 *   `syncReadNote`     — the tail of a read-tool result. Speaks only when there is something to
 *                        say: behind, diverged, or "could not check". In-sync and ahead are
 *                        silent, because a note on every healthy read stops being a signal.
 *   `describeRepoSync` — the Pilot's briefing at the start and end of a run. Fuller, and it does
 *                        name ahead/in-sync, because a run that ends with unpushed commits is a
 *                        fact the owner needs even though a reader does not.
 */
import { callRunner, type RunnerConn } from "./runner-client.js";

/**
 * The CLI release that first serves `/coding/sync` and honours `ref` on `/coding/git`. Named, not
 * "update the CLI" — same pattern as `REPO_SEARCH_MIN_CLI` (repo-local.ts).
 */
export const REPO_SYNC_MIN_CLI = "0.4.58";

/**
 * A fetch is a network call; the runner caps it at 20s and answers from cache for the next
 * minute. Above the runner's cap, below the relay's own read timeout, so a slow first fetch is
 * reported rather than cut off mid-answer.
 */
export const REPO_SYNC_TIMEOUT_MS = 25_000;

export type RepoSyncState = "in_sync" | "behind" | "ahead" | "diverged" | "no_upstream" | "unverified";

export interface RepoSyncVerdict {
	state: RepoSyncState;
	branch: string | null;
	upstream: string | null;
	ahead: number | null;
	behind: number | null;
	/** Short shas (8), for a sentence a human reads. Null when unknown. */
	localHead: string | null;
	remoteHead: string | null;
	/** A fetch within the runner's TTL succeeded, so the counts are current. */
	fetched: boolean;
	/** Why the latest fetch attempt failed, when it did — the counts then describe the last good fetch. */
	fetchError: string | null;
	/** One sentence, written to be RELAYED. Empty for `in_sync`. */
	detail: string;
}

/** Raw `/coding/sync` shape. Every field optional — an older runner sends `{error}` and nothing else. */
interface RawSync {
	checked?: boolean;
	branch?: string | null;
	upstream?: string | null;
	localHead?: string | null;
	remoteHead?: string | null;
	ahead?: number | null;
	behind?: number | null;
	fetched?: boolean;
	fetchedAt?: number | null;
	fetchError?: string | null;
	error?: string;
}

const short = (sha: unknown): string | null => (typeof sha === "string" && sha ? sha.slice(0, 8) : null);
const count = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Map what the runner saw onto a verdict. Pure.
 *
 * `unverified` is a first-class answer, not a failure: an older runner (no `checked`), a fetch
 * that failed on a checkout that has never fetched (no counts to fall back on), or a machine that
 * did not answer. A checkout must never be called in-sync on any of those — that would be the
 * original silence with a reassuring sentence on top.
 */
export function verdictFromSync(raw: unknown): RepoSyncVerdict {
	const r = (raw ?? {}) as RawSync;
	const base = {
		branch: typeof r.branch === "string" ? r.branch : null,
		upstream: typeof r.upstream === "string" ? r.upstream : null,
		ahead: count(r.ahead),
		behind: count(r.behind),
		localHead: short(r.localHead),
		remoteHead: short(r.remoteHead),
		fetched: r.fetched === true,
		fetchError: typeof r.fetchError === "string" && r.fetchError ? r.fetchError : null,
	};
	if (r.checked !== true) {
		return {
			...base,
			state: "unverified",
			detail: r.error
				? `Whether this checkout is up to date could not be checked: ${r.error}`
				: "Whether this checkout is up to date could not be checked on the connected machine.",
		};
	}
	if (!base.upstream) {
		return {
			...base,
			state: "no_upstream",
			detail: base.fetchError
				? `This checkout has no upstream branch to compare against, and fetching origin failed: ${base.fetchError}.`
				: "This checkout has no upstream branch to compare against, so whether it is up to date cannot be known.",
		};
	}
	if (base.ahead === null || base.behind === null) {
		return {
			...base,
			state: "unverified",
			detail: base.fetchError
				? `Whether this checkout is up to date could not be checked — fetching ${base.upstream.split("/")[0]} failed: ${base.fetchError}.`
				: `Whether this checkout is up to date could not be checked against ${base.upstream}.`,
		};
	}
	// The counts are only as fresh as the last SUCCESSFUL fetch. Said in the same sentence, so a
	// "behind 0" from a machine that has been offline for a day is not read as "up to date".
	const staleness = base.fetchError ? ` (the fetch just now failed: ${base.fetchError} — these counts are from the last successful fetch)` : base.fetched ? "" : " (counts from the last fetch, not a fresh one)";
	const heads = base.localHead && base.remoteHead ? ` — local ${base.localHead}, ${base.upstream} ${base.remoteHead}` : "";
	if (base.behind > 0 && base.ahead > 0) {
		return {
			...base,
			state: "diverged",
			detail: `This checkout has DIVERGED from ${base.upstream}: ${plural(base.ahead, "local commit")} not on it, and it is ${plural(base.behind, "commit")} behind it${heads}${staleness}. Changes pushed to ${base.upstream} since are NOT on disk here.`,
		};
	}
	if (base.behind > 0) {
		return {
			...base,
			state: "behind",
			detail: `This checkout is ${plural(base.behind, "commit")} BEHIND ${base.upstream}${heads}${staleness}. Changes pushed to ${base.upstream} since are NOT on disk here, so what is read from this folder may be stale.`,
		};
	}
	if (base.ahead > 0) {
		return {
			...base,
			state: "ahead",
			detail: `This checkout is ${plural(base.ahead, "commit")} ahead of ${base.upstream}${heads}${staleness} — local work that has not been pushed.`,
		};
	}
	return { ...base, state: "in_sync", detail: base.fetchError ? `This checkout matched ${base.upstream} at the last successful fetch${staleness}.` : "" };
}

/**
 * The tail a READ tool appends (#785, ask 1). Null when there is nothing worth interrupting a
 * read for: in sync, ahead (unpushed local work does not make a read stale), no upstream, or a
 * runner too old to answer at all.
 *
 * A fetch FAILURE speaks, because "I could not check" is exactly the fact the incident lacked —
 * but only when the counts could not be salvaged from the last good fetch, since in that case
 * the `behind`/`diverged` sentence already carries the failure.
 */
export function syncReadNote(v: RepoSyncVerdict): string | null {
	if (v.state === "behind" || v.state === "diverged") {
		return `(STALE CHECKOUT: ${v.detail} Nothing was pulled automatically — say so if it affects your answer, and a \`git pull\` on that machine brings it up to date.)`;
	}
	if (v.state === "unverified" && v.fetchError) {
		return `(SYNC UNVERIFIED: ${v.detail} What you read may be behind ${v.upstream ?? "the remote"} without this tool being able to tell.)`;
	}
	return null;
}

/**
 * The Pilot's briefing line. Null only when in sync with a fresh fetch — every other state is a
 * fact a run should start or end knowing.
 */
export function describeRepoSync(v: RepoSyncVerdict): string | null {
	if (v.state === "in_sync" && !v.fetchError) return null;
	return v.detail;
}

/**
 * The upstream line `repo_git status` ALWAYS carries in its head (#785).
 *
 * Unlike the read-tool tail, this speaks when in sync too: "status" is the one call whose whole
 * job is to describe the repo's state, and an in-sync checkout is part of that state. Silent only
 * for a runner too old to answer at all, where a sentence would claim knowledge nobody has.
 */
export function statusSyncLine(v: RepoSyncVerdict): string {
	if (v.state === "in_sync" && !v.fetchError) return `(upstream: in sync with ${v.upstream}${v.fetched ? "" : ", as of the last fetch"})`;
	if (v.state === "unverified" && !v.fetchError) return "";
	return `(upstream: ${v.detail})`;
}

/**
 * Is what a read tool is about to read CURRENT (#785)?
 *
 * Every repo-local read tool asks this BEFORE the read it accompanies and awaits the answer
 * after, so the two relay calls overlap: the runner answers from a one-minute fetch cache, so on
 * the eighteen-call turns #508 measured this is one network fetch and seventeen cache hits, not
 * eighteen fetches.
 *
 * Never throws and never blocks a read — an unreachable or old runner is "unverified", and an
 * unverified read with no fetch error to name is served as it always was.
 */
export function syncVerdictFor(t: { conn: RunnerConn; workDir: string }): Promise<RepoSyncVerdict> {
	return readRepoSync(t.conn, { workDir: t.workDir });
}

/** Join a tool's own tail with the sync note, either of which may be empty. */
export async function syncTailFor(sync: Promise<RepoSyncVerdict>, tail?: string): Promise<string> {
	const note = syncReadNote(await sync);
	return [tail?.trim(), note].filter(Boolean).join("\n\n");
}

/**
 * Ask the machine. Never throws — an unreachable or old runner is `unverified`, which is a fact
 * about the connection, not about the checkout.
 *
 * `sessionId` first, for the reason `readRepoWorkingState` sends it: the runner resolves a
 * tracked session's REAL workDir, which is the only way to reach a managed clone dir whose path
 * D1 never learns. `branch` is the repo's CONFIGURED branch, so a detached HEAD is still compared
 * against the branch the run is supposed to be on.
 */
export async function readRepoSync(
	conn: RunnerConn,
	input: { workDir?: string | null; sessionId?: string | null; branch?: string | null; forceFetch?: boolean },
): Promise<RepoSyncVerdict> {
	const body = {
		sessionId: input.sessionId || undefined,
		workDir: input.workDir || undefined,
		branch: input.branch || undefined,
		forceFetch: input.forceFetch || undefined,
	};
	if (!body.sessionId && !body.workDir) return verdictFromSync({ error: "no session or workDir to check" });
	let raw: RawSync;
	try {
		raw = await callRunner<RawSync>(conn, "/coding/sync", body, { timeoutMs: REPO_SYNC_TIMEOUT_MS });
	} catch (e) {
		raw = { error: e instanceof Error ? e.message : String(e) };
	}
	return verdictFromSync(raw);
}
