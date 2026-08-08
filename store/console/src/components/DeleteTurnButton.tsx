import { useState } from "react";
import { Trash2, Loader2 } from "lucide-react";
import type { ChatMessageLike } from "@proagentstore/sdk/ui";
import { deleteTurnPrompt, turnEffectSummary, STOP_RUN_PROMPT } from "../lib/turnEffects";
import { deleteTurnRequest } from "../lib/deleteTurn";

/**
 * Delete ONE turn from the transcript (#342) — sibling of the copy button, same bubble corner.
 *
 * ── Why a confirmation and not an undo window
 *
 * This is a destructive action with no server-side undo, so the gate is BEFORE, not after. That is
 * the same call `delete_supervision` made (#328) and the same one Clear chat already makes, and it
 * is the right one here for a specific reason: the thing an undo window protects against is the
 * user not having meant it, and a toast can only help someone who is LOOKING. The voice trigger
 * (see `scrap` in the SDK's convo.ts) is used hands-free, by someone whose eyes are elsewhere — an
 * "undo" that expires in ten seconds is not a safety net for them, it is a formality. So the voice
 * path stages a turn and routes it through this same confirmation, and the button path — where the
 * user has pointed at one specific bubble — confirms once and deletes.
 *
 * The confirmation text is built in lib/turnEffects.ts, which is where the "what stays behind"
 * sentence lives and is tested.
 */
export default function DeleteTurnButton({
	instanceId,
	message,
	messages,
	runActive,
	onStopRun,
	onDeleted,
}: {
	instanceId: string;
	message: ChatMessageLike;
	/** The thread as rendered, so the confirmation can name what this turn ran. */
	messages: ChatMessageLike[];
	/** A loop/run is still going — deleting the transcript does not stop it, so offer. */
	runActive?: boolean;
	onStopRun?: () => void;
	/** The ids the SERVER removed. The console drops exactly those, rather than guessing the
	 *  span again — the two rules agree today and this is what keeps them agreeing. */
	onDeleted: (ids: string[]) => void;
}) {
	const [busy, setBusy] = useState(false);
	if (!message.id) return null; // nothing to address a delete to

	const run = async () => {
		if (busy || !message.id) return;
		if (!confirm(deleteTurnPrompt(turnEffectSummary(messages, message.id)))) return;
		setBusy(true);
		try {
			onDeleted(await deleteTurnRequest(instanceId, message.id));
			if (runActive && onStopRun && confirm(STOP_RUN_PROMPT)) onStopRun();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				void run();
			}}
			onDoubleClick={(e) => e.stopPropagation()}
			disabled={busy}
			title="Delete this turn"
			aria-label="Delete this turn"
			// `tap-target` gives this 44px of vertical reach without growing the box that sits ON
			// the message text (#389). Horizontal expansion is deliberately not available: Copy is
			// 2px to the right and later-painted overlays win the hit test, so a wide one here —
			// on the DESTRUCTIVE control — would swallow a third of it.
			className="tap-target absolute top-1 right-8 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-1 rounded bg-black/40 text-muted hover:text-red transition-opacity"
		>
			{busy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
		</button>
	);
}
