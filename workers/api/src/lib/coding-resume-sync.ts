/**
 * Before a parked run is given its owner's answer, bring its checkout onto the current upstream
 * (#1078, #1072 §D).
 *
 * The start-of-run sync (`repo-state-start` → `repo-self-heal` → `repo-sync-gate` in
 * `workflow-run.ts`) is the only place a base was checked, and a run parked for hours or days on a
 * question (#1076) resumed on whatever `main` was when it asked. So the resume runs the SAME three
 * steps — no second implementation: `readRepoSync` (fetch, then judge), `attemptSyncSelfHeal` (the
 * runner's guarded `pull --ff-only`, which never stashes, cleans or commits) and `gateRunOnSync`
 * (the verdict, and the operator's record). It runs on the clean checkout #1077 left — before the
 * set-aside work is put back — and after the engine is relaunched, so the runner can resolve a
 * managed clone through the session.
 *
 * A base that moved is not a reason to stop: the run continues on the new `main`, and the answer
 * turn carries what moved — the owner answered against the state they saw, and the engine planned
 * against it. A base that cannot be confirmed, or has diverged, stops the run before the answer is
 * applied, naming the commits and the files that moved; nothing is merged, rebased or discarded.
 */
import type { Env } from "../types.js";
import { getRepo } from "./coding-store.js";
import { readRepoSync, type RepoSyncVerdict } from "./repo-sync.js";
import { readRepoWorkingState } from "./repo-state.js";
import { attemptSyncSelfHealWithStash, readAutoStashPolicy } from "./checkout-actions.js";
import { describeSyncHeal, gateRunOnSync, readWorkingStateWithRetry, skippedSyncHeal, syncSelfHealEligible, type SyncHealOutcome } from "./repo-sync-gate.js";
import { callRunner, type RunnerConn } from "./runner-client.js";

/** How many changed files a note names before it says how many more there are. */
export const MOVED_FILES_SHOWN = 10;

/** The file paths a `git diff --stat` over `range` lists, read through the runner's read-only `diff-stat`. */
async function filesIn(conn: RunnerConn, input: { sessionId: string; workDir?: string | null; range: string }): Promise<string[]> {
	const out = await callRunner<{ output?: string }>(conn, "/coding/git", { sessionId: input.sessionId, workDir: input.workDir || undefined, cmd: "diff-stat", ref: input.range }).catch(() => null);
	return (out?.output ?? "")
		.split("\n")
		.map((l) => l.match(/^\s*(.+?)\s+\|\s/)?.[1]?.trim())
		.filter((p): p is string => !!p);
}

/** "a.ts, b.ts and 3 more" — every cut said out loud. Pure. */
export function nameFiles(files: string[]): string {
	if (!files.length) return "no file list was available";
	const shown = files.filter((_, i) => i < MOVED_FILES_SHOWN).map((f) => `\`${f}\``);
	const more = files.length - shown.length;
	return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** The note the answer turn carries when `main` moved while the run was parked. Pure. */
export function movedNote(heal: SyncHealOutcome, files: string[]): string {
	const n = heal.commits !== null ? `${heal.commits} commit${heal.commits === 1 ? "" : "s"}` : "new commits";
	const shas = heal.from && heal.to ? ` (${heal.from} → ${heal.to})` : "";
	return `While you were parked waiting for the owner's answer, \`${heal.branch}\` moved: ${n}${shas}, touching ${nameFiles(files)}. The checkout was fast-forwarded before this turn and your earlier work is back on top of it. Re-read any of those files you had touched before acting on the answer — the answer was given against the state before these commits.`;
}

export type ResumeSync = { ok: true; moved: string | null; heal: SyncHealOutcome | null } | { blocked: string };

/** Fetch, fast-forward when it is safe, and decide — for a resume, before the answer is applied. */
export async function resyncBeforeAnswer(env: Env, conn: RunnerConn, input: { instanceId: string; userId: string; sessionId: string; repoId: string }): Promise<ResumeSync> {
	const repo = await getRepo(env, input.instanceId, input.userId, input.repoId).catch(() => null);
	if (!repo) return { ok: true, moved: null, heal: null };
	const [read, sync] = await Promise.all([
		// Retried once, error kept; an unreadable tree does not veto the fast-forward (#1319).
		readWorkingStateWithRetry((onError) => readRepoWorkingState(conn, { repo, sessionId: input.sessionId, onError })),
		readRepoSync(conn, { workDir: repo.workdir, sessionId: input.sessionId, branch: repo.branch, forceFetch: true }).catch(() => null as RepoSyncVerdict | null),
	]);
	const eligible = syncSelfHealEligible(sync, read.state, repo.branch ?? null);
	const attempted = eligible.eligible && eligible.branch ? await attemptSyncSelfHealWithStash(conn, { repo, sessionId: input.sessionId, branch: eligible.branch, runLabel: `resume ${input.sessionId}`, approved: await readAutoStashPolicy(env, input.instanceId, input.userId) }) : skippedSyncHeal(eligible);
	const heal = attempted && read.error ? { ...attempted, stateReadError: read.error } : attempted;
	const after = heal?.sync ?? sync;
	const gate = await gateRunOnSync(env, { instanceId: input.instanceId, userId: input.userId, sessionId: input.sessionId, node: conn.runnerNode ?? null, repo: repo.name, heal }, after);
	if (gate.blocked) {
		// What upstream brought in since the run's base — the files the owner must reconcile.
		const incoming = await filesIn(conn, { sessionId: input.sessionId, workDir: repo.workdir, range: "HEAD...@{u}" });
		const healed = heal && heal.status !== "healed" && heal.status !== "noop" ? ` ${describeSyncHeal(heal)}` : "";
		return {
			blocked: `Before applying your answer the run re-checked its base and could not bring it onto the current upstream: ${gate.decision.detail}${healed} Upstream changed ${nameFiles(incoming)}. Nothing was merged, rebased or discarded. ${gate.decision.remedy}`.trim(),
		};
	}
	if (heal?.status === "healed" && heal.from && heal.to) {
		const files = await filesIn(conn, { sessionId: input.sessionId, workDir: repo.workdir, range: `${heal.from}..${heal.to}` });
		return { ok: true, moved: movedNote(heal, files), heal };
	}
	return { ok: true, moved: null, heal };
}
