/**
 * What one scan actually DID, in counts and closed vocabularies (#980).
 *
 * ── The question this answers
 *
 * An owner looking at three leads in their Data table could not tell whether the scan checked four
 * sources or one, whether a board had rejected it, how many postings it read to find those three,
 * what it threw away and why, or — the worst case — why a scan that ran to completion found
 * nothing at all. The run's trace held the raw events and its result held the findings, so every
 * one of those questions was answerable only by reading a transcript, which is exactly what an
 * owner tuning a search should not have to do.
 *
 * ── The privacy boundary, which is why this is a projection and not a dump
 *
 * Everything here is a COUNT, a DOMAIN, a closed-vocabulary code, or an id of the owner's own
 * record. No page text, no finding prose, no engine output, no URLs beyond their hostname, nothing
 * typed into a form. The run's own findings (title, url, evidence) are already the owner's to read
 * through the run view and the collection; telemetry is the shape of the scan, and a shape does not
 * need the contents. That is also what makes it safe on a board card and in an MCP reply.
 *
 * PURE — the run and its events are passed in. `scan-board.ts` and the run route compose it.
 */
import type { LocalBrowserSourceFailureReason } from "./contract.js";
import type { FindingReview, LocalBrowserRun, TraceEvent } from "./store.js";

/** How a finding ended up: the owner's decision, or nothing yet. A closed set. */
export const SCAN_LEAD_DISPOSITIONS = ["added", "duplicate", "skipped", "pending"] as const;
export type ScanLeadDisposition = (typeof SCAN_LEAD_DISPOSITIONS)[number];

/** Event classes that are worth reporting as a WARNING on a scan that otherwise looks fine. */
const WARNING_EVENTS = new Set(["browser.blocked", "consent.requested", "run.paused"]);

export interface ScanSourceReach {
	/** The hostname only — never the path, which carries the query the owner typed. */
	domain: string;
	pages: number;
	blocked: number;
	/** Set when this source reported a failure: the contract's own reason. */
	failed: LocalBrowserSourceFailureReason | null;
}

export interface ScanTelemetry {
	runId: string;
	status: string;
	/** `owner` or `trigger` — who asked for this scan, from the run's own `run.requested` event. */
	startedBy: "owner" | "trigger" | "unknown";
	startedAt: string | null;
	endedAt: string | null;
	durationMs: number | null;
	/** What the scan was CONFIGURED with, which is half of "why did it find nothing". */
	configured: {
		engine: string;
		authMode: string;
		/** Hostnames the scan was allowed to visit — the "sources" an owner tunes. */
		sources: string[];
		denied: string[];
		collection: string | null;
		keyField: string | null;
		maxPages: number;
		maxMinutes: number;
	};
	/** Reachability per source, and the ones that reported a failure. */
	sources: { configured: number; reached: number; unreachable: number; reach: ScanSourceReach[] };
	/** What the scan saw. Pages and snapshots are counts of trace events, not their contents. */
	seen: { pages: number; snapshots: number; findings: number };
	/** What became of each finding, and the records the added ones are in (Board → Data). */
	leads: { added: number; duplicates: number; skipped: number; pending: number; recordIds: string[] };
	/**
	 * Why findings did not become leads, by reason. `duplicate` is the collection's key already
	 * holding that posting; `skipped` is the owner's own decision.
	 */
	rejections: Array<{ reason: ScanLeadDisposition; count: number }>;
	/**
	 * Handoffs emitted BY THIS SCAN. A Scout hands a lead on at TRIAGE — the owner's explicit Apply,
	 * which is the only emitter of the lead handoff event (`job-lead-triage.ts`, and a source guard
	 * keeps it that way, which is why this comment does not name the event) — and not when it finds
	 * one. So this is normally 0, and saying so is the point: an owner who expected the pipeline to
	 * move looks here and learns where the next step is.
	 */
	handoffs: { emitted: number; note: string };
	/** Closed-vocabulary counts, never messages: the event type is the code. */
	warnings: Array<{ code: string; count: number }>;
	errors: Array<{ code: string; count: number }>;
	/** How it ended, and the one sentence that explains an empty scan. */
	terminal: { outcome: string; errorCode: string | null; reason: string };
}

