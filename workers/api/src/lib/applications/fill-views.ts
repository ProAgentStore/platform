/**
 * The two views of a fill run that come off its own row: the #975 diagnostic and the #986 progress.
 *
 * The pure/store split this directory already uses (`work-queue.ts` / `work-queue-store.ts`):
 * `fill-progress.ts` decides WHAT a set of facts means, and this file is the one read that gets
 * them. ONE read for both views, because both are projections of the same stored record — `result`
 * for what the run measured, `pause` for where it is parked, and the supervisor store for the
 * checkpoint it is parked at.
 *
 * Deliberately NOT restricted to open runs the way the queue's `openRuns` is: a TERMINAL
 * `awaiting_review` run is precisely the case #986 is about, and reading only open runs is what
 * left the card with nothing but the application's status word to go on — which is how an
 * application whose runner reported `filled: 0, uploaded: 0` came to be described as a filled form
 * waiting to be approved and sent.
 */
import { type FillProgress, fillProgressOf } from "./fill-progress.js";
import type { ExecutionCheckpoint } from "./execution-projection.js";
import type { JobApplication } from "../local-artifact/store.js";
import type { Env } from "../../types.js";

/** Why nothing reached the page (#975): the structured cause, the counts that prove it, the signals. */
export interface RunDiagnostic {
	cause: string;
	bridgeCalls: number;
	engineExit: number;
	activeMs: number;
	pages: number;
	filled: number;
	signals: string[];
}

export interface FillViews {
	diagnostic: RunDiagnostic | null;
	progress: FillProgress | null;
	/** Latest durable, redacted supervisor state. Never exposes raw page/runner payloads. */
	checkpoint: ExecutionCheckpoint | null;
	runStatus: string | null;
}

export const NO_FILL_VIEWS: FillViews = { diagnostic: null, progress: null, checkpoint: null, runStatus: null };

/** A D1 text column that holds an object, or nothing readable. A corrupted row is not an error. */
function parse(raw: string | null | undefined): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export async function readFillViews(env: Pick<Env, "DB">, uid: string, app: Pick<JobApplication, "fillRunId" | "status" | "submitAttemptedAt" | "blockReason">): Promise<FillViews> {
	if (!app.fillRunId) return NO_FILL_VIEWS;
	const row = await env.DB.prepare("SELECT status, pause, result, trace FROM local_apply_runs WHERE id = ?1 AND user_id = ?2")
		.bind(app.fillRunId, uid)
		.first<{ status: string; pause: string | null; result: string | null; trace: string | null }>()
		.catch(() => null);
	if (!row) return NO_FILL_VIEWS;
	const result = parse(row.result);
	const pause = parse(row.pause);
	// The supervisor store is the authoritative record of what the runner measured at a checkpoint.
	// The pause carries a copy, but only when the checkpoint resolved at pause time, and a sentence
	// that says "nothing has been entered yet" must not rest on a copy that went missing.
	const cp =
		row.status === "paused" && pause?.reason === "supervisor_checkpoint"
			? await env.DB.prepare(
				`SELECT c.checkpoint_id, c.facts, d.directive, d.delivery_attempted_at, d.delivered_at
				   FROM local_apply_supervisor_checkpoints c
				   LEFT JOIN local_apply_supervisor_directives d ON d.run_id = c.run_id AND d.checkpoint_id = c.checkpoint_id
				  WHERE c.run_id = ?1 AND c.user_id = ?2
				  ORDER BY c.received_at DESC, c.runner_seq DESC LIMIT 1`,
			)
					.bind(app.fillRunId, uid)
					.first<{ checkpoint_id: string; facts: string | null; directive: string | null; delivery_attempted_at: number | null; delivered_at: number | null }>()
					.catch(() => null)
			: null;
	const facts = cp ? parse(cp.facts) : null;
	const phase = facts?.phase === "initial" || facts?.phase === "post_navigation" || facts?.phase === "before_submit" || facts?.phase === "uncertain" ? facts.phase : "uncertain";
	let trace: unknown = null;
	try {
		trace = row.trace ? JSON.parse(row.trace) : null;
	} catch {
		// A malformed historical trace does not make the projection unsafe; it simply lacks runner ack evidence.
	}
	const runnerAcknowledged =
		!!cp &&
		Array.isArray(trace) &&
		trace.some((event) => {
			if (!event || typeof event !== "object") return false;
			const e = event as { type?: unknown; detail?: { checkpointId?: unknown; directive?: unknown } };
			return e.type === "supervisor.directive" && e.detail?.checkpointId === cp.checkpoint_id && e.detail?.directive === cp.directive;
		});
	const checkpoint: ExecutionCheckpoint | null = cp
		? {
			id: cp.checkpoint_id,
			phase,
			facts: { actions: num(facts?.actions), filled: num(facts?.filled), uploaded: num(facts?.uploaded), blockers: Array.isArray(facts?.blockers) ? facts.blockers.filter((v): v is string => typeof v === "string") : [], domain: typeof facts?.domain === "string" ? facts.domain : null },
			directive:
				cp.directive === "continue" || cp.directive === "request_review" || cp.directive === "stop"
					? { kind: cp.directive, delivery: runnerAcknowledged ? "acknowledged_by_runner" : cp.delivered_at ? "delivered" : cp.delivery_attempted_at ? "delivery_attempted" : "queued" }
					: null,
		}
		: null;
	const progress = fillProgressOf({
		applicationStatus: app.status,
		runStatus: row.status,
		pause,
		result,
		submitAttempted: !!app.submitAttemptedAt,
		blockReason: app.blockReason,
		...(checkpoint ? { checkpoint: { checkpointId: checkpoint.id, phase: checkpoint.phase, filled: checkpoint.facts.filled, uploaded: checkpoint.facts.uploaded } } : {}),
	});
	const d = result?.diagnostic;
	if (!d || typeof d !== "object") return { diagnostic: null, progress, checkpoint, runStatus: row.status };
	const f = d as Record<string, unknown>;
	return {
		diagnostic: {
			cause: String(f.cause ?? ""),
			bridgeCalls: num(f.bridgeCalls),
			engineExit: num(f.engineExit),
			activeMs: num(f.activeMs),
			pages: num(f.pages),
			filled: num(f.filled),
			signals: (Array.isArray(f.signals) ? f.signals : []).filter((x): x is string => typeof x === "string"),
		},
		progress,
		checkpoint,
		runStatus: row.status,
	};
}
