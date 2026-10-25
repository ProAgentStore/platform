import { formatDuration } from "./runner-availability.js";

/**
 * The upper bound on a queued objective waiting for an offline runner (#1189).
 *
 * #1161 made an offline runner a reason to WAIT rather than fail, because the machine is usually asleep or away and its relay
 * reconnecting drains the queue. Waiting needs an end: a machine that never returns, or was never registered, would otherwise
 * hold its entries pending for ever with nobody told. The bound is the one a RUN parked on its machine gets (`RUNNER_PARK_MS`,
 * #1160) — a day — so a queued objective is never promised more patience than a running one.
 *
 * Kept apart from objective-queue.ts and objective-queue-start.ts so both can use it without one importing the other, and so a
 * test that replaces the queue store still sees the real bound.
 */
export const QUEUE_OFFLINE_MAX_MS = 24 * 60 * 60_000;

/** Whether an entry that began waiting on an offline runner at `offlineSince` has waited the whole bound. */
export function offlineWaitExpired(offlineSince: number | null | undefined, now: number): boolean {
	return typeof offlineSince === "number" && now - offlineSince >= QUEUE_OFFLINE_MAX_MS;
}

/** The sentence the entry fails with: what happened, the bound, and what to do. */
export function offlineWaitSentence(offlineSince: number, now: number): string {
	return `This objective waited ${formatDuration(Math.max(0, now - offlineSince))} for the runner to come back online, the longest a queued objective waits (${formatDuration(QUEUE_OFFLINE_MAX_MS)}), so it was not started. Start \`pags up\` on the machine (or pin the agent to one that is online), then queue it again.`;
}