const hostOf = (url: string | undefined): string | null => {
	if (!url) return null;
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
};

const tally = (counts: Map<string, number>): Array<{ code: string; count: number }> =>
	[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, count]) => ({ code, count }));

/** What the owner is told about how the scan ended — the sentence an empty result needs most. */
export function scanOutcomeReason(run: LocalBrowserRun, leads: ScanTelemetry["leads"], sources: ScanTelemetry["sources"], seen: ScanTelemetry["seen"]): string {
	if (run.status === "failed") return `The scan failed (${run.errorCode ?? "no code"}): ${run.error ?? "no reason recorded"}. Nothing was searched after that point.`;
	if (run.status === "cancelled") return "You cancelled this scan; whatever it had already found is on the run.";
	if (run.status === "paused") return `The scan is waiting for you (${run.pauseReason ?? "a pause"}). It cannot continue until you answer it.`;
	if (run.status === "queued" || run.status === "running") return "The scan is still going.";
	if (seen.findings === 0 && sources.unreachable > 0 && sources.unreachable >= sources.reached) {
		return `No results: ${sources.unreachable} of ${sources.configured || sources.unreachable} source(s) could not be read (${sources.reach.filter((r) => r.failed).map((r) => `${r.domain}: ${r.failed}`).join(", ")}). Fix the access or search elsewhere.`;
	}
	if (seen.findings === 0 && seen.pages === 0) return "No results, and no page was opened — the scan ended without reaching a source. Check the allowed sources and the engine's sign-in.";
	if (seen.findings === 0) return `No results from ${seen.pages} page(s) read. The sources were reachable and nothing matched the objective — narrow or widen it and scan again.`;
	if (leads.added === 0 && leads.duplicates > 0) return `${seen.findings} result(s), all of them already in your Data (${leads.duplicates} duplicate(s)). Nothing new was found.`;
	if (leads.added === 0 && leads.pending > 0) return `${seen.findings} result(s) found and ${leads.pending} still waiting for your review — nothing has entered the pipeline yet.`;
	return `${leads.added} lead(s) added from ${seen.findings} result(s) across ${seen.pages} page(s).`;
}

/**
 * The scan's telemetry, from the run, its trace and the owner's reviews.
 *
 * `events` may be a page of the trace rather than all of it — the counts are then of what was read,
 * which is why the route passes the whole trace and the board card passes what it has. Nothing
 * here throws on a short or foreign event list: a missing event is a count of zero, never an error
 * on a read an owner is doing to find out what went wrong.
 */
