/**
 * Bringing a local browser run's state from the runner into PAGS (#944).
 *
 * PULL: the relay carries only cloud→runner commands and the runner holds no API token (see the
 * note atop contract.ts), so PAGS asks the runner — `POST /local-browser/status {runId, afterSeq}` —
 * when a run is read and from the per-minute cron. Every way a runner's report reaches PAGS goes
 * through the two functions here, so the pull and the report routes cannot disagree about what an
 * event or a result does to a run.
 */
import { HttpError } from "../auth.js";
import type { Env } from "../../types.js";
import { callRuntime, getLiveRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import {
	LOCAL_BROWSER_PAUSE_REASONS,
	LOCAL_BROWSER_RESUME_PATH,
	LOCAL_BROWSER_STATUS_PATH,
	type LocalBrowserEvent,
	type LocalBrowserPauseReason,
	parseLocalBrowserEvent,
	parseLocalBrowserResult,
} from "./contract.js";
import { isTerminal } from "./policy.js";
import {
	type LocalBrowserRun,
	activeLocalBrowserRuns,
	appendLocalBrowserEvents,
	getLocalBrowserRun,
	listDomainConsent,
	pruneExpiredLocalBrowserTraces,
	transitionLocalBrowserRun,
} from "./store.js";

/** How long past its own time limit a run may go unheard from before PAGS stops waiting for its runner. */
export const LOST_RUNNER_GRACE_MS = 10 * 60_000;
/** How long a PAUSED run may go without its runner answering before it is ended. */
export const PAUSED_RUNNER_GRACE_MS = 24 * 60 * 60_000;

/** Store a runner's events and apply the two that move a run: a pause, and its resume. */
export async function ingestRunnerEvents(
	env: Env,
	instanceId: string,
	uid: string,
	run: LocalBrowserRun,
	raw: unknown[],
	now: number,
	cursor?: { runnerSeq: number },
): Promise<{ run: LocalBrowserRun; accepted: number; rejected: number; dropped: number }> {
	const events = raw.map(parseLocalBrowserEvent).filter((e): e is LocalBrowserEvent => e !== null);
	const stored = await appendLocalBrowserEvents(env, instanceId, uid, run.id, events, now, cursor);
	let current = run;
	for (const e of events) {
		if (e.type === "run.paused" && current.status === "running") current = (await transitionLocalBrowserRun(env, instanceId, uid, run.id, { to: "paused", pauseReason: e.pauseReason }, now)) ?? current;
		else if (e.type === "run.resumed" && current.status === "paused") current = (await transitionLocalBrowserRun(env, instanceId, uid, run.id, { to: "running" }, now)) ?? current;
	}
	return { run: current, accepted: stored, rejected: raw.length - events.length, dropped: events.length - stored };
}

/** End a run with the runner's result envelope, validated by the shared contract. */
export async function applyRunnerResult(env: Env, instanceId: string, uid: string, run: LocalBrowserRun, raw: unknown, now: number): Promise<LocalBrowserRun> {
	const checked = parseLocalBrowserResult(raw);
	if ("error" in checked) throw new HttpError(400, `Invalid result: ${checked.error}`);
	const parsed = checked.result;
	if (parsed.runId !== run.id) throw new HttpError(400, "Invalid result: runId does not match this run");
	if (isTerminal(run.status)) throw new HttpError(409, `The run has already ended (${run.status})`);
	const to = parsed.outcome === "completed" ? "completed" : "failed";
	const moved = await transitionLocalBrowserRun(
		env,
		instanceId,
		uid,
		run.id,
		{ to, result: parsed, engineAuth: parsed.engineAuth, ...(to === "failed" ? { errorCode: parsed.engineAuth === "missing_login" ? "engine_not_signed_in" : "engine_failed", error: parsed.error ?? null } : {}) },
		now,
	);
	if (!moved) throw new HttpError(409, `The run cannot end from "${run.status}"`);
	await appendLocalBrowserEvents(env, instanceId, uid, run.id, [{ type: "run.ended", at: new Date(now).toISOString(), detail: { status: to, findings: parsed.findings.length, sourceFailures: parsed.sourceFailures.length, engineAuth: parsed.engineAuth } }], now);
	return moved;
}

async function endLost(env: Env, instanceId: string, uid: string, run: LocalBrowserRun, error: string, now: number): Promise<LocalBrowserRun> {
	const failed = await transitionLocalBrowserRun(env, instanceId, uid, run.id, { to: "failed", errorCode: "runner_lost", error }, now);
	if (failed) await appendLocalBrowserEvents(env, instanceId, uid, run.id, [{ type: "run.ended", at: new Date(now).toISOString(), detail: { status: "failed", errorCode: "runner_lost" } }], now);
	return failed ?? run;
}

/**
 * Bring one run up to date from its runner. Best-effort for a runner that is briefly unreachable —
 * the run is returned as it was — but a runner that no longer holds the run (it restarted) or has
 * been silent well past the run's own time limit ends it as `runner_lost`, never "running" forever.
 */
export async function syncLocalBrowserRun(env: Env, instanceId: string, uid: string, run: LocalBrowserRun, now = Date.now()): Promise<LocalBrowserRun> {
	if (run.status !== "running" && run.status !== "paused") return run;
	const silentSince = run.lastSyncedAt ?? run.startedAt ?? run.createdAt;
	const overdue = now - silentSince > run.policy.limits.maxMinutes * 60_000 + LOST_RUNNER_GRACE_MS;
	// A paused run waits on the owner, so its silence is not counted against the run's time limit —
	// but a runner gone a whole day takes the run with it.
	const lostByTime = run.status === "running" ? overdue : now - silentSince > PAUSED_RUNNER_GRACE_MS;
	const runtime = await getLiveRuntime(env, instanceId, uid).catch(() => null);
	if (!runtime) return lostByTime ? endLost(env, instanceId, uid, run, "The runner went offline during the run and did not come back within its time limit.", now) : run;

	let res: Response;
	try {
		res = await callRuntime(env, runtime, LOCAL_BROWSER_STATUS_PATH, { method: "POST", body: JSON.stringify({ runId: run.id, afterSeq: run.runnerSeq }) });
	} catch {
		return run;
	}
	if (res.status === 404) return endLost(env, instanceId, uid, run, "The runner no longer holds this run — it was restarted or updated. Start the run again.", now);
	if (!res.ok) return lostByTime ? endLost(env, instanceId, uid, run, "The runner stopped answering for this run.", now) : run;

	const body = (await runtimeJson(res)) as { state?: unknown; pauseReason?: unknown; events?: unknown; lastSeq?: unknown; result?: unknown };
	const events = Array.isArray(body.events) ? body.events : [];
	const lastSeq = typeof body.lastSeq === "number" && body.lastSeq >= run.runnerSeq ? body.lastSeq : run.runnerSeq;
	let current = (await ingestRunnerEvents(env, instanceId, uid, run, events, now, { runnerSeq: lastSeq })).run;

	// Reconcile with the runner's own state, in case a pause/resume event was capped away.
	if (body.state === "paused" && current.status === "running") {
		const reason = LOCAL_BROWSER_PAUSE_REASONS.includes(body.pauseReason as LocalBrowserPauseReason) ? (body.pauseReason as LocalBrowserPauseReason) : null;
		current = (await transitionLocalBrowserRun(env, instanceId, uid, run.id, { to: "paused", pauseReason: reason }, now)) ?? current;
	} else if (body.state === "running" && current.status === "paused") {
		current = (await transitionLocalBrowserRun(env, instanceId, uid, run.id, { to: "running" }, now)) ?? current;
	}
	if (body.state === "ended" && body.result !== undefined && !isTerminal(current.status)) {
		try {
			current = await applyRunnerResult(env, instanceId, uid, current, body.result, now);
		} catch (err) {
			// A runner that ended the run but sent a result PAGS cannot accept still ended it.
			const failed = await transitionLocalBrowserRun(env, instanceId, uid, run.id, { to: "failed", errorCode: "runner_result_invalid", error: err instanceof Error ? err.message : String(err) }, now);
			current = failed ?? current;
		}
	}
	return current;
}

/** Release a paused run: send the owner's current decisions to the runner, then read it back. */
export async function resumeLocalBrowserRun(env: Env, instanceId: string, uid: string, run: LocalBrowserRun, now = Date.now()): Promise<LocalBrowserRun> {
	if (run.status !== "paused") throw new HttpError(409, `Only a paused run can be resumed; this one is ${run.status}`);
	const runtime = await getLiveRuntime(env, instanceId, uid).catch(() => null);
	if (!runtime) throw new HttpError(409, "No runner is connected. Run `pags up` on the machine doing the research, then resume.");
	const consent = await listDomainConsent(env, instanceId, uid, now);
	const navigate = consent.filter((x) => x.scope === "navigate");
	const res = await callRuntime(env, runtime, LOCAL_BROWSER_RESUME_PATH, {
		method: "POST",
		body: JSON.stringify({
			runId: run.id,
			consentedDomains: navigate.filter((x) => x.decision === "allow").map((x) => x.domain),
			denyDomains: navigate.filter((x) => x.decision === "deny").map((x) => x.domain),
			profileConsented: consent.some((x) => x.scope === "signed_in_profile" && x.decision === "allow"),
		}),
	}).catch(() => null);
	if (!res) throw new HttpError(409, "The runner did not answer. Check `pags up` on that machine and try again.");
	if (res.status === 404) return endLost(env, instanceId, uid, run, "The runner no longer holds this run — it was restarted or updated. Start the run again.", now);
	if (!res.ok) throw new HttpError(409, `The runner refused to resume: HTTP ${res.status}`);
	return syncLocalBrowserRun(env, instanceId, uid, (await getLocalBrowserRun(env, instanceId, uid, run.id)) ?? run, now);
}

/** The cron tick: pull a batch of active runs, oldest-synced first, and drop expired traces. */
export async function syncActiveLocalBrowserRuns(env: Env, limit = 25): Promise<number> {
	const now = Date.now();
	let synced = 0;
	for (const r of await activeLocalBrowserRuns(env, limit)) {
		const run = await getLocalBrowserRun(env, r.instanceId, r.userId, r.id);
		if (!run) continue;
		await syncLocalBrowserRun(env, r.instanceId, r.userId, run, now).catch(() => undefined);
		synced++;
	}
	await pruneExpiredLocalBrowserTraces(env, now).catch(() => undefined);
	return synced;
}
