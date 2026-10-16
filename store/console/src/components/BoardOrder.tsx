/**
 * Reordering board cards (#1099): board order is run order (#1097), so the top of Waiting is what starts next.
 *
 * `useBoardOrder` moves a card optimistically and snaps it back with the server's reason when the move is
 * refused. Dragging uses POINTER events on a handle (`touch-action: none`), so it works with a finger as well
 * as a mouse, and only ever reorders within the card's column: a drop on a card in another column is
 * refused here, never turned into a status move — that stays the card's column select. Top / Up / Down
 * buttons do the same without dragging, for keyboards and small screens.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronUp, ChevronsUp, GripVertical } from "lucide-react";
import { type BoardPlace, type RunQueueMarker, applyPlace, dropPlace, neighbourPlace, postBoardOrder, runQueueLabel } from "../lib/boardOrder";

interface Card {
	jobKey: string;
	runQueue?: RunQueueMarker;
}

/** What one card's order controls need — built per card by `useBoardOrder`. */
export interface CardOrder {
	onTop?: () => void;
	onUp?: () => void;
	onDown?: () => void;
	onHandleDown: (e: ReactPointerEvent) => void;
	/** Where a card being dragged over this one would land. */
	dropSide: "before" | "after" | null;
	dragging: boolean;
}

export function useBoardOrder<T extends Card>(instanceId: string, items: T[], setItems: (items: T[]) => void, sameColumn: (a: T, b: T) => boolean, reload: () => void) {
	const [error, setError] = useState<string | null>(null);
	const [drag, setDrag] = useState<{ key: string; over: string | null; side: "before" | "after" } | null>(null);
	const latest = useRef(items);
	latest.current = items;

	const move = async (jobKey: string, place: BoardPlace) => {
		const before = latest.current;
		setError(null);
		setItems(applyPlace(before, jobKey, place, sameColumn));
		try {
			await postBoardOrder(instanceId, jobKey, place);
			reload();
		} catch (e) {
			setItems(before);
			setError(e instanceof Error ? e.message : "The board refused that move");
		}
	};

	/** The card under the pointer, if it is a board card. */
	const cardAt = (x: number, y: number) => {
		const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-board-card]");
		return el ? { key: el.dataset.boardCard as string, rect: el.getBoundingClientRect() } : null;
	};

	const startDrag = (jobKey: string) => (e: ReactPointerEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		let target: { key: string; side: "before" | "after" } | null = null;
		setDrag({ key: jobKey, over: null, side: "before" });
		const onMove = (ev: PointerEvent) => {
			const hit = cardAt(ev.clientX, ev.clientY);
			target = hit && hit.key !== jobKey ? { key: hit.key, side: "before" in dropPlace(hit.key, ev.clientY, hit.rect) ? "before" : "after" } : null;
			setDrag({ key: jobKey, over: target?.key ?? null, side: target?.side ?? "before" });
		};
		const onUp = () => {
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", onUp);
			handle.removeEventListener("pointercancel", onUp);
			setDrag(null);
			if (!target) return;
			const card = latest.current.find((i) => i.jobKey === jobKey);
			const over = latest.current.find((i) => i.jobKey === target?.key);
			if (!card || !over) return;
			if (!sameColumn(card, over)) {
				setError("Cards are reordered within their column — use the column menu to move a card to another column.");
				return;
			}
			void move(jobKey, target.side === "before" ? { before: target.key } : { after: target.key });
		};
		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", onUp);
		handle.addEventListener("pointercancel", onUp);
	};

	/** One card's controls: its column's neighbours decide whether Up / Down exist. */
	const orderFor = (item: T): CardOrder => {
		const column = latest.current.filter((i) => sameColumn(i, item));
		const up = neighbourPlace(column, item.jobKey, "up");
		const down = neighbourPlace(column, item.jobKey, "down");
		return {
			onTop: up ? () => void move(item.jobKey, { to: "top" }) : undefined,
			onUp: up ? () => void move(item.jobKey, up) : undefined,
			onDown: down ? () => void move(item.jobKey, down) : undefined,
			onHandleDown: startDrag(item.jobKey),
			dropSide: drag && drag.over === item.jobKey ? drag.side : null,
			dragging: drag?.key === item.jobKey,
		};
	};

	return { orderFor, error, clearError: () => setError(null) };
}

const iconButton = "w-6 h-6 flex items-center justify-center rounded text-muted hover:text-accent hover:bg-accent-soft disabled:opacity-30 disabled:hover:bg-transparent";

/** The order row on a card: the run marker, a drag handle and Top / Up / Down — plus the drop line while dragging. */
export function CardOrderBar({ item, order }: { item: Card; order?: CardOrder }) {
	const label = runQueueLabel(item.runQueue);
	if (!order) return null;
	return (
		<>
			{order.dropSide && <div aria-hidden className={`absolute left-1 right-1 h-0.5 bg-accent rounded ${order.dropSide === "before" ? "-top-1" : "-bottom-1"}`} />}
			<div className="flex items-center gap-1 mt-1.5 text-2xs">
				{label && (
					<span
						data-testid={`run-marker-${label.kind}`}
						className={`px-1.5 py-0.5 rounded font-semibold ${label.kind === "next" ? "bg-accent-soft text-accent" : label.kind === "never" ? "text-warning" : "text-muted"}`}
						title={label.text}
					>
						{label.text}
					</span>
				)}
				<span className="ml-auto flex items-center gap-0.5">
					<button type="button" aria-label="Drag to reorder" title="Drag to reorder within this column" onPointerDown={order.onHandleDown} className={`${iconButton} cursor-grab touch-none ${order.dragging ? "text-accent" : ""}`}>
						<GripVertical size={13} />
					</button>
					<button type="button" aria-label="Move to top" title="Move to top of this column" disabled={!order.onTop} onClick={(e) => { e.stopPropagation(); order.onTop?.(); }} className={iconButton}><ChevronsUp size={13} /></button>
					<button type="button" aria-label="Move up" title="Move up" disabled={!order.onUp} onClick={(e) => { e.stopPropagation(); order.onUp?.(); }} className={iconButton}><ChevronUp size={13} /></button>
					<button type="button" aria-label="Move down" title="Move down" disabled={!order.onDown} onClick={(e) => { e.stopPropagation(); order.onDown?.(); }} className={iconButton}><ChevronDown size={13} /></button>
				</span>
			</div>
		</>
	);
}
