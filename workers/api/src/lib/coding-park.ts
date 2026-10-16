/**
 * A coding run parked on a QUESTION, at zero compute (#1076).
 *
 * The park used to be a live Workflow polling: a durable `step.sleep` every five seconds and a runner
 * call each time, for fifteen minutes, after which the run STOPPED and a later answer had nothing to
 * resume (`lib/coding-wait.ts` named the missing piece: "a resumption scheduler that does not exist").
 * Now the run records its park and waits on `step.waitForEvent` — no step runs, nothing is polled,
 * and Cloudflare does not count a waiting instance against concurrency. Whatever should make it look
 * again sends it an event:
 *
 *   * an answer (`POST /input`, MCP `answer_instance_input`, the takeover route — after #1075 wrote it)
 *   * the coder brain's decision or its unresolved instruction (the minute sweep)
 *   * a cancel (`requestCancel`, so `stop_work` reaches a parked run — the lesson of #790)
 *   * this module's backstop, for any of those whose event was lost
 *
 * The event carries nothing the run trusts. Woken, the run re-reads D1 — the answer from its question
 * row (#1075), the cancel from its run row — so a duplicate or stale event is a look that finds
 * nothing, never a wrong resume. The event TYPE names the question, so an event buffered for one
 * question can never satisfy the wait for the next one.
 *
 * Why an event and not ending the instance plus a continuation: measured and recorded on #1076.
 */
import type { Env } from "../types.js";
import { RESUME_WINDOW_MS, describeAge } from "./coding-session-continuity.js";
import { startSessionOnRunnerConn, type RelaunchInput } from "./coding-session-relaunch.js";
import { seedBriefForRepo } from "./coding-seed-brief.js";
import { claimSessionDriver, getRepo } from "./coding-store.js";
import { repoFreeForRun, runnerEngineProbe } from "./coding-ownership.js";
import { callRunner, type RunnerConn } from "./runner-client.js";
import { resyncBeforeAnswer } from "./coding-resume-sync.js";

/**
 * How long a parked question waits before the run stops (`decision`, which is continuable). Thirty
 * days: far past any real gap inside one piece of work, well inside `waitForEvent`'s 365-day ceiling.
 */
export const DECISION_PARK_MS = 30 * 24 * 60 * 60_000;

/** Times one park may be woken without finding anything to act on before it stops looking (a bound, not an expectation). */
export const MAX_PARK_WAKES = 50;

/** How long an unapplied answer may sit before the backstop re-sends its event: the live path gets the first minute. */
export const PARK_WAKE_BACKSTOP_MS = 60_000;

