import { runHealth, type RunHealthInput } from "./work-report.js";

/**
 * What every instance on the dashboard is doing right now (#815 slice 1).
 *
 * The console's My Instances list could sort and filter but could not say whether anything was
 * HAPPENING. The only way to find out was `GET /v1/instances/:id/loop` per card — which is what
 * `recent_instances` does, and why it is capped at a handful. The operator account has 43
 * instances, so a per-card fan-out is not a design, it is a reason not to build the feature.
 *
 * So: two queries for the whole account, folded here. Pure, with `now` injected, for the reason
 * `connection-guide.ts` states — the rules that decide what a user sees are worth testing without
 * a database in the room.
 *
 * ── The verdict is NOT recomputed here
 *
 * `runHealth` (`work-report.ts`) is the platform's one answer to "is this run alright", and #589's
 * rule is that nothing derives a second one from timestamps. This module calls it and maps its
 * four states onto the instance. That mapping is the only judgement it makes, and it is one line.
 *
 * The temptation this exists to refuse: "an open row means working". It does not. A run parked on
 * a platform interruption has nothing ticking BY DESIGN, and a wedged run has nothing ticking
 * because it is dead — `runHealth` is what tells those apart, and run `fe53a0c1` (#790) is the
 * 25-minute incident that proves an open row alone reports a corpse as healthy.
 */

/** One run row, as far as this module reads it. Extends the health input rather than restating it,
 *  so a new signal added to `RunHealthInput` cannot be silently dropped on this path. */
export interface ActivityRunRow extends RunHealthInput {
	instanceId: string;
	runId: string;
	stopReason: string | null;
	finishedAt: number | null;
}

/**
 * An instance's state, as a card shows it.
 *
 * `idle` is `runHealth`'s `ended` plus "no run at all", collapsed deliberately: an instance does
 * not end, its last run does. What ended is carried on {@link InstanceActivity.lastOutcome} so the
 * card can say "last run: failed 2h ago" — a fact — rather than the instance wearing a verdict
 * that belongs to one of its runs.
 */
export type InstanceHealth = "working" | "waiting" | "stalled" | "idle";

/** The latest run's verdict. Present whenever a run exists, INCLUDING while one is open — a card
 *  showing "working 3/40" may also want to say what the run before it did. */
export interface LastOutcome {
	runId: string;
	status: string;
	stopReason: string | null;
	finishedAt: number | null;
	/**
	 * When the run began, and when it last showed a sign of life.
	 *
	 * Here because "last active" cannot be answered without them. `agent_instances.last_activity_at`
	 * moves only on OWNER-driven events, so an instance whose Pilot has been working unattended for
	 * two hours sorts below one the owner merely opened — which is why the list's default sort is
	 * still labelled "Recently used". A caller ordering by real activity needs
	 * `max(lastActivityAt, lastAliveAt, startedAt)`, and only these two come from the run.
	 */
	startedAt: number;
	lastAliveAt: number | null;
}

export interface InstanceActivity {
	instanceId: string;
	health: InstanceHealth;
	/** Objectives parked behind this instance. 0 for every agent type that never queues. */
	queueDepth: number;
	lastOutcome: LastOutcome | null;
}

/** `runHealth`'s four states, collapsed to the instance's. The ONLY judgement in this module. */
export function instanceHealthFor(run: ActivityRunRow | null | undefined, now: number): InstanceHealth {
	if (!run) return "idle";
	const health = runHealth(run, now);
	return health === "ended" ? "idle" : health;
}

/**
 * Fold the two queries into one record per instance.
 *
 * Instances with NEITHER a run nor a queued objective are absent from the result, not listed as
 * idle. Listing them would need a third query for the roster, and the console already holds the
 * roster — it reads absence as idle. That keeps this endpoint's cost independent of how many
 * instances an account has subscribed and never used.
 *
 * Ordered by instance id so the response is stable between polls; the console sorts it anyway, and
 * an unstable order would make a diff of two polls unreadable.
 */
export function composeInstanceActivity(
	runs: readonly ActivityRunRow[],
	queueDepths: ReadonlyMap<string, number>,
	now: number,
): InstanceActivity[] {
	const byInstance = new Map<string, ActivityRunRow>();
	for (const run of runs) {
		// Defensive: the query already returns one row per instance. If it ever returns more, the
		// NEWEST wins, which is the same rule the SQL's ORDER BY applies — not the last row read.
		const seen = byInstance.get(run.instanceId);
		if (!seen || run.startedAt > seen.startedAt) byInstance.set(run.instanceId, run);
	}

	const ids = new Set<string>([...byInstance.keys(), ...queueDepths.keys()]);
	const out: InstanceActivity[] = [];
	for (const instanceId of [...ids].sort()) {
		const run = byInstance.get(instanceId) ?? null;
		out.push({
			instanceId,
			health: instanceHealthFor(run, now),
			queueDepth: queueDepths.get(instanceId) ?? 0,
			lastOutcome: run
				? {
						runId: run.runId,
						status: run.status,
						stopReason: run.stopReason,
						finishedAt: run.finishedAt,
						startedAt: run.startedAt,
						lastAliveAt: run.lastAliveAt ?? null,
					}
				: null,
		});
	}
	return out;
}
