/** Console view of the coder brain switch and product-owner triage reports (#1025, #1027). */
export type PoCategory = "waiting_on_human" | "blocked" | "needs_detail" | "ready";

export interface PoCounts {
	queued: number;
	wouldQueue: number;
	alreadyQueued: number;
	ready: number;
	waiting: number;
	blocked: number;
	needsDetail: number;
	commented: number;
}

export interface PoReportItem {
	repo: string;
	number: number;
	title: string;
	category: PoCategory;
	reason: string;
	action: string;
}

export interface PoTriageReport {
	id: string;
	slot: string;
	dryRun: boolean;
	status: "running" | "completed" | "failed";
	digest: string | null;
	error: string | null;
	createdAt: string;
	report: { gate: string | null; counts: PoCounts; items: PoReportItem[] } | null;
}

export interface CoderBrainView {
	settings: { enabled: boolean; poEnabled: boolean } | null;
	triggers: Array<{ id: string; name: string; schedule: string | null; enabled: boolean; config: { timezone?: string; dryRun?: boolean }; nextRunAt: string | null; lastRunAt: string | null }>;
	reports?: PoTriageReport[];
}

/** "queued 1 · 1 waiting on you · 1 blocked · 1 needs detail" — one line per wake, from its counts. */
export function reportSummary(r: PoTriageReport): string {
	if (r.status === "failed") return `failed: ${r.error ?? "unknown error"}`;
	if (!r.report) return r.status;
	const c = r.report.counts;
	const parts = [
		r.dryRun ? `would queue ${c.wouldQueue}` : `queued ${c.queued}`,
		c.alreadyQueued ? `${c.alreadyQueued} already queued` : "",
		c.waiting ? `${c.waiting} waiting on you` : "",
		c.blocked ? `${c.blocked} blocked` : "",
		c.needsDetail ? `${c.needsDetail} need${c.needsDetail === 1 ? "s" : ""} detail` : "",
	].filter(Boolean);
	return `${parts.join(" · ")}${r.report.gate ? ` — held: ${r.report.gate}` : ""}${r.dryRun ? " (dry run)" : ""}`;
}
