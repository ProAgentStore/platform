/**
 * One scan as a card on the NORMAL board (#980) — the fourth domain after coding (#206), pipelines
 * (#207A) and application runs (#978), written the same way for the same reason.
 *
 * The problem: a Scout's work existed in `local_browser_runs` and nowhere else. Its board was
 * EMPTY while it was mid-scan, so "is my Scout doing anything" had to be answered from the Research
 * tab — and a supervisor (`subordinate_status`, which reads exactly these rows) could not see a
 * scan at all. The owner's own instance list said `Idle`.
 *
 * One card per RUN, not per lead: a scan is one execution, and the leads it produced are Data
 * (`job_leads`, each record carrying `sourceRunId`). #980 is explicit that the records stay in Data
 * linked to the run that produced them, which is exactly the split — the card is the execution, the
 * records are what it found, and `scan.leadRecordIds` is the join between them.
 *
 * The card carries the telemetry HEADLINE and counts, never the findings' text: a board card is a
 * surface a supervisor and an MCP reader both see, and `telemetry.ts` is where the privacy boundary
 * is argued. Reading one costs no relay call — every number comes from rows PAGS already has.
 */
import { cardDetail } from "../card-detail.js";
import { clipMarked } from "../clip-marked.js";
import { upsertWorkCard } from "../work-card.js";
import { listLocalBrowserEvents } from "./store.js";
import { type ScanTelemetry, scanHeadline, scanTelemetry } from "./telemetry.js";
import type { LocalBrowserRun } from "./store.js";
import type { Env } from "../../types.js";

export const SCAN_TASK_TYPE = "local_browser.scan";

/** Stable per-run card id, so every transition upserts the SAME row rather than piling up. */
export const scanCardId = (runId: string): string => `scan-${runId}`;

/** How many trace events the card's counts are computed from. A scan's trace is bounded by policy. */
const TELEMETRY_EVENT_LIMIT = 500;

/**
 * The board status for a scan run.
 *
 * Mapped, not passed through, for the reason `pipelineCardStatus` gives: a domain word no column
 * claims reads as uncategorised. `paused` → `needs_human` is the one that matters — a scan waiting
 * on a login, a captcha or a consent decision is waiting for the OWNER, and that is the column
 * every board's column set has a home for.
 */
export function scanCardStatus(runStatus: string): string {
	if (runStatus === "paused") return "needs_human";
	if (runStatus === "queued") return "queued";
	return runStatus;
}

/** What the card is called. The owner's own objective, marked when it is cut. */
export function scanCardTitle(objective: string): string {
	return clipMarked(`Scan: ${objective.replace(/\s+/g, " ").trim()}`, 120);
}

/** The card record. Pure, so what the board will show is assertable without a database. */
export function scanTaskRecord(opts: { run: LocalBrowserRun; telemetry: ScanTelemetry; now: string }): Record<string, unknown> {
	const { run, telemetry } = opts;
	const status = scanCardStatus(run.status);
	return {
		id: scanCardId(run.id),
		type: SCAN_TASK_TYPE,
		status,
		title: scanCardTitle(run.objective),
		subtitle: telemetry.startedBy === "trigger" ? "Scheduled scan" : telemetry.startedBy === "owner" ? "Started by you" : "Scan",
		description: cardDetail(scanHeadline(telemetry)),
		// The run page, which is where its structured activity and its findings are.
		input: { url: `/instances/${run.instanceId}/research/${run.id}` },
		scan: {
			runId: run.id,
			startedBy: telemetry.startedBy,
			pages: telemetry.seen.pages,
			results: telemetry.seen.findings,
			leadsAdded: telemetry.leads.added,
			duplicates: telemetry.leads.duplicates,
			pendingReview: telemetry.leads.pending,
			sourcesConfigured: telemetry.sources.configured,
			sourcesUnreachable: telemetry.sources.unreachable,
			handoffs: telemetry.handoffs.emitted,
			warnings: telemetry.warnings.length,
			errors: telemetry.errors.length,
			outcome: telemetry.terminal.outcome,
			reason: telemetry.terminal.reason,
			// Board → Data: the records this scan put in the collection (#980).
			leadRecordIds: telemetry.leads.recordIds,
			...(run.pauseReason ? { pauseReason: run.pauseReason } : {}),
		},
		createdAt: new Date(run.createdAt).toISOString(),
		updatedAt: opts.now,
		...(status === "running" || status === "needs_human" || status === "queued" ? {} : { completedAt: opts.now }),
	};
}

/**
 * Write (or refresh) this scan's card.
 *
 * Best-effort by design, like every card write (`work-card.ts`): losing a card is a visibility bug,
 * losing the scan is a work bug. Called from the four places a scan's state changes — its start,
 * each runner sync, the owner's review of a finding, and a cancel — rather than from one of them,
 * because a card that only updates on SOME transitions is the stale-card defect #553 is about.
 */
export async function syncScanCard(env: Env, instanceId: string, userId: string, run: LocalBrowserRun): Promise<void> {
	try {
		const events = await listLocalBrowserEvents(env, instanceId, userId, run.id, 0, TELEMETRY_EVENT_LIMIT).catch(() => []);
		const telemetry = scanTelemetry({ run, events });
		await upsertWorkCard(env, { instanceId, userId, id: scanCardId(run.id), task: scanTaskRecord({ run, telemetry, now: new Date().toISOString() }) });
	} catch {
		/* visibility only — never fail the scan that triggered it */
	}
}