/** The event a park on this question waits for. Cloudflare allows `[A-Za-z0-9_-]`, at most 100 characters: a question id is a uuid, so it fits whole. */
export function answerEventType(questionId: string): string {
	return `answer-${questionId}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Written by the park: the instance to send this run's events to. */
export async function recordParkedWorkflow(env: Pick<Env, "DB">, runId: string, workflowInstanceId: string): Promise<void> {
	await env.DB.prepare("UPDATE agent_loop_runs SET workflow_instance_id = ?2 WHERE run_id = ?1").bind(runId, workflowInstanceId).run();
}

/**
 * Wake a run parked on a question so it re-reads its answer (or its cancel) from D1. False when the
 * run is not parked on a question, or the event could not be sent — never throws: every caller has
 * already written the durable fact, and the minute backstop covers a send that failed.
 */
export async function wakeParkedRun(env: Pick<Env, "DB" | "CODING_SESSION">, runId: string, why: "answer" | "cancel" | "backstop" | "checkout"): Promise<boolean> {
	try {
		const row = await env.DB.prepare(
			`SELECT r.workflow_instance_id AS wf, q.id AS qid FROM agent_loop_runs r JOIN coder_questions q ON q.run_id = r.run_id
			  WHERE r.run_id = ?1 AND r.status = 'running' AND r.waiting_reason = 'decision' AND r.workflow_instance_id IS NOT NULL
			  ORDER BY q.asked_at DESC, q.rowid DESC LIMIT 1`,
		)
			.bind(runId)
			.first<{ wf: string; qid: string }>();
		if (!row) return false;
		const instance = await env.CODING_SESSION.get(row.wf);
		await instance.sendEvent({ type: answerEventType(row.qid), payload: { why } });
		return true;
	} catch {
		return false;
	}
}

/**
 * The backstop (one more pass on the every-minute tick): re-send the event for every parked run that
 * has something to act on and has not acted — an answer no run has applied yet, an unresolved
 * instruction, or a cancel — older than {@link PARK_WAKE_BACKSTOP_MS}. A run that already woke has
 * applied its answer, so it is not selected again; one that is gone stays selected until the run
 * sweeper closes it at its published deadline.
 */
export async function runDueParkWakes(env: Pick<Env, "DB" | "CODING_SESSION">, now = Date.now()): Promise<number> {
	const due = now - PARK_WAKE_BACKSTOP_MS;
	const { results } = await env.DB.prepare(
		`SELECT DISTINCT r.run_id FROM agent_loop_runs r JOIN coder_questions q ON q.run_id = r.run_id
		  WHERE r.status = 'running' AND r.waiting_reason = 'decision' AND r.workflow_instance_id IS NOT NULL
		    AND ((r.cancel_requested = 1 AND COALESCE(r.cancel_requested_at, 0) < ?1)
		      OR (q.applied_at IS NULL AND ((q.answered_at IS NOT NULL AND q.answered_at < ?1) OR (q.state = 'unresolved' AND q.resolved_at < ?1))))
		    -- #1077: a run that released its checkout is not re-woken while something else holds that
		    -- repo (a run, or an open session) — it could only find it busy again. The holder's end wakes it.
		    AND NOT (r.checkout_released_at IS NOT NULL AND r.cancel_requested = 0 AND EXISTS (
		          SELECT 1 FROM coding_sessions mine JOIN coding_sessions other ON other.repo_id = mine.repo_id AND other.instance_id = mine.instance_id AND other.id <> mine.id
		           WHERE mine.id = r.session_id
		             AND (other.status = 'active' OR EXISTS (SELECT 1 FROM agent_loop_runs o WHERE o.session_id = other.id AND o.status = 'running' AND o.checkout_released_at IS NULL))))
		  LIMIT 25`,
	)
		.bind(due)
		.all<{ run_id: string }>();
	let woken = 0;
	for (const r of results ?? []) if (await wakeParkedRun(env, r.run_id, "backstop")) woken++;
	return woken;
}

/**
 * Bring the engine back for a run resumed from a park (#1076). The park stopped the engine PROCESS;
 * the session row and the machine's resume key stayed. So within {@link RESUME_WINDOW_MS} a Claude
 * engine relaunched on the same session id adopts its own key and continues its conversation
 * (`--resume`). Past the window, or for an engine with no conversation to continue, it starts fresh
 * with the repo's seed brief. `resumed` is the MACHINE's answer, so the line said to the owner is what
 * happened, not what was asked for. The driver claim, unrefreshed while parked, is taken back first.
 */
export async function relaunchAfterPark(
	env: Env,
	conn: RunnerConn,
	input: RelaunchInput & { clientType?: string; repoName: string; driverId?: string; parkedForMs: number },
): Promise<{ resumed: boolean; line: string }> {
	if (input.driverId) await claimSessionDriver(env, input.instanceId, input.userId, input.sessionId, input.driverId).catch(() => false);
	const engine = input.clientType ?? "claude";
	const why = engine !== "claude" ? `the ${engine} engine has no conversation to continue` : input.parkedForMs > RESUME_WINDOW_MS ? `it was parked ${describeAge(input.parkedForMs)}, past the ${describeAge(RESUME_WINDOW_MS)} window for continuing a conversation` : null;
	const seed = await seedBriefForRepo(env, { instanceId: input.instanceId, userId: input.userId, repoId: input.repoId, repoName: input.repoName }).catch(() => "");
	const started = await startSessionOnRunnerConn(env, conn, { ...input, fresh: why !== null, seed: seed || undefined });
	if (started?.resumed === true) return { resumed: true, line: "The coding engine continued its own conversation." };
	return { resumed: false, line: `The coding engine started fresh (${why ?? "its saved conversation was not on the machine"}), briefed from this repository's record.` };
}

// ── #1077: a parked run lets go of its checkout, and takes it back on resume ─────────────────────────

