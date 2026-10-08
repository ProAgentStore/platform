/**
 * An application execution as a generic board card (#978) — the third domain after coding (#206)
 * and pipelines (#207A), written the same way for the same reason.
 *
 * The problem: the Board renders `instance_runtime_tasks`, and the Tailor and Runner wrote only
 * their own run tables. So a Runner that was actively filling an employer's form had an EMPTY
 * board, and the only place the work appeared was a separate Applications surface — which made one
 * workflow look like two systems, and left a supervisor (`subordinate_status`, which reads exactly
 * these rows) unable to see any of it.
 *
 * The product model #978 states, and the shape that follows from it:
 *
 *   An APPLICATION is durable data — lead, job URL, artifacts, authorization, outcome.
 *   A RUN is one execution against it: tailoring, a fill, a retry, a submit.
 *   One application has MANY runs.
 *
 * So the card is keyed on the application's JOB URL, not on the run. The board's generic grouping
 * then does the rest for free: every run of one application collapses into one card whose
 * `attempts` are the runs, which is already how the board treats "one job, several tries". Keying
 * on the run id instead would have produced a new card per retry and buried the application.
 *
 * What the domain puts on the card, because only the domain can: the application's identity, the
 * stage it is in, the checkpoint or terminal reason, the trace to read, and the actions the
 * APPLICATION ACTION SERVICE currently permits (`applications/control.ts`). The actions are
 * computed here at write time rather than derived by a reader, which is what keeps Console and MCP
 * showing the same controls — both read this one record.
 */
import { type ApplicationCardPayload, parseApplicationCard } from "./application-card-payload.js";
import type { JobApplication } from "../local-artifact/store.js";
import { upsertWorkCard } from "../work-card.js";
import type { Env } from "../../types.js";

/** The two execution kinds an application has. */
export type ApplicationRunKind = "tailor" | "fill";

// Re-exported so a domain reader has one import; the SHAPE lives in the leaf, which imports
// nothing, so the generic board can read it without touching this module's graph (#978).
export { type ApplicationCardPayload, parseApplicationCard };

export const APPLICATION_RUN_TASK_TYPE = "application.run";

/**
 * The card id, keyed on the APPLICATION — one card per application, whatever ran.
 *
 * Not the run id: a retry must land on the same card, and the board's own vocabulary for "another
 * try at the same job" is an attempt, not a second card.
 */
export const applicationCardId = (applicationId: string): string => `app-${applicationId}`;

/**
 * The board status for an application run.
 *
 * Mapped rather than passed through, for the reason `pipelineCardStatus` gives: a domain's own word
 * that no board column claims reads as uncategorised. `paused` is the one that matters — a run
 * waiting for a person is `needs_human`, which is the status every board column set has a home for
 * and the one the console's "needs you" column reads.
 */
export function applicationCardStatus(runStatus: string): string {
	if (runStatus === "paused") return "needs_human";
	if (runStatus === "awaiting_review") return "needs_human";
	if (runStatus === "queued") return "queued";
	if (runStatus === "submitted") return "completed";
	return runStatus;
}

/** What the owner is told the run is doing — the stage, in their words. */
export function applicationStageLabel(kind: ApplicationRunKind, runStatus: string, pauseReason?: string | null): string {
	if (pauseReason === "supervisor_checkpoint") return "Waiting for the cloud supervisor's decision at a checkpoint";
	if (pauseReason) return `Paused — ${pauseReason.replace(/_/g, " ")}`;
	if (kind === "tailor") {
		return runStatus === "running" ? "Tailoring the résumé and cover letter" : runStatus === "queued" ? "Waiting for the machine to tailor it" : `Tailoring ${runStatus}`;
	}
	if (runStatus === "running") return "Filling the application in the browser";
	if (runStatus === "queued") return "Waiting for the machine to fill it";
	if (runStatus === "submitted") return "Submitted to the employer";
	if (runStatus === "awaiting_review") return "Filled — waiting for your review before anything is sent";
	return `Fill ${runStatus}`;
}

