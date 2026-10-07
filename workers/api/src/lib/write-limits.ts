import { HttpError } from "./auth.js";

/**
 * Refuse, don't slice, on write (#898).
 *
 * A value stored shorter than it was sent is a write that reported success and kept something
 * else: a ticket's description lost its acceptance criteria, an instruction lost its last rule, and
 * the caller — often an agent — was told `ok`. So a field over its limit is REFUSED, naming the
 * field, its length and the limit, so the caller can shorten or split it in one try. Nothing is
 * written. The operator manual has worked this way since #854; this is the same rule for the rest.
 */
export function overLimit(fields: Record<string, readonly [value: unknown, max: number]>): string | null {
	for (const [name, [value, max]] of Object.entries(fields)) {
		if (typeof value === "string" && value.length > max) {
			return `\`${name}\` is ${value.length.toLocaleString("en-US")} characters; the limit is ${max.toLocaleString("en-US")}. Shorten it (or split it) and send it again — nothing was saved.`;
		}
	}
	return null;
}

/** A ticket's text fields and their limits — one table for every path that writes a ticket. */
export const TICKET_LIMITS = { title: 200, description: 2000, reasoning: 8000 } as const;

/** {@link overLimit} over a ticket's fields as sent. */
export function ticketOverLimit(input: { title?: unknown; description?: unknown; reasoning?: unknown }): string | null {
	return overLimit({
		title: [input.title, TICKET_LIMITS.title],
		description: [input.description, TICKET_LIMITS.description],
		reasoning: [input.reasoning, TICKET_LIMITS.reasoning],
	});
}

/** A board card's key. An ID, so it is never cut: two keys cut to one would silently become one card. */
export const JOB_KEY_MAX = 400;

/** Throws a 400 for a job key past {@link JOB_KEY_MAX} — every writer keyed by one calls this (#898). */
export function assertJobKey(jobKey: string): void {
	const tooLong = overLimit({ jobKey: [jobKey, JOB_KEY_MAX] });
	if (tooLong) throw new HttpError(400, tooLong);
}
