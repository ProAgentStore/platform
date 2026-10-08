/**
 * What an `application.run` board card carries (#978) — the shape alone, and how to read it back.
 *
 * A LEAF on purpose: it imports nothing. `lib/board.ts` is the generic board and must be able to
 * pass this field through without acquiring a dependency on the applications domain — which, when
 * it was imported directly, pulled `board.ts` into the domain's deliberate deferred-import cycle
 * (`application-board` → `control` → `tailor` → … → `board`). The writer and the reader therefore
 * share this definition rather than one importing the other.
 *
 * The one import is a TYPE import of `fill-progress.ts`, which itself imports nothing and is erased
 * at build — so the leaf property holds: nothing is added to anybody's runtime graph.
 */
import type { FillProgress } from "./fill-progress.js";
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
	/**
	 * How far a fill actually got, from the runner's own facts (#986) — the SAME object the
	 * Applications/Data queue item carries. On the card because `stage` is a sentence: a reader that
	 * wants to decide something (a supervisor, the console's review affordance) needs the counts the
	 * sentence was written from, not a regex over it.
	 */
	progress?: FillProgress;
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
	const p = a.progress && typeof a.progress === "object" && !Array.isArray(a.progress) ? (a.progress as Record<string, unknown>) : null;
	const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
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
		...(p && str(p.stage) && str(p.label)
			? {
				progress: {
					stage: p.stage as FillProgress["stage"],
					label: str(p.label),
					filled: n(p.filled),
					uploaded: n(p.uploaded),
					checkpointPhase: typeof p.checkpointPhase === "string" ? p.checkpointPhase : null,
					checkpointId: typeof p.checkpointId === "string" ? p.checkpointId : null,
					submitAttempted: p.submitAttempted === true,
					evidence: p.evidence === "runner_result" || p.evidence === "runner_checkpoint" ? p.evidence : "run_status",
				},
			}
			: {}),
		...(str(a.blockReason) ? { blockReason: str(a.blockReason) } : {}),
		...(str(a.runnerVersion) ? { runnerVersion: str(a.runnerVersion) } : {}),
	};
}