/** The application's identity and current state, as the card carries it. */
export interface ApplicationCardFacts {
	applicationId: string;
	/** The application's own lifecycle status, which outlives any one run. */
	applicationStatus: string;
	/** Compare-and-set token, so an action taken from the card is refused when stale. */
	stateVersion: number;
	/** What the action service currently permits — the SAME list the Applications service computes. */
	actions: readonly string[];
	kind: ApplicationRunKind;
	runId: string;
	stage: string;
    /** The checkpoint a paused run is waiting on, when it is waiting on one (#971's vocabulary). */
	checkpoint?: { checkpointId: string; phase: string; directive: string | null } | null;
	/** Where the correlated history is: the application's own trace (#958). */
	traceUrl: string;
	/** The terminal reason, when the run ended on one. */
	blockReason?: string | null;
	/** The runner CLI that executed it (#977), when known. */
	runnerVersion?: string | null;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The lead's own words for the job this application is for. */
export function applicationCardLabel(app: Pick<JobApplication, "lead">): { title: string; subtitle: string; url: string } {
	const envelope = (app.lead ?? {}) as { leadUrl?: string; lead?: Record<string, unknown> };
	const lead = envelope.lead ?? {};
	const str = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
	const role = str(lead.title) || "(untitled job)";
	const company = str(lead.company);
	return {
		title: clip(company ? `${role} — ${company}` : role, 200),
		subtitle: clip(str(lead.location), 120),
		url: str(envelope.leadUrl) || str(lead.url),
	};
}

/**
 * The card record. Pure, so what the board will show is assertable without a database — the thing
 * #978's acceptance turns on ("the card visibly moves to awaiting-review with the directive").
 */
export function applicationRunTaskRecord(opts: { app: Pick<JobApplication, "id" | "lead">; facts: ApplicationCardFacts; runStatus: string; now: string }): Record<string, unknown> {
	const label = applicationCardLabel(opts.app);
	const status = applicationCardStatus(opts.runStatus);
	const detail = [opts.facts.stage, opts.facts.blockReason ? `reason: ${opts.facts.blockReason}` : "", opts.facts.checkpoint ? `checkpoint ${opts.facts.checkpoint.checkpointId} (${opts.facts.checkpoint.phase})${opts.facts.checkpoint.directive ? ` → ${opts.facts.checkpoint.directive}` : " — awaiting a directive"}` : ""]
		.filter(Boolean)
		.join(" · ");
	return {
		id: applicationCardId(opts.facts.applicationId),
		type: APPLICATION_RUN_TASK_TYPE,
		status,
		title: label.title,
		subtitle: label.subtitle,
		description: clip(detail, 300),
		// `input.url` is what the board reads for a card's url, and for an apply agent it is also the
		// per-job key — which is what makes every run of this application one card.
		input: { url: label.url },
		application: {
			applicationId: opts.facts.applicationId,
			applicationStatus: opts.facts.applicationStatus,
			stateVersion: opts.facts.stateVersion,
			actions: [...opts.facts.actions],
			kind: opts.facts.kind,
			runId: opts.facts.runId,
			stage: opts.facts.stage,
			traceUrl: opts.facts.traceUrl,
			...(opts.facts.checkpoint ? { checkpoint: opts.facts.checkpoint } : {}),
			...(opts.facts.blockReason ? { blockReason: opts.facts.blockReason } : {}),
			...(opts.facts.runnerVersion ? { runnerVersion: opts.facts.runnerVersion } : {}),
		},
		createdAt: opts.now,
		updatedAt: opts.now,
		...(status === "running" || status === "needs_human" || status === "queued" ? {} : { completedAt: opts.now }),
	};
}

/** Write (or refresh) the application's card. Best-effort, like every card write (`work-card.ts`). */
export async function upsertApplicationRunCard(
	env: Env,
	opts: { instanceId: string; userId: string; app: Pick<JobApplication, "id" | "lead">; facts: ApplicationCardFacts; runStatus: string },
): Promise<void> {
	const task = applicationRunTaskRecord({ app: opts.app, facts: opts.facts, runStatus: opts.runStatus, now: new Date().toISOString() });
	await upsertWorkCard(env, { instanceId: opts.instanceId, userId: opts.userId, id: applicationCardId(opts.facts.applicationId), task });
}

/**
 * Refresh the card for one application from the state the ACTION SERVICE sees (#978).
 *
 * The actions come from `getQueueItem` — the very read the Applications surface and the typed MCP
 * tools make — so the card cannot offer a control the service would refuse, and Console and MCP
 * cannot drift into showing different ones. That is the parity requirement, met by construction
 * rather than by two lists kept in step.
 *
 * Imported lazily because `applications/control.ts` imports the apply and tailor domains that call
 * this, and a static import would close the cycle. Best-effort throughout: a missing card is a
 * visibility bug, and failing the run that triggered the write is strictly worse.
 */
export async function syncApplicationCard(
	env: Env,
	userId: string,
	run: { id: string; instanceId: string; applicationId: string; status: string; pause?: { reason?: string } | null; runnerVersion?: string | null },
	kind: ApplicationRunKind,
	opts: { checkpoint?: ApplicationCardFacts["checkpoint"] } = {},
): Promise<void> {
	try {
		const { getQueueItem } = await import("./control.js");
		const { item } = await getQueueItem(env, userId, run.instanceId, { applicationId: run.applicationId });
		const { getOwnedApplication } = await import("../local-artifact/store.js");
		const app = await getOwnedApplication(env, userId, run.applicationId);
		if (!app) return;
		await upsertApplicationRunCard(env, {
			// The card belongs to the instance that RAN it, which is where its owner looks: a fill
			// card on the Runner's board, a tailoring card on the Tailor's.
			instanceId: run.instanceId,
			userId,
			app,
			runStatus: run.status,
			facts: {
				applicationId: run.applicationId,
				applicationStatus: item.status,
				stateVersion: item.stateVersion ?? 0,
				actions: item.actions,
				kind,
				runId: run.id,
				stage: applicationStageLabel(kind, run.status, run.pause?.reason ?? null),
				traceUrl: `/instances/${run.instanceId}/applications/${run.applicationId}/trace`,
				...(opts.checkpoint ? { checkpoint: opts.checkpoint } : {}),
				blockReason: item.blockReason,
				runnerVersion: run.runnerVersion ?? null,
			},
		});
	} catch {
		/* visibility only — never fail the run that triggered it */
	}
}