type ParkScope = { runId: string; instanceId: string; userId: string; sessionId: string; repoId: string };

/**
 * Release the checkout of a run parked on a question (#1077, #1072 §B). Its uncommitted work is set
 * aside first, on the runner, by an exact commit id on its own ref (`park-snapshot.ts`), and the
 * checkout is released ONLY if the runner confirms it is clean. Then the run stops being an owner
 * (`checkout_released_at`) and its session goes `suspended`, so the next run opens a session of its
 * own — never this one, whose card is the run's and whose engine resume key is the run's
 * conversation. A runner without the verb, or any failure, keeps the checkout held, as before.
 */
export async function releaseCheckout(env: Env, conn: RunnerConn, scope: ParkScope, now = Date.now()): Promise<{ released: boolean; line: string; onStop?: string }> {
	const repo = await getRepo(env, scope.instanceId, scope.userId, scope.repoId).catch(() => null);
	let saved: { snapshot: string | null; files: number; clean: boolean; ref: string | null };
	try {
		saved = await callRunner(conn, "/coding/park-snapshot", { workDir: repo?.workdir || undefined, repoId: scope.repoId, runId: scope.runId });
	} catch (e) {
		return { released: false, line: `The checkout stays held while it waits: its work could not be set aside on the machine (${e instanceof Error ? e.message : String(e)}; set-aside needs CLI 0.4.140 or later).` };
	}
	if (!saved?.clean) return { released: false, line: "The checkout stays held while it waits: it was not clean after setting the work aside." };
	await env.DB.prepare("UPDATE agent_loop_runs SET checkout_released_at = ?2, checkout_snapshot = ?3 WHERE run_id = ?1 AND status = 'running'").bind(scope.runId, now, saved.snapshot).run();
	await env.DB.prepare("UPDATE coding_sessions SET status = 'suspended', driver_id = NULL, driver_at = NULL, updated_at = datetime('now') WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status = 'active'")
		.bind(scope.sessionId, scope.instanceId, scope.userId)
		.run();
	if (!saved.snapshot) return { released: true, line: "Its checkout is released for other work while it waits (it had no uncommitted changes)." };
	const id = saved.snapshot;
	return {
		released: true,
		line: `Its checkout is released for other work while it waits: ${saved.files} uncommitted file${saved.files === 1 ? " was" : "s were"} set aside as ${id} (\`${saved.ref}\`), put back when it resumes.`,
		onStop: `Its uncommitted work is still set aside as ${id} (\`${saved.ref}\`); \`git stash apply ${saved.snapshot}\` in the checkout brings it back.`,
	};
}

/**
 * Take the checkout back for a resume (#1077). Not released → nothing to do. Busy — another run, a
 * driver or a direct turn on the repo, or another active session (one per repo, by index) — → the
 * run keeps waiting, and is woken when the holder finishes ({@link releasedRunAwaitingCheckout}) or
 * by the minute backstop. Otherwise its own session is reactivated; its work is put back later, by
 * {@link putBackWork}, once the base has been re-synced (#1078).
 */
export async function takeBackCheckout(env: Env, scope: ParkScope): Promise<{ ok: true; snapshot: string | null } | { busy: string }> {
	const run = await env.DB.prepare("SELECT checkout_released_at, checkout_snapshot FROM agent_loop_runs WHERE run_id = ?1").bind(scope.runId).first<{ checkout_released_at: number | null; checkout_snapshot: string | null }>();
	if (!run?.checkout_released_at) return { ok: true, snapshot: null };
	const free = await repoFreeForRun(env, { instanceId: scope.instanceId, userId: scope.userId, repoId: scope.repoId, sessionId: scope.sessionId }, runnerEngineProbe(env, scope.instanceId, scope.userId));
	if (!free.free) return { busy: "another run is working on the repository" };
	const reactivated = await env.DB.prepare("UPDATE coding_sessions SET status = 'active', ended_at = NULL, updated_at = datetime('now') WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status = 'suspended'")
		.bind(scope.sessionId, scope.instanceId, scope.userId)
		.run()
		.then((r) => (r.meta?.changes ?? 0) > 0, () => false);
	if (!reactivated) return { busy: "another session is open on the repository" };
	return { ok: true, snapshot: run.checkout_snapshot };
}

