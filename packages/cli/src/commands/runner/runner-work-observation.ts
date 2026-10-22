import type { UpdateObservation } from "./self-update.js";

export interface RunnerCodingLifecycle {
	sessionId?: unknown;
	alive?: unknown;
	runState?: unknown;
	/** A platform run owns this session (#1178): its Pilot may be deciding, so an idle engine is not safe to restart across. */
	platformRun?: unknown;
}

export interface RunnerWorkObservation {
	sessions?: unknown;
	work?: { codingTurns?: unknown; localRuns?: unknown; detail?: unknown };
}

/**
 * Turn the two runner observations into the named work that blocks a restart (#1007).
 *
 * A retained engine is safe only when its own lifecycle says `alive:true, runState:"idle"`.
 * Every missing or unrecognised value is deliberately a named blocker: an observation problem is
 * never evidence that it is safe to cut off an owner's machine. The session id and state are
 * diagnostic metadata only; no terminal text, paths, credentials, or prompts pass this boundary.
 */
/** A whole non-negative count — what `codingTurns` and `localRuns` must be. */
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * The ONE reading of a `/health` `work` body (#1020): non-negative integer `codingTurns` and `localRuns`, and a
 * `detail` list of strings. The guard below and the relay's observation flags both ask this, so an HTTP 200 whose
 * body is `{}`, `[]` or wrongly typed can never be a healthy look in one place and unreadable in the other.
 */
export function isWorkShape(work: unknown): work is { codingTurns: number; localRuns: number; detail: string[] } {
	if (!work || typeof work !== "object" || Array.isArray(work)) return false;
	const w = work as { codingTurns?: unknown; localRuns?: unknown; detail?: unknown };
	return count(w.codingTurns) && count(w.localRuns) && Array.isArray(w.detail) && w.detail.every((item) => typeof item === "string");
}

/**
 * One retained engine as the guard reads it (#1020). `stopped` (alive:false) and `idle_retained`
 * (alive:true, runState "idle") cannot be interrupted; an `active_turn` is alive in a named non-idle
 * state; anything else — a missing or non-boolean `alive`, a missing state, a non-object entry — is
 * `unknown`. The guard blocks on the last two, so the counts below and the blocker cannot disagree.
 */
export type SessionState = "active_turn" | "owned_idle" | "idle_retained" | "stopped" | "unknown";

export function sessionStateOf(session: unknown): SessionState {
	if (!session || typeof session !== "object") return "unknown";
	const s = session as RunnerCodingLifecycle;
	if (s.alive === false) return "stopped";
	const state = typeof s.runState === "string" && s.runState ? s.runState : null;
	if (s.alive !== true || !state) return "unknown";
	// Idle between a run's turns is `owned_idle`, which blocks like a turn: only a runner that says `platformRun: true` is read this way,
	// so an older runner (no field) keeps the old reading.
	if (state === "idle") return s.platformRun === true ? "owned_idle" : "idle_retained";
	return "active_turn";
}

/** Counts only — never a session id, state text, path or prompt. What the `sessions` observation reports. */
export interface SessionStateCounts {
	activeTurns: number;
	/** Idle, but a platform run owns the session (#1178) — blocks a restart. */
	ownedIdle: number;
	idleRetained: number;
	stopped: number;
	unknown: number;
}

export function sessionStateCounts(sessions: unknown[]): SessionStateCounts {
	const counts: SessionStateCounts = { activeTurns: 0, ownedIdle: 0, idleRetained: 0, stopped: 0, unknown: 0 };
	for (const session of sessions) {
		const state = sessionStateOf(session);
		if (state === "active_turn") counts.activeTurns++;
		else if (state === "owned_idle") counts.ownedIdle++;
		else if (state === "idle_retained") counts.idleRetained++;
		else if (state === "stopped") counts.stopped++;
		else counts.unknown++;
	}
	return counts;
}

export function observedRunnerWork(observation: RunnerWorkObservation): string[] {
	const sessions = observation.sessions;
	const work = observation.work;
	if (!Array.isArray(sessions) || !isWorkShape(work)) return ["runner-work-observation-unavailable"];
	const { codingTurns, localRuns, detail } = work;

	const activeCoding = (sessions as RunnerCodingLifecycle[]).flatMap((session) => {
		// A definitely stopped process cannot be interrupted. Everything else must prove it is idle.
		const kind = sessionStateOf(session);
		if (kind === "stopped" || kind === "idle_retained") return [];
		const id = typeof session?.sessionId === "string" && session.sessionId ? session.sessionId : "unidentified-session";
		const state = typeof session?.runState === "string" && session.runState ? session.runState : "unknown";
		return [kind === "owned_idle" ? `coding session ${id} (idle, owned by a platform run)` : `coding session ${id} (${state})`];
	});
	const unmatchedCodingTurns = Math.max(0, codingTurns - activeCoding.length);
	const localDetail = detail.slice(codingTurns);
	return [
		...activeCoding,
		...Array.from({ length: unmatchedCodingTurns }, (_v, i) => `coding-turn-unmatched-${i + 1}`),
		...Array.from({ length: localRuns }, (_v, i) => localDetail[i] || `local-run-${i + 1}`),
	];
}

/**
 * The paired local look as the updater records it (#1020): what blocks a restart (the guard's reading) and, per half,
 * whether it answered in a shape the guard can read — `malformed` when it answered HTTP 200 but could not be read,
 * apart from a request that failed outright. One function, so the guard and the flags cannot read one answer two ways.
 */
export function readWorkLook(
	sessions: PromiseSettledResult<{ sessions?: unknown }>,
	health: PromiseSettledResult<{ work?: unknown }>,
	sampledAt: number,
): { busy: string[]; observations: UpdateObservation[] } {
	const sessionsOk = sessions.status === "fulfilled" && Array.isArray(sessions.value?.sessions);
	const healthOk = health.status === "fulfilled" && isWorkShape(health.value?.work);
	// An unavailable observation is NEVER evidence that a restart is safe: fail closed.
	const busy = sessions.status === "fulfilled" && health.status === "fulfilled"
		? observedRunnerWork({ sessions: sessions.value?.sessions, work: health.value?.work as RunnerWorkObservation["work"] })
		: ["runner-work-observation-unavailable"];
	return {
		busy,
		observations: [
			{
				source: "sessions",
				success: sessionsOk,
				sampledAt,
				...(sessions.status === "fulfilled" && !sessionsOk ? { malformed: true } : {}),
				// What the readable list held, by lifecycle state — counts only (#1020).
				...(sessions.status === "fulfilled" && sessionsOk ? { sessionStates: sessionStateCounts(sessions.value.sessions as unknown[]) } : {}),
			},
			{ source: "health", success: healthOk, sampledAt, ...(health.status === "fulfilled" && !healthOk ? { malformed: true } : {}) },
		],
	};
}
