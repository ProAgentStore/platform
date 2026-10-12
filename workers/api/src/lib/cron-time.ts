/**
 * Wall-clock arithmetic for cron schedules (#18).
 *
 * Until this existed a schedule was UTC and only UTC: `0 8 * * *` fired at 08:00Z, which is
 * 18:00 or 19:00 in Melbourne depending on the month. A user who wanted "the 8am digest" had
 * to do the conversion in their head AND redo it twice a year — and nothing in the product
 * ever told them the second half.
 *
 * A trigger may now carry `config.timezone` (an IANA zone). When it does, the cron fields are
 * matched against the WALL CLOCK in that zone, so "daily at 08:00" stays 08:00 across a DST
 * transition rather than sliding an hour. When it does not, everything behaves exactly as
 * before — UTC — so no existing trigger changes meaning.
 *
 * The method, and why it is this shape:
 *
 *  1. A wall-clock time is represented as "pseudo-UTC" milliseconds: the y/m/d/h/m read in the
 *     target zone, fed back through `Date.UTC`. In that space `getUTCHours()` etc. ARE the local
 *     fields, so the cron matcher is plain integer comparison — no formatting per candidate
 *     minute. Scanning a year is ~500k cheap iterations, the same cost the UTC path already paid.
 *  2. Only a MATCHING candidate is converted back to a real instant, which costs a couple of
 *     `Intl` calls. Matches are rare, so the expensive step runs a handful of times.
 *  3. The conversion back is offset-solved, not assumed: take the zone's offset at the guessed
 *     instant, re-guess, and confirm the result round-trips to the wall time we asked for. That
 *     confirmation is what makes DST correct rather than approximately correct.
 *
 * DST has two edge cases and this file takes an explicit position on both:
 *
 *  • Spring forward — the requested wall time does not exist (02:30 on the morning the clock
 *    jumps 02:00 → 03:00). We do NOT skip the day: the run is placed at the same offset-relative
 *    instant, which lands just after the jump. Skipping would silently drop a daily digest once a
 *    year, which is the worse failure — a missing run looks like a broken agent.
 *  • Fall back — the wall time happens twice. We return one instant, so the trigger fires ONCE.
 *    Firing twice would duplicate side effects (a second task, a second import), and for a
 *    schedule the user thinks of as "daily", two runs is a bug and one is merely a choice.
 */

export interface WallParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Is this a timezone the runtime actually knows? Anything else must be rejected at the edge —
 *  a typo'd zone silently falling back to UTC is exactly the lie this feature exists to remove. */
export function isValidTimeZone(value: unknown): value is string {
	if (typeof value !== "string" || !value.trim() || value.length > 64) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

function formatter(timeZone: string): Intl.DateTimeFormat {
	let f = formatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timeZone, f);
	}
	return f;
}

/** The calendar/clock fields an observer in `timeZone` sees at this instant. */
export function wallPartsInZone(instant: Date, timeZone: string): WallParts {
	const parts = formatter(timeZone).formatToParts(instant);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
	return {
		year: get("year"),
		month: get("month"),
		day: get("day"),
		// `hourCycle: "h23"` should keep midnight at 0, but older ICU builds have been known to
		// emit 24. Normalising here costs nothing and stops a once-a-day off-by-one-day bug.
		hour: get("hour") % 24,
		minute: get("minute"),
		second: get("second"),
	};
}

