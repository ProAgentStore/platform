/**
 * What an `application.run` board card carries (#978) — the shape alone, and how to read it back.
 *
 * A LEAF on purpose: it imports nothing. `lib/board.ts` is the generic board and must be able to
 * pass this field through without acquiring a dependency on the applications domain — which, when
 * it was imported directly, pulled `board.ts` into the domain's deliberate deferred-import cycle
 * (`application-board` → `control` → `tailor` → … → `board`). The writer and the reader therefore
 * share this definition rather than one importing the other.
 */
/** What an `application.run` card carries (#978), as the domain wrote it. */
export interface ApplicationCardPayload {
	applicationId: string;
	applicationStatus: string;
	stateVersion: number;
	actions: string[];
	kind: "tailor" | "fill";
	runId: string;
	stage: string;
	traceUrl: string;
	checkpoint?: { checkpointId: string; phase: string; directive: string | null };
	blockReason?: string;
	runnerVersion?: string;
}

/**
 * Read the application block off a card's payload, taking only what it declares.
 *
 * Validated rather than cast: the payload is JSON a past release wrote, so a card from before
 * #978 (or one whose shape has since moved) must read as "not an application card" instead of
 * handing the console a half-built object.
 */
export function parseApplicationCard(value: unknown): ApplicationCardPayload | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const a = value as Record<string, unknown>;
	const str = (v: unknown): string => (typeof v === "string" ? v : "");
	const applicationId = str(a.applicationId);
	const kind = a.kind === "tailor" || a.kind === "fill" ? a.kind : null;
	if (!applicationId || !kind) return undefined;
	const cp = a.checkpoint && typeof a.checkpoint === "object" && !Array.isArray(a.checkpoint) ? (a.checkpoint as Record<string, unknown>) : null;
	return {
		applicationId,
		applicationStatus: str(a.applicationStatus),
		stateVersion: typeof a.stateVersion === "number" && Number.isInteger(a.stateVersion) && a.stateVersion >= 0 ? a.stateVersion : 0,
		actions: (Array.isArray(a.actions) ? a.actions : []).filter((x): x is string => typeof x === "string"),
		kind,
		runId: str(a.runId),
		stage: str(a.stage),
		traceUrl: str(a.traceUrl),
		...(cp && str(cp.checkpointId) ? { checkpoint: { checkpointId: str(cp.checkpointId), phase: str(cp.phase), directive: typeof cp.directive === "string" ? cp.directive : null } } : {}),
		...(str(a.blockReason) ? { blockReason: str(a.blockReason) } : {}),
		...(str(a.runnerVersion) ? { runnerVersion: str(a.runnerVersion) } : {}),
	};
}

