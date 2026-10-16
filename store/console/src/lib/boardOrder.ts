/**
 * Board order is run order (#1097, console half #1099). Pure helpers the board's reorder controls share:
 * where a card lands, which neighbour Up/Down places it against, and what a Waiting card's run marker says.
 *
 * The server owns the order (`POST /v1/instances/:id/board/order`, `workers/api/src/lib/board-reorder.ts`);
 * these only predict it for the optimistic move, and the next board read is the truth.
 */
import { api } from "@proagentstore/sdk/client";

/** Exactly one of these — the route's body minus `jobKey`. */
export type BoardPlace = { before: string } | { after: string } | { to: "top" | "bottom" };

/** A Waiting card's run marker, as the board API sends it (`runQueue`). */
export type RunQueueMarker = { queue: "objective" | "ticket"; next: boolean } | { queue: null; reason: string };

interface Orderable {
	jobKey: string;
}

/**
 * The board with `jobKey` moved to `place`, as the server will order it. `sameColumn` says whether two
 * cards share a column: the list is the whole board, and a card only ever moves within its own column.
 * Returns the input unchanged when the card or its reference is not there (the server will say why).
 */
export function applyPlace<T extends Orderable>(items: readonly T[], jobKey: string, place: BoardPlace, sameColumn: (a: T, b: T) => boolean): T[] {
	const card = items.find((i) => i.jobKey === jobKey);
	if (!card) return [...items];
	const rest = items.filter((i) => i.jobKey !== jobKey);
	let at: number;
	if ("to" in place) {
		const column = rest.filter((i) => sameColumn(i, card));
		if (!column.length) return [...items];
		const anchor = place.to === "top" ? column[0] : column[column.length - 1];
		at = rest.indexOf(anchor) + (place.to === "top" ? 0 : 1);
	} else {
		const ref = rest.find((i) => i.jobKey === ("before" in place ? place.before : place.after));
		if (!ref || !sameColumn(ref, card)) return [...items];
		at = rest.indexOf(ref) + ("before" in place ? 0 : 1);
	}
	return [...rest.slice(0, at), card, ...rest.slice(at)];
}

/** Up / Down within a column: placed against the neighbour in that direction, or null at the edge. */
export function neighbourPlace(column: readonly Orderable[], jobKey: string, dir: "up" | "down"): BoardPlace | null {
	const i = column.findIndex((c) => c.jobKey === jobKey);
	if (i < 0) return null;
	if (dir === "up") return i > 0 ? { before: column[i - 1].jobKey } : null;
	return i < column.length - 1 ? { after: column[i + 1].jobKey } : null;
}

/** A drop on a card: before it in its upper half, after it in its lower half. */
export function dropPlace(targetKey: string, pointerY: number, rect: { top: number; height: number }): BoardPlace {
	return pointerY < rect.top + rect.height / 2 ? { before: targetKey } : { after: targetKey };
}

const NEVER: Record<string, string> = {
	human_authority: "a person has to release it to the queue",
	ticket_queue_off: "the ticket queue is off",
	picked: "it is already being started",
	needs_approval: "it waits for your approval",
	not_queued: "nothing queues it",
};

/** What a Waiting card's marker says: next to run, queued, or why nothing will start it. Null off Waiting. */
export function runQueueLabel(marker: RunQueueMarker | undefined): { kind: "next" | "queued" | "never"; text: string } | null {
	if (!marker) return null;
	if (marker.queue) return marker.next ? { kind: "next", text: "Next to run" } : { kind: "queued", text: `Queued (${marker.queue})` };
	return { kind: "never", text: `Won't start by itself — ${NEVER[marker.reason] ?? marker.reason.replace(/_/g, " ")}` };
}

/** Place `jobKey` on the server. Throws the server's reason (404 not on the board, 409 another column). */
export function postBoardOrder(instanceId: string, jobKey: string, place: BoardPlace): Promise<unknown> {
	return api(`/v1/instances/${instanceId}/board/order`, { method: "POST", body: JSON.stringify({ jobKey, ...place }) });
}

/** A queued objective's card key — what "Run next" places (`objective:<entry id>`). */
export const objectiveCardKey = (entryId: string): string => `objective:${entryId}`;
