/**
 * Every backoff ladder for a provider-account hold and the runs stopped behind it, in one place (#1356).
 *
 * The probe ladder (5 min, 15 min, 1 h, then every 6 h) used to live in `credit-auto-resume.ts` while three other files told the
 * owner what it was in prose: a hold's notice, the failure table in `coding-failure.ts` and `platform-docs/provider-errors.md`.
 * Changing a number meant finding every sentence. The sentences are now built from {@link PROBE_BACKOFF_MS} by
 * {@link probeScheduleText}, so the text cannot disagree with the schedule.
 *
 * A leaf: it imports nothing.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Re-check of a held key: after each of these, the last repeating. */
export const PROBE_BACKOFF_MS = [5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS, 6 * HOUR_MS] as const;
/** A key failing for longer than this (from the first refusal of its episode) is left to a real call to find out. */
export const PROBE_GIVE_UP_MS = 7 * DAY_MS;
/** How far back a stopped run is still continued once its key works: the continue path's reach is limited. */
export const AUTO_RESUME_WINDOW_MS = 7 * DAY_MS;
/** A deferred continue retries after 1, 2, 4… minutes, capped at this. */
export const RESUME_RETRY_CAP_MS = HOUR_MS;

/** Delay before the next re-check of a hold that has failed `attempts` times (1-based; fewer than 1 counts as 1). */
export const probeDelayMs = (attempts: number): number => PROBE_BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, PROBE_BACKOFF_MS.length - 1)];

/** Retry delay for a deferred continue: 1, 2, 4… minutes, capped at {@link RESUME_RETRY_CAP_MS}. */
export const resumeDelayMs = (attempts: number): number => Math.min(2 ** Math.max(attempts - 1, 0) * MINUTE_MS, RESUME_RETRY_CAP_MS);

/** A duration as the owner reads it: "5 min", "1 h", "7 days". */
export function durationText(ms: number): string {
	if (ms % DAY_MS === 0) return `${ms / DAY_MS} ${ms === DAY_MS ? "day" : "days"}`;
	if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} h`;
	return `${Math.round(ms / MINUTE_MS)} min`;
}

/** "5 min, 15 min, 1 h, then every 6 h" — the probe ladder in words. */
export function probeScheduleText(): string {
	const last = PROBE_BACKOFF_MS[PROBE_BACKOFF_MS.length - 1];
	const lead = PROBE_BACKOFF_MS.slice(0, -1).map(durationText).join(", ");
	return `${lead}, then every ${durationText(last)}`;
}

/** How long the platform keeps re-checking one refusal episode, in words ("7 days"). */
export const probeGiveUpText = (): string => durationText(PROBE_GIVE_UP_MS);
