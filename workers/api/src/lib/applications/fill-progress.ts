/**
 * How far a fill actually GOT, from the runner's own durable facts (#986).
 *
 * ── The live contradiction
 *
 * For application `435d31c8…` the Runner's checkpoint said `phase: initial`, `filled: 0`,
 * `uploaded: 0`, no blockers and no submit attempt — the CLI had opened the job ad and stopped. The
 * Board card for that same application said:
 *
 *     Filled — waiting for your review before anything is sent
 *
 * Which is not a wording problem. It tells an owner a form is populated and waiting for their
 * approval when nothing was ever typed, and the one action that reading invites — approve it and
 * let it be sent (#981) — would send an empty application to an employer.
 *
 * ── Why it said that
 *
 * The stage was derived from the application's STATUS WORD. `awaiting_review` is the outcome a
 * runner reports both for "the form is complete, come and look" and for "I stopped before filling
 * anything", and #978's card read the first meaning into both. The facts that tell them apart were
 * already stored — `local_apply_runs.result.filled` / `.uploaded`, the pause's own
 * `checkpoint.facts`, `submitAttemptedAt` — and nothing read them.
 *
 * ── What this module is
 *
 * One PURE projection of those facts onto one vocabulary, used by every surface that says anything
 * about progress: the Board card, the Applications/Data queue item, and through both of those, MCP.
 * One function, so the three cannot disagree — which is the property that failed here, since the
 * run detail (`application_run`) was reporting `filled: 0` at the same moment the card claimed a
 * filled form.
 *
 * `evidence` is part of the answer on purpose: a label that rests on the runner's own result is a
 * different kind of claim from one inferred from a status word, and this module is what stops the
 * second from being written as if it were the first.
 */

/** Every stage a fill can be reported at. Ordered roughly by how far the work got. */
export const FILL_STAGES = [
	"queued",
	"navigating",
	"supervisor_pending",
	"filling",
	"partially_filled",
	"ready_for_review",
	"before_submit_review",
	"stopped_before_filling",
	"blocked",
	"submitted",
	"unavailable",
	"failed",
	"cancelled",
] as const;
export type FillStage = (typeof FILL_STAGES)[number];

/** What the claim rests on — the runner's measurement, its checkpoint, or only the run's status. */
export type FillEvidence = "runner_result" | "runner_checkpoint" | "run_status";

export interface FillProgress {
	stage: FillStage;
	/** The sentence every surface shows. Never claims filled work without evidence of it. */
	label: string;
	/** Fields the runner reports having filled, and artifacts it reports having attached. */
	filled: number;
	uploaded: number;
	/** The checkpoint the run is parked at, when it is parked at one. */
	checkpointPhase: string | null;
	checkpointId: string | null;
	/** Has a final submit been attempted? Set once and never cleared. */
	submitAttempted: boolean;
	evidence: FillEvidence;
}

/** The runner-reported result, reduced to what progress depends on. */
export interface FillResultFacts {
	outcome?: string;
	filled?: number;
	uploaded?: unknown;
	submitAttempted?: boolean;
	blockReason?: string;
	/** The envelope carries more than this; a reader of progress needs only the fields above. */
	[key: string]: unknown;
}

/** The pause a run is sitting in, as the run row stores it. */
export interface FillPauseFacts {
	reason?: string;
	checkpoint?: { checkpointId?: string; facts?: { phase?: string; filled?: number; uploaded?: number } };
}

export interface FillProgressInput {
	/** The APPLICATION's lifecycle status — the fallback, and the only thing #978's card read. */
	applicationStatus: string;
	/** The fill run's status, when one is bound: `queued` | `running` | `paused` | terminal. */
	runStatus?: string | null;
	pause?: FillPauseFacts | null;
	result?: unknown;
	/** `submitAttemptedAt` on the application — stronger than anything the result says. */
	submitAttempted?: boolean;
	/** The application's own block reason, when it carries one. */
	blockReason?: string | null;
	/** The latest checkpoint, when the caller has it from the supervisor store rather than the pause. */
	checkpoint?: { checkpointId?: string; phase?: string; filled?: number; uploaded?: number } | null;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const uploadedCount = (v: unknown): number => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).length : count(v));
const fields = (n: number) => `${n} field${n === 1 ? "" : "s"}`;
const attachments = (n: number) => `${n} attachment${n === 1 ? "" : "s"}`;

/** "3 fields and 1 attachment", or just the half that happened. */
function work(filled: number, uploaded: number): string {
	if (filled && uploaded) return `${fields(filled)} and ${attachments(uploaded)}`;
	if (filled) return fields(filled);
	if (uploaded) return attachments(uploaded);
	return "nothing";
}

/**
 * The progress this application is at. PURE.
 *
 * Ordered by how CERTAIN each fact is, which is also the order an owner needs: an attempted submit
 * outranks everything (it may already be with the employer), then a terminal archive, then what the
 * run is doing right now, and only at the end the application's status word — which is where the
 * false "Filled" came from and is now reached only when there is no run fact at all.
 */