/** The wall clock as "pseudo-UTC" ms — the representation the matcher works in. */
export function wallMsInZone(instant: Date, timeZone: string): number {
	const p = wallPartsInZone(instant, timeZone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** The zone's UTC offset (ms, east-positive) at a given instant. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
	const seconds = Math.floor(instant.getTime() / 1000) * 1000;
	return wallMsInZone(instant, timeZone) - seconds;
}

export interface WallResolution {
	/** The real UTC instant (epoch ms). */
	instant: number;
	/** False when the requested wall time does not exist (spring-forward gap) and the run was
	 *  placed at the nearest real instant instead. Surfaced so a preview can say so. */
	exact: boolean;
}

/**
 * Turn a wall-clock time (pseudo-UTC ms) in `timeZone` into a real UTC instant.
 *
 * The offset depends on the instant, and the instant depends on the offset, so this is solved
 * rather than computed: guess with the offset at the naive instant, re-guess with the offset at
 * the guess, then verify the answer really does read back as the wall time we wanted.
 */
export function resolveWallTime(wallMs: number, timeZone: string): WallResolution {
	let offset = zoneOffsetMs(new Date(wallMs), timeZone);
	let instant = wallMs - offset;
	for (let i = 0; i < 3; i++) {
		const settled = zoneOffsetMs(new Date(instant), timeZone);
		if (settled === offset) break;
		offset = settled;
		instant = wallMs - offset;
	}
	const exact = wallMsInZone(new Date(instant), timeZone) === wallMs;
	return { instant, exact };
}

export interface CronFields {
	minute: string;
	hour: string;
	day: string;
	month: string;
	weekday: string;
}

/** Split a normalized 5-field cron string. */
export function cronFields(expression: string): CronFields {
	const [minute, hour, day, month, weekday] = expression.split(" ");
	return { minute, hour, day, month, weekday };
}

/** Each field's bounds. Weekday allows 7, which is Sunday, the same as 0. */
export const CRON_FIELD_BOUNDS = { minute: [0, 59], hour: [0, 23], day: [1, 31], month: [1, 12], weekday: [0, 7] } as const;

const fieldCache = new Map<string, ReadonlySet<number> | null>();

/**
 * The values one cron field names within `[min, max]` (#1027): `*`, `n`, a range `a-b`, a step
 * `*\/s`, `a-b/s` or `n/s` (n through max), and comma lists of any of those, e.g. `22-23,0-6`.
 * Null when the field is malformed or out of range. A weekday 7 also names Sunday (0).
 */
export function cronFieldValues(part: string, min: number, max: number): ReadonlySet<number> | null {
	const key = `${part}|${min}|${max}`;
	if (fieldCache.has(key)) return fieldCache.get(key) ?? null;
	let out: Set<number> | null = new Set<number>();
	for (const item of part.split(",")) {
		const m = item.match(/^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
		if (!m) {
			out = null;
			break;
		}
		const lo = m[1] ? min : Number(m[2]);
		const hi = m[1] ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
		const step = m[4] !== undefined ? Number(m[4]) : 1;
		if (lo < min || hi > max || lo > hi || step < 1) {
			out = null;
			break;
		}
		for (let v = lo; v <= hi; v += step) out.add(v);
	}
	if (out && max === 7 && out.has(7)) out.add(0);
	fieldCache.set(key, out);
	return out;
}

/**
 * One cron field against one value, within that field's bounds (default: the minute field's).
 * Sunday-as-7 applies to the weekday field only: before #1027 it applied to EVERY field, so a
 * minute of `7` also matched minute 0 and "7 9 * * *" fired at 09:00 as well as 09:07.
 */
export function matchesCronField(part: string, value: number, min = 0, max = 59): boolean {
	if (part === "*") return true;
	return cronFieldValues(part, min, max)?.has(value) ?? false;
}

function matchesAll(fields: CronFields, wall: Date): boolean {
	const b = CRON_FIELD_BOUNDS;
	return (
		matchesCronField(fields.minute, wall.getUTCMinutes(), ...b.minute) &&
		matchesCronField(fields.hour, wall.getUTCHours(), ...b.hour) &&
		matchesCronField(fields.day, wall.getUTCDate(), ...b.day) &&
		matchesCronField(fields.month, wall.getUTCMonth() + 1, ...b.month) &&
		matchesCronField(fields.weekday, wall.getUTCDay(), ...b.weekday)
	);
}

const YEAR_MINUTES = 366 * 24 * 60;

/**
 * The next instant strictly after `from` at which the cron fields match the wall clock in
 * `timeZone`. Returns null when nothing matches within a year (e.g. 31 February).
 *
 * Pass "UTC" for the legacy behaviour — it is the same code path, which is the point: there is
 * one scheduler, not a UTC one and a timezone one that can disagree.
 */
export function nextCronInstant(fields: CronFields, from: Date, timeZone: string, limitMinutes = YEAR_MINUTES): number | null {
	const startWall = Math.floor(wallMsInZone(from, timeZone) / 60_000) * 60_000;
	const fromMs = from.getTime();
	for (let i = 1; i <= limitMinutes; i++) {
		const wallMs = startWall + i * 60_000;
		if (!matchesAll(fields, new Date(wallMs))) continue;
		const { instant } = resolveWallTime(wallMs, timeZone);
		// A fall-back repeat can resolve to an instant already behind us; keep walking so the
		// answer is always in the future (a next_run_at in the past fires immediately, forever).
		if (instant <= fromMs) continue;
		return instant;
	}
	return null;
}
