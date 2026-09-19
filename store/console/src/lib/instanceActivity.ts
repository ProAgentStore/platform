// What a card says an instance is DOING, and how that orders and narrows the list (#815 slice 4).
//
// The server already decided the verdict. `GET /v1/instances/my/activity` calls the platform's own
// `runHealth` and hands over `working | waiting | stalled | idle` — so this module NEVER derives
// one from a timestamp. That is #589's rule, and the reason `workInFlight.ts` next door is equally
// careful: two surfaces computing "is this alright" independently is how they came to disagree.
//
// What this module does decide is presentation and order, which the server has no opinion about.

import type { Instance } from "./types";

/** The four states a card can be in. `idle` is the server's collapse of `ended` + never-run. */
export const INSTANCE_HEALTHS = ["working", "waiting", "stalled", "idle"] as const;
export type InstanceHealth = (typeof INSTANCE_HEALTHS)[number];

export interface LastOutcome {
	runId: string;
	status: string;
	stopReason: string | null;
	finishedAt: number | null;
	startedAt: number;
	lastAliveAt: number | null;
}

/** One row of the activity response. Instances with nothing to say are ABSENT, not idle-with-zeros. */
export interface InstanceActivity {
	instanceId: string;
	health: InstanceHealth;
	queueDepth: number;
	lastOutcome: LastOutcome | null;
}

export interface ActivityResponse {
	asOf: number;
	instances: InstanceActivity[];
}

/**
 * Index the response by instance id.
 *
 * ABSENCE MEANS IDLE, and that is a contract with the endpoint rather than a convenience: it omits
 * instances with no run and no queue so its cost stays flat in the number of instances an account
 * subscribed and never used. A reader that treated a missing row as "unknown" would put every
 * quiet instance into a fifth state the server deliberately does not have.
 */
export function indexActivity(res: ActivityResponse | null | undefined): Map<string, InstanceActivity> {
	const out = new Map<string, InstanceActivity>();
	for (const row of res?.instances ?? []) out.set(row.instanceId, row);
	return out;
}

/** The activity for one instance, or the idle record the endpoint's omission implies. */
export function activityFor(map: Map<string, InstanceActivity>, instanceId: string): InstanceActivity {
	return map.get(instanceId) ?? { instanceId, health: "idle", queueDepth: 0, lastOutcome: null };
}

/**
 * The card's status word.
 *
 * "Idle" and not "Ready" or "OK": an instance that has never run and one whose last run failed are
 * both idle, and a word implying health would state something about the second that is not true.
 * What the last run DID is a separate line (see {@link outcomeLine}) — a fact, not a verdict.
 */
export const HEALTH_LABEL: Record<InstanceHealth, string> = {
	working: "Working",
	waiting: "Waiting",
	stalled: "Stalled",
	idle: "Idle",
};

/**
 * The dot's colour, and whether it pulses.
 *
 * `waiting` is muted, NOT a warning — the same judgement `LoopRunsSection.tsx`'s `HEALTH_TONE`
 * records. A park is correct and self-resolving; painting it amber is the same over-claim as
 * calling it working, facing the other way. Only `stalled` asks for a human, so only `stalled`
 * gets the danger token.
 *
 * Only `working` pulses. A pulse is an assertion that something is moving right now, and the one
 * state where that is false but the row is still open is exactly `stalled`.
 */
export const HEALTH_DOT: Record<InstanceHealth, string> = {
	working: "bg-accent animate-pulse",
	waiting: "bg-muted",
	stalled: "bg-danger",
	idle: "bg-muted-soft",
};

export const HEALTH_TEXT: Record<InstanceHealth, string> = {
	working: "text-accent",
	waiting: "text-muted",
	stalled: "text-danger",
	idle: "text-muted-soft",
};

/**
 * The second line: what the last run did, as a fact.
 *
 * Null while the instance is working or waiting — the status word is already the live answer, and
 * a card saying "Working" over "last run: failed" invites the reading that THIS run failed.
 *
 * `stopReason` is preferred over `status` where it exists, because it is the more useful half:
 * migration 0062 calls the difference between `max_iterations` and `no_progress` the difference
 * between "raise the cap" and "the objective is wrong", and both are `failed`.
 */
export function outcomeLine(activity: InstanceActivity, now: number): string | null {
	if (activity.health === "working" || activity.health === "waiting") return null;
	const last = activity.lastOutcome;
	if (!last) return null;
	const word = OUTCOME_WORD[last.stopReason ?? ""] ?? OUTCOME_WORD[last.status] ?? last.status;
	const at = last.finishedAt ?? last.lastAliveAt ?? last.startedAt;
	return `Last run: ${word} ${ago(at, now)}`;
}

const OUTCOME_WORD: Record<string, string> = {
	done: "finished",
	completed: "finished",
	max_iterations: "hit its step limit",
	no_progress: "stopped repeating itself",
	budget: "hit its spend limit",
	engine_limit: "hit the CLI's usage limit",
	provider_credit: "ran out of credit",
	interrupted: "was cut off",
	escalated: "asked a question",
	needs_human: "asked a question",
	cancelled: "was stopped",
	failed: "failed",
};

function ago(ms: number, now: number): string {
	const mins = Math.round((now - ms) / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/**
 * When this instance was last REALLY active.
 *
 * `last_activity_at` alone is the claim #815's research showed to be false: it moves only on
 * owner-driven events (chat, task, apply, session open), so a Pilot that has been working
 * unattended for two hours does not move it and sorts below an instance the owner merely opened.
 * The run's own heartbeat and start are the other two terms.
 */
export function lastActiveAt(inst: Instance, activity: InstanceActivity): number {
	const own = Date.parse(String(inst.lastActivityAt ?? "")) || 0;
	const last = activity.lastOutcome;
	return Math.max(own, last?.lastAliveAt ?? 0, last?.startedAt ?? 0);
}

/**
 * Sort order for the Status sort: whatever needs the owner floats up.
 *
 * Stalled first because it is the only state that asks for a human. Waiting before Working because
 * a park is the thing a human might shorten, where a working run wants to be left alone. Idle last.
 */
const STATUS_RANK: Record<InstanceHealth, number> = { stalled: 0, waiting: 1, working: 2, idle: 3 };

export function statusRank(health: InstanceHealth): number {
	return STATUS_RANK[health];
}

/** Counts per status, for the filter's segments — including the zeroes, which stay visible. */
export function healthCounts(
	instances: Instance[],
	map: Map<string, InstanceActivity>,
): Record<InstanceHealth, number> {
	const counts: Record<InstanceHealth, number> = { working: 0, waiting: 0, stalled: 0, idle: 0 };
	for (const inst of instances) counts[activityFor(map, inst.id).health]++;
	return counts;
}

/** A stored or typed value, validated. "" means every status. */
export function parseHealthFilter(raw: unknown): InstanceHealth | "" {
	return (INSTANCE_HEALTHS as readonly unknown[]).includes(raw) ? (raw as InstanceHealth) : "";
}
