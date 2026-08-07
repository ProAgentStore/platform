import { useCallback, type RefObject } from "react";
import { api } from "@proagentstore/sdk/client";
import type { Message } from "./types";
import { scrapPreviewPrompt, turnEffectSummary } from "./turnEffects";

/**
 * The one request that deletes a turn, and the "scrap that" voice trigger that also uses it (#342).
 *
 * Both triggers go through the SAME call and the SAME confirmation shape on purpose. Building them
 * separately would produce two delete paths that disagree about what a turn is — the reasoning
 * that made #277 ("next") and #279 (transfer) share one switch primitive.
 */

/** Delete the turn containing `messageId`. Resolves to the ids the SERVER removed. */
export async function deleteTurnRequest(instanceId: string, messageId: string): Promise<string[]> {
	const res = await api<{ ids?: string[] }>(
		`/v1/instances/${instanceId}/messages/${encodeURIComponent(messageId)}`,
		{ method: "DELETE" },
	);
	return res.ids?.length ? res.ids : [messageId];
}

/**
 * "Scrap that" — stage a delete of the MOST RECENT turn, confirm it, then delete.
 *
 * ── Three deliberate narrowings, all for the same reason
 *
 * This is the first destructive voice command in the product. Everything else in that vocabulary
 * is recoverable — mute, repeat, switch agent — so a mis-hear costs a moment. So:
 *
 *   1. It targets the LAST turn only, never an arbitrary one. There is no reliable way to say
 *      "the one before that" out loud, and a command that can reach anywhere in the transcript
 *      needs to be right about a much larger set of things.
 *   2. It CONFIRMS, and the confirmation quotes the turn. The gate is before, not after: an undo
 *      toast only helps someone who is watching, and hands-free — the mode this command exists
 *      for — is precisely when they are not.
 *   3. Nothing happens if the last turn has no id (an optimistic bubble not yet acknowledged by
 *      the server). Deleting the turn before it would be worse than doing nothing.
 *
 * Reads the thread through a ref because the handler is installed once, at hook construction, and
 * must always see the CURRENT last turn rather than the one that was last at mount.
 */
export function useScrapLastTurn(opts: {
	instanceId?: string;
	messagesRef: RefObject<Message[]>;
	onDeleted: (ids: string[]) => void;
}): () => void {
	const { instanceId, messagesRef, onDeleted } = opts;
	return useCallback(() => {
		void (async () => {
			if (!instanceId) return;
			const messages = messagesRef.current || [];
			const last = [...messages].reverse().find((m) => m.role === "user" && m.id);
			if (!last?.id) {
				alert("Nothing to scrap — there is no turn of yours in this conversation yet.");
				return;
			}
			if (!confirm(scrapPreviewPrompt(last.content || "", turnEffectSummary(messages, last.id)))) return;
			try {
				onDeleted(await deleteTurnRequest(instanceId, last.id));
			} catch (e) {
				alert(e instanceof Error ? e.message : String(e));
			}
		})();
	}, [instanceId, messagesRef, onDeleted]);
}
