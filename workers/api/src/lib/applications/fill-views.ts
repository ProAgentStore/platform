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
}

export const NO_FILL_VIEWS: FillViews = { diagnostic: null, progress: null };

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
	const row = await env.DB.prepare("SELECT status, pause, result FROM local_apply_runs WHERE id = ?1 AND user_id = ?2")
		.bind(app.fillRunId, uid)
		.first<{ status: string; pause: string | null; result: string | null }>()
		.catch(() => null);
	if (!row) return NO_FILL_VIEWS;
	const result = parse(row.result);
	const pause = parse(row.pause);
	// The supervisor store is the authoritative record of what the runner measured at a checkpoint.
	// The pause carries a copy, but only when the checkpoint resolved at pause time, and a sentence
	// that says "nothing has been entered yet" must not rest on a copy that went missing.
	const cp =
		row.status === "paused" && pause?.reason === "supervisor_checkpoint"
			? await env.DB.prepare("SELECT checkpoint_id, facts FROM local_apply_supervisor_checkpoints WHERE run_id = ?1 AND user_id = ?2 ORDER BY received_at DESC, runner_seq DESC LIMIT 1")
					.bind(app.fillRunId, uid)
					.first<{ checkpoint_id: string; facts: string | null }>()
					.catch(() => null)
			: null;
	const facts = cp ? parse(cp.facts) : null;
	const progress = fillProgressOf({
		applicationStatus: app.status,
		runStatus: row.status,
		pause,
		result,
		submitAttempted: !!app.submitAttemptedAt,
		blockReason: app.blockReason,
		...(cp ? { checkpoint: { checkpointId: cp.checkpoint_id, ...(typeof facts?.phase === "string" ? { phase: facts.phase } : {}), filled: num(facts?.filled), uploaded: num(facts?.uploaded) } } : {}),
	});
	const d = result?.diagnostic;
	if (!d || typeof d !== "object") return { diagnostic: null, progress };
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
	};
}
