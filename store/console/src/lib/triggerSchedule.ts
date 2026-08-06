/**
 * Pure logic behind the trigger schedule editor (#18).
 *
 * Note what is NOT here: the next-run calculation. That deliberately stays on the server
 * (`POST /v1/triggers/preview`), because a preview computed in the browser would be a second
 * scheduler, and on the day the two disagree the console would confidently show a time at which
 * nothing happens. A preview that lies is worse than no preview, so the only honest source for
 * "when will this run" is the code that actually runs it.
 *
 * What IS here is everything that can be decided without knowing the calendar: turning the
 * preset controls into the schedule string the API accepts, reading an existing schedule back
 * into those controls, and describing a schedule in a sentence.
 */

export type ScheduleMode = "hourly" | "daily" | "weekly" | "interval" | "cron";

export interface ScheduleDraft {
	mode: ScheduleMode;
	/** "HH:MM", the wall-clock time in the chosen zone. Used by daily + weekly. */
	time: string;
	/** 0 = Sunday. Used by weekly. */
	weekday: number;
	/** Used by interval. */
	every: string;
	unit: "minutes" | "hours";
	/** Used by cron (the escape hatch for anything the presets can't say). */
	cron: string;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const DEFAULT_SCHEDULE_DRAFT: ScheduleDraft = {
	mode: "daily",
	time: "08:00",
	weekday: 1,
	every: "30",
	unit: "minutes",
	cron: "0 8 * * *",
};

/** The browser's own zone — the right default, because it is the clock the user is reading. */
export function browserTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

function parseTime(value: string): { hour: number; minute: number } | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!m) return null;
	const hour = Number(m[1]);
	const minute = Number(m[2]);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
	return { hour, minute };
}

/**
 * The schedule string for a draft, or the reason it can't be built.
 *
 * The floors mirror the server's (`normalizeSchedule`): 5 minutes minimum, 31 days maximum.
 * Duplicated on purpose — the server still enforces them, this only spares the user a round
 * trip to be told something the form already knew.
 */
export function buildSchedule(draft: ScheduleDraft): { schedule: string } | { error: string } {
	if (draft.mode === "hourly") return { schedule: "@hourly" };
	if (draft.mode === "cron") {
		const cron = draft.cron.trim();
		if (!cron) return { error: "Enter a cron expression." };
		return { schedule: cron };
	}
	if (draft.mode === "interval") {
		const n = Number(draft.every);
		if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return { error: "Enter a whole number of minutes or hours." };
		const minutes = draft.unit === "hours" ? n * 60 : n;
		if (minutes < 5) return { error: "The shortest interval is 5 minutes." };
		if (minutes > 31 * 24 * 60) return { error: "The longest interval is 31 days." };
		return { schedule: `every ${n} ${draft.unit}` };
	}
	const at = parseTime(draft.time);
	if (!at) return { error: "Enter a time as HH:MM, e.g. 08:00." };
	if (draft.mode === "daily") return { schedule: `${at.minute} ${at.hour} * * *` };
	const weekday = Number(draft.weekday);
	if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: "Pick a day of the week." };
	return { schedule: `${at.minute} ${at.hour} * * ${weekday}` };
}

/** Read a stored schedule back into the editor's controls, so editing shows what exists. */
export function parseScheduleToDraft(schedule: string | null | undefined): ScheduleDraft {
	const raw = (schedule || "").trim().toLowerCase();
	if (!raw) return { ...DEFAULT_SCHEDULE_DRAFT };
	if (raw === "@hourly") return { ...DEFAULT_SCHEDULE_DRAFT, mode: "hourly" };
	if (raw === "@daily") return { ...DEFAULT_SCHEDULE_DRAFT, mode: "daily", time: "00:00" };
	if (raw === "@weekly") return { ...DEFAULT_SCHEDULE_DRAFT, mode: "weekly", time: "00:00", weekday: 0 };
	const every = /^every\s+(\d+)\s*(minutes?|mins?|m|hours?|h)$/.exec(raw);
	if (every) {
		const unit = every[2].startsWith("h") ? "hours" : "minutes";
		return { ...DEFAULT_SCHEDULE_DRAFT, mode: "interval", every: every[1], unit };
	}
	const parts = raw.split(/\s+/);
	if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && parts[2] === "*" && parts[3] === "*") {
		const time = `${String(Number(parts[1])).padStart(2, "0")}:${String(Number(parts[0])).padStart(2, "0")}`;
		if (parts[4] === "*") return { ...DEFAULT_SCHEDULE_DRAFT, mode: "daily", time, cron: raw };
		if (/^[0-7]$/.test(parts[4])) {
			return { ...DEFAULT_SCHEDULE_DRAFT, mode: "weekly", time, weekday: Number(parts[4]) % 7, cron: raw };
		}
	}
	return { ...DEFAULT_SCHEDULE_DRAFT, mode: "cron", cron: raw };
}

/** A schedule as a sentence, including the zone when the schedule has a wall clock at all. */
export function describeSchedule(schedule: string | null | undefined, timezone?: string | null): string {
	const raw = (schedule || "").trim();
	if (!raw) return "No schedule";
	const draft = parseScheduleToDraft(raw);
	const zone = timezone ? ` (${timezone})` : " (UTC)";
	if (draft.mode === "hourly") return "Every hour";
	if (draft.mode === "interval") return `Every ${draft.every} ${draft.unit}`;
	if (draft.mode === "daily") return `Daily at ${draft.time}${zone}`;
	if (draft.mode === "weekly") return `Every ${WEEKDAYS[draft.weekday]} at ${draft.time}${zone}`;
	return `${raw}${zone}`;
}

/** True when the zone actually affects this schedule — an interval has no wall clock to be in. */
export function scheduleUsesWallClock(schedule: string | null | undefined): boolean {
	const mode = parseScheduleToDraft(schedule).mode;
	return mode === "daily" || mode === "weekly" || mode === "cron";
}

/**
 * One run time, shown twice: in the schedule's own zone and in UTC. Both, always — the local
 * time is what the user asked for and the UTC one is what the row in the database says, and a
 * timezone bug is only ever visible when you can see the two side by side.
 */
export function formatRun(iso: string, timezone: string | null | undefined, locale = "en-AU"): { local: string; utc: string; zone: string } {
	const date = new Date(iso);
	const zone = timezone || "UTC";
	return {
		local: formatIn(date, zone, locale),
		utc: formatIn(date, "UTC", locale),
		zone,
	};
}

function formatIn(date: Date, timeZone: string, locale: string): string {
	if (Number.isNaN(date.getTime())) return "—";
	try {
		return new Intl.DateTimeFormat(locale, {
			timeZone,
			weekday: "short",
			day: "2-digit",
			month: "short",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).format(date);
	} catch {
		return date.toISOString();
	}
}

/** "in 3 hours" / "in 12 minutes" — the number people actually check a preview for. */
export function countdownTo(iso: string, now = Date.now()): string {
	const ms = Date.parse(iso) - now;
	if (!Number.isFinite(ms)) return "";
	if (ms <= 0) return "due now";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `in ${minutes} min`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `in ${hours} h`;
	return `in ${Math.round(hours / 24)} days`;
}
