/**
 * When a schedule fires: grammar, wall-clock arithmetic, jitter, and the one-period advance.
 *
 * Extracted from `triggers.ts` (#412), which is a DISPATCH module — it decides what a trigger
 * does and to whom. Deciding WHEN is a separate concern with a separate collaborator
 * (`cron-time.ts`), and it needed one more function that could not be added there: `triggers.ts`
 * sat one line under its size pin, and putting time arithmetic into a dispatch file to get it
 * is how the pin ends up being raised for a reason nobody would defend later.
 *
 * Nothing here changed in the move except its address. The new function is `advanceCron`.
 */

import { HttpError } from "./auth.js";
import { cronFields, isValidTimeZone, nextCronInstant } from "./cron-time.js";

export function normalizeSchedule(value: unknown): string {
	const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
	if (!raw) throw new HttpError(400, "schedule required for cron triggers");
	if (raw === "@hourly" || raw === "@daily" || raw === "@weekly") return raw;
	const every = raw.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hour|hours|d|day|days)$/);
	if (every) {
		const n = Number(every[1]);
		const unit = every[2][0];
		const minutes = unit === "m" ? n : unit === "h" ? n * 60 : n * 1440;
		if (minutes < 5) throw new HttpError(400, "minimum cron interval is 5 minutes");
		if (minutes > 31 * 24 * 60) throw new HttpError(400, "maximum cron interval is 31 days");
		return `every ${minutes} minutes`;
	}
	const parts = raw.split(" ");
	if (parts.length === 5 && parts.every((p) => p === "*" || /^\d+$/.test(p))) {
		const [minute, hour, day, month, weekday] = parts;
		const valid =
			validRange(minute, 0, 59) &&
			validRange(hour, 0, 23) &&
			validRange(day, 1, 31) &&
			validRange(month, 1, 12) &&
			validRange(weekday, 0, 7);
		if (!valid) throw new HttpError(400, "cron expression has an out-of-range field");
		// Enforce the same 5-minute floor as the `every N` form. The grammar only allows `*`
		// or a literal digit per field (no `*/N`), so a `*` minute means EVERY minute — which
		// would fire per worker-cron tick, bypassing the interval floor and multiplying
		// connector-scan / AI cost. Require a specific minute (≥ hourly) instead.
		if (minute === "*") throw new HttpError(400, "minimum cron interval is 5 minutes — pin a specific minute, or use 'every N minutes'");
		return parts.join(" ");
	}
	throw new HttpError(400, "unsupported schedule; use @hourly, @daily, every N minutes, or a simple 5-field cron");
}

function validRange(part: string, min: number, max: number): boolean {
	if (part === "*") return true;
	const n = Number(part);
	return Number.isInteger(n) && n >= min && n <= max;
}

/**
 * When this schedule next fires, as an ISO instant.
 *
 * `timeZone` (#18) decides which clock the WALL-CLOCK schedules are read against — `@daily`,
 * `@weekly` and 5-field cron. Absent or unknown → UTC, i.e. exactly the behaviour of every
 * trigger that existed before timezones did. Interval schedules (`@hourly`, `every N minutes`)
 * are durations, not clock times, so a zone cannot change them and is not applied.
 */
export function nextRunAt(schedule: string, from = new Date(), timeZone?: string): string {
	const normalized = normalizeSchedule(schedule);
	const base = new Date(from.getTime());
	base.setUTCSeconds(0, 0);
	if (normalized === "@hourly") return addMinutes(base, 60).toISOString();
	const every = normalized.match(/^every\s+(\d+)\s+minutes$/);
	if (every) return addMinutes(base, Number(every[1])).toISOString();

	// The aliases ARE cron expressions; expanding them here means there is one wall-clock
	// evaluator rather than a cron path and an alias path that can disagree about a timezone.
	const expression = normalized === "@daily" ? "0 0 * * *" : normalized === "@weekly" ? "0 0 * * 0" : normalized;
	const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
	const instant = nextCronInstant(cronFields(expression), base, zone);
	if (instant === null) throw new HttpError(400, "schedule has no run in the next year");
	return new Date(instant).toISOString();
}

/**
 * The next `count` fire times, for an honest console preview (#18). Computed by the SAME
 * function the scheduler uses, on the server, so a preview cannot drift from behaviour — the
 * one thing worse than no next-run preview is a next-run preview that lies.
 */