export function fillProgressOf(input: FillProgressInput): FillProgress {
	const pause = input.pause ?? null;
	const result = (input.result ?? null) as FillResultFacts | null;
	const cp = pause?.reason === "supervisor_checkpoint" ? pause.checkpoint : null;
	const checkpointId = input.checkpoint?.checkpointId ?? cp?.checkpointId ?? null;
	const checkpointPhase = input.checkpoint?.phase ?? cp?.facts?.phase ?? null;
	// The checkpoint's facts are the runner's measurement at the moment it stopped; the result's are
	// its measurement when the run ended. Whichever is present, the bigger is the honest total — a
	// later checkpoint cannot have un-filled a field.
	const filled = Math.max(count(result?.filled), count(input.checkpoint?.filled), count(cp?.facts?.filled));
	const uploaded = Math.max(uploadedCount(result?.uploaded), count(input.checkpoint?.uploaded), count(cp?.facts?.uploaded));
	const submitAttempted = input.submitAttempted === true || result?.submitAttempted === true;
	const did = work(filled, uploaded);
	const evidence: FillEvidence = result ? "runner_result" : checkpointPhase || pause ? "runner_checkpoint" : "run_status";
	const at = (stage: FillStage, label: string): FillProgress => ({ stage, label, filled, uploaded, checkpointPhase, checkpointId, submitAttempted, evidence });

	if (input.applicationStatus === "submitted") return at("submitted", `Submitted to the employer after filling ${did}.`);
	// An attempt whose outcome nobody confirmed is the one state that must never read as progress.
	if (submitAttempted) return at("submitted", "A final submit was attempted — check the employer's site before anything else is done.");
	if (input.applicationStatus === "archived") {
		return at("unavailable", input.blockReason === "job_unavailable" ? "The listing is no longer available; nothing was sent." : "Archived; nothing was sent.");
	}

	// What the run is doing RIGHT NOW, which outranks the application's status word.
	if (input.runStatus === "paused" && pause?.reason === "supervisor_checkpoint") {
		if (checkpointPhase === "before_submit") {
			return at("before_submit_review", `Form complete (${did}) — waiting for the supervisor's decision before anything is sent.`);
		}
		if (!filled && !uploaded) {
			// THE #986 CASE. "initial, filled 0" is the CLI having opened the page and stopped.
			return at("supervisor_pending", "Paused before form filling — supervisor decision pending. Nothing has been entered yet.");
		}
		// Work done but the form not declared complete: partially filled, which is a different thing
		// to tell an owner from either "nothing entered" or "ready for your review".
		return at("partially_filled", `Paused after ${did} — supervisor decision pending.`);
	}
	if (input.runStatus === "paused") {
		const why = (pause?.reason ?? input.blockReason ?? "a pause").replace(/_/g, " ");
		return at("blocked", filled || uploaded ? `Paused — ${why}, after ${did}.` : `Paused — ${why}, before any field was filled.`);
	}
	if (input.runStatus === "queued") return at("queued", "Waiting for the machine to fill it.");
	if (input.runStatus === "running") {
		return filled || uploaded
			? at("filling", `Filling the application in the browser — ${did} so far.`)
			: at("navigating", "Opening the application in the browser — no field filled yet.");
	}

	// The run has ENDED. `awaiting_review` is reported for a complete form AND for a run that
	// stopped before touching one, so the counts decide which sentence is true.
	if (input.applicationStatus === "awaiting_review" || result?.outcome === "awaiting_review") {
		return filled || uploaded
			? at("ready_for_review", `Filled ${did} — waiting for your review before anything is sent.`)
			: at("stopped_before_filling", "Stopped before any field was filled — there is nothing to review, and nothing was sent.");
	}
	if (input.applicationStatus === "blocked" || result?.outcome === "blocked") {
		const why = (result?.blockReason ?? input.blockReason ?? "incomplete").replace(/_/g, " ");
		return at("blocked", filled || uploaded ? `Stopped — ${why}, after ${did}.` : `Stopped — ${why}, before any field was filled.`);
	}
	if (input.applicationStatus === "cancelled") return at("cancelled", `Cancelled after filling ${did}.`);
	if (input.applicationStatus === "failed" || result?.outcome === "failed") {
		return at("failed", filled || uploaded ? `The run failed after ${did}.` : "The run failed before any field was filled.");
	}
	// No run fact at all — the honest answer is the status word, and it is labelled as such.
	return at("queued", `Fill ${input.runStatus ?? input.applicationStatus}.`);
}

/**
 * Is this progress safe to describe as a filled form? The one question #981's approval and the
 * Board's "review it" affordance both turn on, asked in one place rather than re-derived.
 */
export const hasFilledWork = (p: FillProgress): boolean => p.filled > 0 || p.uploaded > 0;
