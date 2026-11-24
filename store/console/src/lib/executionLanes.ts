/**
 * The four execution lanes of the instance board (#1698), as the console shows them.
 *
 * The SERVER classifies every card (`workers/api/src/lib/board-projection.ts`, `classifyCard`: the one rule every board shares) and
 * `GET /v1/instances/:id/board/projection` returns each card's `lane`. This module only groups by that field, labels, and links: it
 * never re-derives a lane, a badge or an owner from a native status, so the per-instance board and an All Agents view cannot disagree.
 */
export const EXECUTION_LANES = [
	{ id: "queued", title: "Queued", color: "#eab308" },
	{ id: "in_progress", title: "In Progress", color: "#3b82f6" },
	{ id: "blocked", title: "Blocked", color: "#f97316" },
	{ id: "done", title: "Done", color: "#22c55e" },
] as const;

export type ExecutionLaneId = (typeof EXECUTION_LANES)[number]["id"];
export type ExecutionKind = "coding-session" | "scan" | "application-attempt" | "queued-objective";
export type ExecutionOutcome = "succeeded" | "failed" | "stopped";
export type NextOwner = "owner" | "run" | "platform";

/** The fields of a projected card the console reads (`ProjectedCard` in the API). */
export interface ExecutionCard {
	cardId: string;
	kind: ExecutionKind;
	lane: ExecutionLaneId;
	needsYou: boolean;
	waitingToResume: boolean;
	blocker?: { what: string; nextOwner: NextOwner };
	outcome?: ExecutionOutcome;
	nativeStatus: string;
	title: string;
	updatedAt: number;
	native: { status: string; runId?: string | null; sessionId?: string | null; runKind?: "fill" | "tailor"; applicationId?: string; queueEntryId?: string | null };
}

export interface ExecutionProjection {
	lanes: Array<{ id: ExecutionLaneId; title: string }>;
	cards: ExecutionCard[];
}

/** Cards grouped by the lane the server gave them, newest first within a lane. A card is never moved by anything here. */
export function groupExecutionCards<T extends { lane: ExecutionLaneId; updatedAt: number }>(cards: readonly T[]): Record<ExecutionLaneId, T[]> {
	const out: Record<ExecutionLaneId, T[]> = { queued: [], in_progress: [], blocked: [], done: [] };
	for (const c of cards) if (out[c.lane]) out[c.lane].push(c);
	for (const lane of EXECUTION_LANES) out[lane.id].sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

/** Run in general; Session for a resumable coding session (the product vocabulary). */
export const KIND_LABEL: Record<ExecutionKind, string> = {
	"coding-session": "Session",
	scan: "Scan run",
	"application-attempt": "Application run",
	"queued-objective": "Queued objective",
};

export function kindLabel(card: Pick<ExecutionCard, "kind" | "native">): string {
	return card.kind === "application-attempt" && card.native.runKind === "tailor" ? "Tailor run" : KIND_LABEL[card.kind];
}

export const OUTCOME_LABEL: Record<ExecutionOutcome, string> = { succeeded: "Succeeded", failed: "Failed", stopped: "Stopped" };

/** Who acts next, in the owner's words. */
export const OWNER_LABEL: Record<NextOwner, string> = { owner: "you", run: "the run", platform: "ProAgentStore" };

/** Where the card opens, or null when it has no page of its own (a queued objective has no session yet). */
export function cardHref(instanceId: string, card: Pick<ExecutionCard, "kind" | "native">): string | null {
	const id = encodeURIComponent(instanceId);
	switch (card.kind) {
		case "coding-session":
			return card.native.sessionId ? `/instances/${id}/coding/${encodeURIComponent(card.native.sessionId)}` : null;
		case "application-attempt":
			return card.native.applicationId ? `/instances/${id}/applications/${encodeURIComponent(card.native.applicationId)}` : null;
		case "scan":
			return card.native.runId ? `/instances/${id}/research/${encodeURIComponent(card.native.runId)}` : null;
		case "queued-objective":
			return null;
	}
}