/**
 * Put a resumed run's set-aside work back by its exact id (#1077), on the re-synced base (#1078),
 * and clear its release. A restore that would not apply changes nothing and blocks the resume,
 * naming the conflicting files and where the work is kept.
 */
export async function putBackWork(env: Env, conn: RunnerConn, scope: ParkScope, snapshot: string | null): Promise<{ ok: true } | { blocked: string }> {
	if (snapshot) {
		const repo = await getRepo(env, scope.instanceId, scope.userId, scope.repoId).catch(() => null);
		let restored: { restored?: boolean; refused?: string; conflicts?: string[] };
		try {
			restored = await callRunner(conn, "/coding/park-restore", { workDir: repo?.workdir || undefined, repoId: scope.repoId, runId: scope.runId, snapshot });
		} catch (e) {
			restored = { restored: false, refused: `the coding runner could not put it back (${e instanceof Error ? e.message : String(e)})` };
		}
		if (!restored.restored) {
			const files = restored.conflicts?.length ? ` Conflicting files: ${restored.conflicts.map((f) => `\`${f}\``).join(", ")}.` : "";
			return { blocked: `${restored.refused ?? "its saved work could not be put back"}.${files} Nothing was changed; the work is still set aside as ${snapshot} (\`refs/pags/parked/${scope.runId}\`, \`git stash apply ${snapshot}\`).` };
		}
	}
	await env.DB.prepare("UPDATE agent_loop_runs SET checkout_released_at = NULL, checkout_snapshot = NULL WHERE run_id = ?1").bind(scope.runId).run();
	return { ok: true };
}

/**
 * The whole resume of a parked run, in the only safe order (#1076–#1078):
 *   1. take its checkout back (busy → keep waiting; nothing has changed yet);
 *   2. bring the engine back — which also lets the runner resolve a managed clone through the session;
 *   3. re-sync onto the current upstream with the start-of-run gate (blocked → stop, naming what moved);
 *   4. put its set-aside work back on that base (a conflict → stop, naming the files);
 * and only then is the owner's answer delivered, with what moved while it was parked.
 */
export async function resumeFromPark(
	env: Env,
	conn: RunnerConn,
	input: ParkScope & RelaunchInput & { clientType?: string; repoName: string; driverId?: string; parkedForMs: number },
): Promise<{ resumed: boolean; line: string; moved: string | null } | { busy: string } | { blocked: string }> {
	const held = await takeBackCheckout(env, input);
	if (!("ok" in held)) return held;
	let engine: { resumed: boolean; line: string };
	try {
		engine = await relaunchAfterPark(env, conn, input);
	} catch (e) {
		// No machine to bring the engine back on: let go again and wait, rather than resume without its base re-synced and its work back.
		await env.DB.prepare("UPDATE coding_sessions SET status = 'suspended', updated_at = datetime('now') WHERE id = ?1 AND status = 'active'").bind(input.sessionId).run();
		return { busy: `the coding runner is not reachable (${e instanceof Error ? e.message : String(e)})` };
	}
	const sync = await resyncBeforeAnswer(env, conn, input);
	if (!("ok" in sync)) return sync;
	const work = await putBackWork(env, conn, input, held.snapshot);
	if (!("ok" in work)) return work;
	return { ...engine, moved: sync.moved };
}

/**
 * A run on this repo that released its checkout and now has its answer, waiting to take it back. A
 * drain starts it FIRST (by waking it) instead of the next queued objective: it was there before them.
 */
export async function releasedRunAwaitingCheckout(env: Pick<Env, "DB">, instanceId: string, repoId: string): Promise<string | null> {
	const row = await env.DB.prepare(
		`SELECT r.run_id FROM agent_loop_runs r JOIN coding_sessions s ON s.id = r.session_id JOIN coder_questions q ON q.run_id = r.run_id
		  WHERE r.instance_id = ?1 AND s.repo_id = ?2 AND r.status = 'running' AND r.checkout_released_at IS NOT NULL
		    AND q.applied_at IS NULL AND (q.answered_at IS NOT NULL OR q.state = 'unresolved')
		  ORDER BY r.parked_since ASC LIMIT 1`,
	)
		.bind(instanceId, repoId)
		.first<{ run_id: string }>();
	return row?.run_id ?? null;
}
