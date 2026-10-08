/**
 * Is this Scout SCHEDULED, and when did it last look? (#980)
 *
 * ── What was missing
 *
 * A connected Job Search Scout with leads in its Data table, and no way to answer: is it scheduled,
 * when did it last search, when will it search next, did the last scan work. The machinery for a
 * scheduled scan has existed since #962 — a cron trigger with the `run_local_browser` action, swept
 * by `runDueTriggers`, carrying `next_run_at`, `last_run_at`, `failure_count` and `last_error`. What
 * did not exist was a READ of it as the Scout's own schedule, so neither the console nor MCP could
 * show the owner whether anything was going to happen.
 *
 * ── Why this is a view and not a new table
 *
 * Because a second scheduler is the wrong answer to "I cannot see the first one". `trigger.ts`'s
 * own header says the scheduled run must BE the run an owner starts by hand, held to the same
 * policy and consent; a parallel schedule would be a second set of rules to keep in step, and the
 * first one to drift would do it silently. So this module composes the existing rows into the
 * schedule an owner reads, and writing it stays the trigger routes — which the console and MCP
 * already share (`create_instance_trigger`, `list_instance_triggers`, …).
 *
 * ── What it must never do
 *
 * Choose a cadence. #980 is explicit ("Do not silently choose a user cadence"), and it is right:
 * a scan spends the owner's machine, their engine subscription and whatever the sites they search
 * make of the traffic. `configured: false` is the honest answer for an unscheduled Scout, and the
 * console shows it as a prompt rather than filling in an hourly default nobody asked for.
 */
import type { Env } from "../../types.js";
import { parseConfig } from "../triggers.js";

/** The trigger action that IS a scheduled scan. One constant, so a reader cannot drift from it. */
export const SCAN_TRIGGER_ACTION = "run_local_browser" as const;

/** One scheduled scan, as the owner reads it. */
export interface ScanSchedule {
	/** Is there a scan schedule at all? False means nobody has set one — not that it is off. */
	configured: boolean;
	/** Set, and switched on. A configured-but-disabled schedule is a deliberate pause. */
	enabled: boolean;
	/** The cron expression as stored (`@daily`, `0 7 * * *`), or null when unconfigured. */
	cadence: string | null;
	/** What a scheduled scan is told to look for. The owner's words, from the trigger's config. */
	objective: string | null;
	/** The trigger behind it, for the write path both surfaces already have. */
	triggerId: string | null;
	name: string | null;
	/** ISO times from the sweeper's own bookkeeping. */
	nextRunAt: string | null;
	lastRunAt: string | null;
	/** The un-jittered slot `nextRunAt` came from (#412), when the sweeper has recorded one. */
	nextSlotAt: string | null;
	/** Consecutive failures and the last reason, as the trigger records them. */
	failureCount: number;
	lastError: string | null;
}

export const UNSCHEDULED: ScanSchedule = {
	configured: false,
	enabled: false,
	cadence: null,
	objective: null,
	triggerId: null,
	name: null,
	nextRunAt: null,
	lastRunAt: null,
	nextSlotAt: null,
	failureCount: 0,
	lastError: null,
};

/** A trigger row, as this module needs to see it. */
export interface ScanTriggerRow {
	id: string;
	name: string;
	type: string;
	action: string;
	enabled: number;
	schedule: string | null;
	config: string | null;
	last_run_at: string | null;
	next_run_at: string | null;
	next_slot_at: string | null;
	failure_count: number;
	last_error: string | null;
}

/**
 * The schedule these trigger rows amount to. PURE.
 *
 * The ENABLED one wins when there is a choice, and the newest after that: an owner who set a
 * schedule, switched it off and set another is asking about the one that will actually fire, and
 * reporting a disabled row's cadence as "the schedule" would answer a different question.
 */
export function scanScheduleOf(rows: readonly ScanTriggerRow[]): ScanSchedule {
	const scans = rows.filter((r) => r.type === "cron" && r.action === SCAN_TRIGGER_ACTION);
	if (!scans.length) return UNSCHEDULED;
	const row = scans.find((r) => r.enabled === 1) ?? scans[0];
	const config = parseConfig(row.config) as { objective?: unknown };
	return {
		configured: true,
		enabled: row.enabled === 1,
		cadence: row.schedule ?? null,
		objective: typeof config.objective === "string" && config.objective.trim() ? config.objective.trim() : null,
		triggerId: row.id,
		name: row.name,
		nextRunAt: row.next_run_at ?? null,
		lastRunAt: row.last_run_at ?? null,
		nextSlotAt: row.next_slot_at ?? null,
		failureCount: Number(row.failure_count ?? 0),
		lastError: row.last_error ?? null,
	};
}

/**
 * One sentence an owner (or a model) can act on. Reported beside the fields rather than instead of
 * them: a surface that only had the words would have to parse them back to render a control.
 */
export function scanScheduleSummary(s: ScanSchedule): string {
	if (!s.configured) return "No scan schedule. This Scout searches only when you start a run — set a cadence to have it search by itself.";
	if (!s.enabled) return `Scan schedule ${s.cadence} is SWITCHED OFF. Nothing is scheduled; enable it to resume automatic scans.`;
	const next = s.nextRunAt ? `next ${s.nextRunAt}` : "next run not yet scheduled";
	const last = s.lastRunAt ? `last ran ${s.lastRunAt}` : "has not run yet";
	const failing = s.failureCount > 0 ? ` ${s.failureCount} consecutive failure(s): ${s.lastError ?? "no reason recorded"}.` : "";
	return `Scanning ${s.cadence} — ${next}, ${last}.${failing}`;
}

/** The scan schedule for one instance. Owner-scoped in SQL, like every other instance read. */
export async function readScanSchedule(env: Env, instanceId: string, userId: string): Promise<ScanSchedule> {
	const { results } = await env.DB.prepare(
		`SELECT id, name, type, action, enabled, schedule, config, last_run_at, next_run_at, next_slot_at, failure_count, last_error
		   FROM agent_triggers
		  WHERE instance_id = ?1 AND user_id = ?2 AND action = ?3
		  ORDER BY enabled DESC, created_at DESC`,
	)
		.bind(instanceId, userId, SCAN_TRIGGER_ACTION)
		.all<ScanTriggerRow>()
		.catch(() => ({ results: [] as ScanTriggerRow[] }));
	return scanScheduleOf(results ?? []);
}
