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
import type { ApplicationExecutionProjection, DirectiveDelivery, DirectiveReconciliation, ExecutionCheckpoint } from "./execution-projection.js";
/** One execution correlated to an application: which stage ran it, how it went, and where. */
export interface ApplicationCardExecution {
	runId: string;
	kind: "tailor" | "fill";
	status: string;
	/** The instance that executed it, so a deep link goes to the right agent's trace. */
	instanceId: string;
}

/**
 * An application's execution history, joined at READ time (#987).
 *
 * The card is one row per application forever (that dedup is #978's product model), so the generic
 * `attempts` — which counts card rows — reported `1` for an application with four correlated fill
 * runs. These are the runs themselves: how many, of which kind, the latest one's state, and the run
 * the card's own payload was written by. `runs` is bounded; `total` is not, so truncation cannot
 * understate the history.
 */
export interface ApplicationCardExecutions {
	total: number;
	fills: number;
	tailorings: number;
	runs: ApplicationCardExecution[];
	/** The newest execution, whatever stage ran it. */
	latest?: ApplicationCardExecution;
	/** The run this card's payload names (`runId`), when it still exists. */
	card?: ApplicationCardExecution;
}

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
	/**
	 * The application's correlated executions (#987), attached when the board reads the card — not
	 * stored, because a run changes state in four different writers and a stored copy would be the
	 * stale one. Absent on a card read from anywhere but the board.
	 */
	executions?: ApplicationCardExecutions;
	blockReason?: string;
	runnerVersion?: string;
	/** #988: exact redacted execution projection served by the application API. */
	execution?: ApplicationExecutionProjection;
}

function parseExecution(value: unknown): ApplicationExecutionProjection | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	const lifecycle = v.lifecycle && typeof v.lifecycle === "object" && !Array.isArray(v.lifecycle) ? (v.lifecycle as Record<string, unknown>) : null;
	const number = (input: unknown): number => (typeof input === "number" && Number.isFinite(input) && input > 0 ? Math.floor(input) : 0);
	const stateVersion = lifecycle?.stateVersion;
	if (v.schemaVersion !== 1 || !lifecycle || typeof lifecycle.status !== "string" || typeof stateVersion !== "number" || !Number.isInteger(stateVersion) || stateVersion < 0) return undefined;
	const actions = Array.isArray(v.permittedActions) ? v.permittedActions.filter((x): x is string => typeof x === "string") : [];
	const run = v.currentRun && typeof v.currentRun === "object" && !Array.isArray(v.currentRun) ? (v.currentRun as Record<string, unknown>) : null;
	const currentRun = run && typeof run.id === "string" && (run.kind === "tailor" || run.kind === "fill") && typeof run.status === "string" && typeof run.instanceId === "string"
		? { id: run.id, kind: run.kind, status: run.status, instanceId: run.instanceId, mode: typeof run.mode === "string" ? run.mode : null } as ApplicationExecutionProjection["currentRun"]
		: null;
	const cp = v.checkpoint && typeof v.checkpoint === "object" && !Array.isArray(v.checkpoint) ? (v.checkpoint as Record<string, unknown>) : null;
	const facts = cp?.facts && typeof cp.facts === "object" && !Array.isArray(cp.facts) ? (cp.facts as Record<string, unknown>) : null;
	const directive = cp?.directive && typeof cp.directive === "object" && !Array.isArray(cp.directive) ? (cp.directive as Record<string, unknown>) : null;
	const delivery = directive?.delivery;
	const checkpoint: ExecutionCheckpoint | null =
		cp && facts && typeof cp.id === "string" && (cp.phase === "initial" || cp.phase === "post_navigation" || cp.phase === "before_submit" || cp.phase === "uncertain")
			? {
				id: cp.id,
				phase: cp.phase,
				facts: { actions: number(facts.actions), filled: number(facts.filled), uploaded: number(facts.uploaded), blockers: Array.isArray(facts.blockers) ? facts.blockers.filter((x): x is string => typeof x === "string") : [], domain: typeof facts.domain === "string" ? facts.domain : null },
				directive:
					directive && (directive.kind === "continue" || directive.kind === "request_review" || directive.kind === "stop") && (delivery === "queued" || delivery === "delivery_attempted" || delivery === "delivered" || delivery === "acknowledged_by_runner")
						? { kind: directive.kind, delivery: delivery as DirectiveDelivery }
						: null,
			}
			: null;
	const p = v.progress && typeof v.progress === "object" && !Array.isArray(v.progress) ? (v.progress as Record<string, unknown>) : null;
	const progress: FillProgress | null = p && typeof p.stage === "string" && typeof p.label === "string"
		? { stage: p.stage as FillProgress["stage"], label: p.label, filled: number(p.filled), uploaded: number(p.uploaded), checkpointPhase: typeof p.checkpointPhase === "string" ? p.checkpointPhase : null, checkpointId: typeof p.checkpointId === "string" ? p.checkpointId : null, submitAttempted: p.submitAttempted === true, evidence: (p.evidence === "runner_result" || p.evidence === "runner_checkpoint" ? p.evidence : "run_status") as FillProgress["evidence"] }
		: null;
	const reconciliation = v.directiveReconciliation;
	if (!["not_applicable", "terminal", "decision_pending", "delivery_pending", "retry_pending", "acknowledged"].includes(String(reconciliation))) return undefined;
	return { schemaVersion: 1, lifecycle: { status: lifecycle.status, stateVersion, blockReason: typeof lifecycle.blockReason === "string" ? lifecycle.blockReason : null, submitAttempted: lifecycle.submitAttempted === true }, currentRun, checkpoint, progress, permittedActions: actions, directiveReconciliation: reconciliation as DirectiveReconciliation };
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
	const execution = parseExecution(a.execution);
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
		...(execution ? { execution } : {}),
	};
}
