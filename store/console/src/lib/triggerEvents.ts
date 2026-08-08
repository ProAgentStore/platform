/**
 * Pure logic behind trigger run history (#19).
 *
 * `agent_trigger_events` has been written on every dispatch for a long time; the Settings UI
 * showed only the trigger's `last_error`, which answers "is it broken right now" and nothing
 * else. It could not answer the questions people actually have: did the webhook arrive at all,
 * did the 3am cron run, how many files did last night's sync import, why did the one before
 * that fail. The rows existed the whole time — only the reading of them was missing.
 *
 * The rules for turning a row into a sentence live here rather than in JSX because each one is
 * a judgement (a sync that imported 0 of 40 is not a failure but is not "fine" either), and a
 * judgement that can only be checked by clicking is a judgement nobody checks.
 */

export interface TriggerEvent {
	id: string;
	trigger_id?: string;
	/** "webhook" | "cron" | "manual" — how the run was started. */
	type: string;
	/** "received" | "running" | "succeeded" | "failed" */
	status: string;
	message?: string | null;
	payload?: string | null;
	error?: string | null;
	created_at: string;
}

export type Tone = "ok" | "warn" | "bad" | "idle";

export const TONE_CLASS: Record<Tone, string> = {
	ok: "border-success-line bg-success-soft text-success",
	warn: "border-warning-line bg-warning-soft text-warning",
	bad: "border-danger-line bg-danger-soft text-danger",
	idle: "border-line bg-panel text-muted",
};

export interface SyncCounts {
	scanned: number;
	imported: number;
	skipped: number;
	errors: string[];
}

export function parsePayload(raw: unknown): Record<string, unknown> | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	if (typeof raw !== "string") return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

/** Connector-sync numbers, or null when this event is not a sync result. */
export function syncCounts(raw: unknown): SyncCounts | null {
	const payload = parsePayload(raw);
	if (!payload) return null;
	const has = ["scanned", "imported", "skipped"].some((k) => typeof payload[k] === "number");
	if (!has) return null;
	const errors = Array.isArray(payload.errors) ? payload.errors.map((e) => String(e)) : [];
	return {
		scanned: num(payload.scanned),
		imported: num(payload.imported),
		skipped: num(payload.skipped),
		errors,
	};
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * How a single run should read. A sync that reported per-file errors is `warn` even though the
 * dispatch "succeeded" — the trigger worked and the import did not, which is exactly the state
 * a status column alone cannot express.
 */
export function eventTone(event: TriggerEvent): Tone {
	if (event.status === "failed") return "bad";
	if (event.status === "succeeded") {
		const counts = syncCounts(event.payload);
		if (counts?.errors.length) return "warn";
		return "ok";
	}
	if (event.status === "running") return "warn";
	return "idle";
}

const STATUS_LABEL: Record<string, string> = {
	received: "Received",
	running: "Running",
	succeeded: "Succeeded",
	failed: "Failed",
};

export function statusLabel(status: string): string {
	return STATUS_LABEL[status] || status;
}

const SOURCE_LABEL: Record<string, string> = {
	webhook: "Webhook",
	cron: "Schedule",
	manual: "Run now",
};

export function sourceLabel(type: string): string {
	return SOURCE_LABEL[type] || type;
}

/** One line saying what this run did, in preference order: the failure, the numbers, the message. */
export function eventHeadline(event: TriggerEvent): string {
	if (event.error) return event.error;
	const counts = syncCounts(event.payload);
	if (counts) {
		const parts = [`${counts.imported} imported`, `${counts.skipped} skipped`, `${counts.scanned} scanned`];
		if (counts.errors.length) parts.push(`${counts.errors.length} error${counts.errors.length === 1 ? "" : "s"}`);
		return parts.join(" · ");
	}
	if (event.message) return event.message;
	if (event.status === "received") return "Payload received, dispatching";
	return `${sourceLabel(event.type)} run ${statusLabel(event.status).toLowerCase()}`;
}

/**
 * A payload rendered for a human, bounded. Webhook payloads are attacker-influenced and can be
 * 16KB, so this both truncates and pretty-prints — an unbounded dump would let one noisy
 * webhook make the whole history unreadable.
 */
export function truncatePayload(raw: unknown, max = 600): string {
	if (raw === null || raw === undefined) return "";
	let text: string;
	const parsed = parsePayload(raw);
	if (parsed) {
		try {
			text = JSON.stringify(parsed, null, 2);
		} catch {
			text = String(raw);
		}
	} else {
		text = typeof raw === "string" ? raw : String(raw);
	}
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n… ${text.length - max} more characters`;
}

export interface EventTally {
	total: number;
	succeeded: number;
	failed: number;
	running: number;
	received: number;
}

export function tallyEvents(events: TriggerEvent[]): EventTally {
	const tally: EventTally = { total: events.length, succeeded: 0, failed: 0, running: 0, received: 0 };
	for (const e of events) {
		if (e.status === "succeeded") tally.succeeded++;
		else if (e.status === "failed") tally.failed++;
		else if (e.status === "running") tally.running++;
		else if (e.status === "received") tally.received++;
	}
	return tally;
}

/**
 * The one-line health of a trigger, from its history. "Never run" is called out as its own
 * state: a webhook nobody has ever POSTed to and a webhook that works look identical in a list
 * of definitions, and they are very different problems.
 */
export function historyHeadline(events: TriggerEvent[]): { tone: Tone; text: string } {
	if (!events.length) return { tone: "idle", text: "Never run" };
	const tally = tallyEvents(events);
	const latest = events[0];
	if (latest.status === "failed") return { tone: "bad", text: `Last run failed — ${eventHeadline(latest)}` };
	if (latest.status === "running") return { tone: "warn", text: "Running now" };
	if (tally.failed) return { tone: "warn", text: `Last run OK · ${tally.failed} of the last ${tally.total} failed` };
	return { tone: "ok", text: `Last ${tally.total} run${tally.total === 1 ? "" : "s"} OK` };
}
