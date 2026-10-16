/**
 * Place a card in its column (#1097) — `POST /v1/instances/:id/board/order`, MCP `reorder_board_item` and
 * `coding_loop_queue_reorder`. The order it writes is the order both drains start Waiting cards in.
 *
 * Positions are fractional: before or after a card is the midpoint of its neighbours, `top` is the column's
 * smallest minus one, `bottom` clears the place (back to "never placed": after the placed cards, oldest
 * first — the append default). Placing next to a never-placed card first gives the cards up to it their
 * current places, so the midpoint exists and nothing visibly moves but the card. One owner's board is a
 * handful of cards per column, so that is a few writes, in one batch.
 */
import { type BoardColumn, columnForStatus } from "./agent-capabilities.js";
import { HttpError } from "./auth.js";
import { type BoardItemView, buildInstanceBoard } from "./board.js";
import { assertJobKey } from "./write-limits.js";
import type { Env } from "../types.js";

export type BoardPlace = { before: string } | { after: string } | { to: "top" | "bottom" };

/** Below this gap a midpoint is no longer a distinct REAL: the column is renumbered first. */
const MIN_GAP = 1e-9;

/** Read a place from a request body: exactly one of `before`, `after`, `to`. */
export function parseBoardPlace(body: Record<string, unknown>): BoardPlace | { error: string } {
	const given = (["before", "after", "to"] as const).filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== "");
	if (given.length !== 1) return { error: "give exactly one of before, after or to" };
	if (given[0] === "to") return body.to === "top" || body.to === "bottom" ? { to: body.to } : { error: "to must be top or bottom" };
	const ref = body[given[0]];
	if (typeof ref !== "string" || ref.length > 400) return { error: `${given[0]} must be a card's jobKey` };
	return given[0] === "before" ? { before: ref } : { after: ref };
}

/** The cards of `column`, in board order. */
const columnCards = (board: { columns: BoardColumn[]; items: BoardItemView[] }, column: BoardColumn) => board.items.filter((i) => columnForStatus(board.columns, i.status)?.id === column.id);

/** Put `jobKey` at `place` in its column. Answers with that column in its new order. */
export async function reorderBoardItem(env: Env, instanceId: string, userId: string, jobKey: string, place: BoardPlace): Promise<{ column: BoardColumn; items: BoardItemView[] }> {
	assertJobKey(jobKey);
	const board = await buildInstanceBoard(env, instanceId, userId);
	const card = board.items.find((i) => i.jobKey === jobKey);
	if (!card) throw new HttpError(404, `No card ${jobKey} on this board`);
	const column = columnForStatus(board.columns, card.status);
	if (!column) throw new HttpError(409, `The card ${jobKey} is not in any column (status ${card.status})`);
	const others = columnCards(board, column).filter((i) => i.jobKey !== jobKey);

	const writes = new Map<string, number | null>();
	const pos = (i: BoardItemView) => (writes.has(i.jobKey) ? writes.get(i.jobKey) : i.position) ?? null;
	let position: number | null;
	if ("to" in place) {
		const placed = others.map(pos).filter((p): p is number => p !== null);
		position = place.to === "bottom" ? null : placed.length ? Math.min(...placed) - 1 : 0;
	} else {
		const refKey = "before" in place ? place.before : place.after;
		if (refKey === jobKey) throw new HttpError(400, "A card cannot be placed next to itself");
		const ref = others.find((i) => i.jobKey === refKey);
		if (!ref) {
			const elsewhere = board.items.find((i) => i.jobKey === refKey);
			if (!elsewhere) throw new HttpError(404, `No card ${refKey} on this board`);
			throw new HttpError(409, `${refKey} is in another column (${columnForStatus(board.columns, elsewhere.status)?.title ?? elsewhere.status}) than ${jobKey} (${column.title}) — move the card first`);
		}
		const idx = others.indexOf(ref);
		const settle = (renumber: boolean) => {
			// Give every card up to the reference a place — its current one, or the next free number.
			let last: number | null = null;
			for (const [i, c] of others.slice(0, idx + 1).entries()) {
				const p = renumber ? i + 1 : pos(c);
				const want: number = p ?? (last ?? 0) + 1;
				if (want !== c.position) writes.set(c.jobKey, want);
				last = want;
			}
			const at = pos(ref) as number;
			if ("before" in place) {
				const lo = idx > 0 ? (pos(others[idx - 1]) as number) : at - 1;
				return { lo, hi: at };
			}
			const next = others[idx + 1] ? pos(others[idx + 1]) : null;
			return { lo: at, hi: next ?? at + 1 };
		};
		let gap = settle(false);
		if (gap.hi - gap.lo < MIN_GAP) gap = settle(true);
		position = (gap.lo + gap.hi) / 2;
	}
	writes.set(jobKey, position);

	await env.DB.batch(
		[...writes].map(([key, p]) =>
			// A card with no overlay row gets one that carries only its place: no status override.
			env.DB.prepare(
				`INSERT INTO board_items (instance_id, user_id, job_key, user_status, title, subtitle, url, position)
				 VALUES (?1, ?2, ?3, NULL, '', '', '', ?4)
				 ON CONFLICT(instance_id, user_id, job_key) DO UPDATE SET position = excluded.position`,
			).bind(instanceId, userId, key, p),
		),
	);
	const after = await buildInstanceBoard(env, instanceId, userId);
	return { column, items: columnCards(after, column) };
}