export function previewRuns(schedule: string, timeZone?: string, count = 3, from = new Date()): string[] {
	const runs: string[] = [];
	let cursor = from;
	for (let i = 0; i < Math.max(1, Math.min(count, 10)); i++) {
		const next = nextRunAt(schedule, cursor, timeZone);
		runs.push(next);
		cursor = new Date(Date.parse(next));
	}
	return runs;
}

function addMinutes(date: Date, minutes: number): Date {
	return new Date(date.getTime() + minutes * 60_000);
}

/** Offset a scheduled time by a random ± jitter (minutes) so recurring runs don't fire
 *  exactly on the dot — a cheap anti-pattern defense for automation. Clamped to ≥ 1 min
 *  in the future so jitter can never schedule a run in the past. */
export function applyJitter(iso: string, jitterMinutes?: number): string {
	const j = typeof jitterMinutes === "number" && jitterMinutes > 0 ? Math.min(jitterMinutes, 720) : 0;
	if (!j) return iso;
	const offsetMs = (Math.random() * 2 - 1) * j * 60_000;
	const floor = Date.now() + 60_000;
	return new Date(Math.max(Date.parse(iso) + offsetMs, floor)).toISOString();
}

/** One period of a cron schedule: where the schedule IS, and when it will actually fire. */
export interface CronAdvance {
	/** The un-jittered scheduled time. This is the schedule's STATE — persist it. */
	slot: string;
	/** The slot with jitter applied. This is PRESENTATION — when to actually fire. */
	fire: string;
}

/**
 * Advance a cron schedule by exactly one period (#412).
 *
 * ## The bug this exists to make impossible
 *
 * A trigger used to store one time and use it for two different things: when to fire (jittered)
 * and where we are in the schedule (the slot). The sweep then computed the next slot from the
 * moment it fired — `nextRunAt(schedule, now)` — which let presentation mutate state.
 *
 * `applyJitter` is symmetric, so a run whose jitter landed NEGATIVE happens before its slot, and
 * the next slot computed from that earlier moment is the SAME slot, minutes away instead of a
 * period away. With `@daily` and 90 minutes of jitter:
 *
 *   1. slot 00:00, jitter −24m  → fires 23:36
 *   2. `nextRunAt("@daily", 23:36)` → 00:00 tonight — 24 minutes away
 *   3. jitter ±90 around that, floored at `now + 60s` → next ∈ [23:37, 01:30]
 *
 * Every outcome of step 3 clears the floor, so "daily" did not merely RISK firing twice in one
 * night — it always did, and if the second run also landed before midnight the cycle repeated.
 * Nothing looked broken: each individual run succeeded, `failureCount` stayed 0, and the only
 * symptom was a workload the owner never asked for.
 *
 * ## The rule
 *
 *     slot(n+1) = nextRunAt(schedule, slot(n))     // pure cron, jitter-free
 *     fire(n+1) = applyJitter(slot(n+1), jitter)   // presentation only
 *
 * ## Why the base is `max(slot, now)` rather than the slot alone
 *
 *   • **slot ahead of now** — a negatively-jittered run, the bug above. Advancing from the SLOT
 *     keeps the interval a full period. This is the fix.
 *   • **slot behind now** — the ordinary case (positive jitter), and also a sweep resuming after
 *     an outage. Advancing from NOW picks up at the next real slot instead of replaying every
 *     slot that was missed, one minute apart, until it catches up. A missed run is a missed run;
 *     a catch-up storm against a real logged-in account is a new incident.
 *   • **no slot at all** — a row written before the column existed. `Date.parse` gives NaN, every
 *     comparison against it is false, so the base is `now`: byte-for-byte the old behaviour for
 *     ONE more run, after which the row has a slot and is correct forever. That is what makes
 *     this recover without a backfill — there is no way to recover a slot that was never stored,
 *     and inventing one from a jittered `next_run_at` would be a guess with a ±jitter error bar.
 */
export function advanceCron(
	schedule: string,
	opts: { now: Date; slot?: string | null; timeZone?: string; jitterMinutes?: number },
): CronAdvance {
	const slotMs = opts.slot ? Date.parse(opts.slot) : Number.NaN;
	const base = Number.isFinite(slotMs) && slotMs > opts.now.getTime() ? new Date(slotMs) : opts.now;
	const slot = nextRunAt(schedule, base, opts.timeZone);
	return { slot, fire: applyJitter(slot, opts.jitterMinutes) };
}