export function scanTelemetry(input: { run: LocalBrowserRun; events: readonly TraceEvent[]; handoffs?: number }): ScanTelemetry {
	const { run } = input;
	const policy = run.policy;
	const result = run.result;

	// PAGS's own event, not the runner's: who asked for this scan (#962 records it at start).
	const requested = input.events.find((e) => e.type === "run.requested");
	const rawSource = (requested?.detail as { source?: unknown } | undefined)?.source;
	const startedBy: ScanTelemetry["startedBy"] = rawSource === "owner" || rawSource === "trigger" ? rawSource : "unknown";

	const reach = new Map<string, ScanSourceReach>();
	const touch = (domain: string): ScanSourceReach => {
		const existing = reach.get(domain);
		if (existing) return existing;
		const fresh: ScanSourceReach = { domain, pages: 0, blocked: 0, failed: null };
		reach.set(domain, fresh);
		return fresh;
	};
	for (const source of policy.allowDomains) touch(source.toLowerCase());

	let pages = 0;
	let snapshots = 0;
	const warnings = new Map<string, number>();
	const errors = new Map<string, number>();
	for (const e of input.events) {
		const domain = (e.domain ?? hostOf(e.url))?.toLowerCase() ?? null;
		if (e.type === "browser.navigated") {
			pages++;
			if (domain) touch(domain).pages++;
		} else if (e.type === "browser.snapshot") snapshots++;
		else if (e.type === "browser.blocked" && domain) touch(domain).blocked++;
		if (WARNING_EVENTS.has(e.type)) {
			const code = e.type === "run.paused" && e.pauseReason ? `paused:${e.pauseReason}` : e.type;
			warnings.set(code, (warnings.get(code) ?? 0) + 1);
		}
	}
	for (const failure of result?.sourceFailures ?? []) {
		const domain = hostOf(failure.url);
		if (domain) touch(domain).failed = failure.reason;
		errors.set(`source:${failure.reason}`, (errors.get(`source:${failure.reason}`) ?? 0) + 1);
	}
	if (run.errorCode) errors.set(run.errorCode, (errors.get(run.errorCode) ?? 0) + 1);
	if (run.engineAuth === "missing_login") errors.set("engine_not_signed_in", (errors.get("engine_not_signed_in") ?? 0) + 1);

	const findings = result?.findings?.length ?? 0;
	const reviews: FindingReview[] = Object.values(run.findingReviews ?? {});
	const byDecision = (decision: string) => reviews.filter((r) => r.decision === decision);
	const added = byDecision("saved");
	const leads: ScanTelemetry["leads"] = {
		added: added.length,
		duplicates: byDecision("duplicate").length,
		skipped: byDecision("skipped").length,
		pending: Math.max(0, findings - reviews.length),
		recordIds: added.map((r) => r.recordId).filter((id): id is string => !!id),
	};

	const reachList = [...reach.values()].sort((a, b) => a.domain.localeCompare(b.domain));
	const sources: ScanTelemetry["sources"] = {
		configured: policy.allowDomains.length,
		reached: reachList.filter((r) => r.pages > 0).length,
		unreachable: reachList.filter((r) => r.failed !== null).length,
		reach: reachList,
	};
	const seen = { pages, snapshots, findings };

	return {
		runId: run.id,
		status: run.status,
		startedBy,
		startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
		endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
		durationMs: run.startedAt && run.endedAt ? run.endedAt - run.startedAt : null,
		configured: {
			engine: policy.engine,
			authMode: policy.authMode,
			sources: [...policy.allowDomains],
			denied: [...policy.denyDomains],
			collection: policy.collection?.name ?? null,
			keyField: policy.collection?.keyField ?? null,
			maxPages: policy.limits.maxPages,
			maxMinutes: policy.limits.maxMinutes,
		},
		sources,
		seen,
		leads,
		rejections: [
			...(leads.duplicates ? [{ reason: "duplicate" as const, count: leads.duplicates }] : []),
			...(leads.skipped ? [{ reason: "skipped" as const, count: leads.skipped }] : []),
			...(leads.pending ? [{ reason: "pending" as const, count: leads.pending }] : []),
		],
		handoffs: {
			emitted: input.handoffs ?? 0,
			note: "A Scout hands a lead to the Tailor when you Apply to it, not when it is found — so a scan emits none by itself.",
		},
		warnings: tally(warnings),
		errors: tally(errors),
		terminal: {
			outcome: result?.outcome ?? run.status,
			errorCode: run.errorCode,
			reason: scanOutcomeReason(run, leads, sources, seen),
		},
	};
}

/** The one line a board card carries: the shape of the scan, in the fewest words that still say it. */
export function scanHeadline(t: ScanTelemetry): string {
	const parts = [
		`${t.seen.pages} page${t.seen.pages === 1 ? "" : "s"}`,
		`${t.seen.findings} result${t.seen.findings === 1 ? "" : "s"}`,
		`${t.leads.added} lead${t.leads.added === 1 ? "" : "s"} added`,
	];
	if (t.leads.duplicates) parts.push(`${t.leads.duplicates} duplicate${t.leads.duplicates === 1 ? "" : "s"}`);
	if (t.leads.pending) parts.push(`${t.leads.pending} awaiting review`);
	if (t.sources.unreachable) parts.push(`${t.sources.unreachable} source${t.sources.unreachable === 1 ? "" : "s"} unreachable`);
	if (t.errors.length) parts.push(`errors: ${t.errors.map((e) => e.code).join(", ")}`);
	return `${parts.join(" · ")} — ${t.terminal.reason}`;
}
