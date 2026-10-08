/**
 * The Scout's scan schedule and one scan's telemetry, as the console reads them (#980).
 *
 * Both shapes are the server's: `GET …/local-browser/settings` carries `schedule` (a view over the
 * cron trigger that actually fires — never a second scheduler), and `GET …/local-browser/runs/:id`
 * carries `telemetry`. MCP reads the same two responses through
 * `get_instance_local_browser_settings` and `list_local_browser_runs`, so nothing here decides
 * anything a model would see differently.
 *
 * What this file holds is the wording and the cadence vocabulary — and the one rule #980 states
 * outright: the console must not pick a cadence. {@link CADENCE_OPTIONS} is a list to choose FROM,
 * with no default selected.
 */

export interface ScanSchedule {
	configured: boolean;
	enabled: boolean;
	cadence: string | null;
	objective: string | null;
	triggerId: string | null;
	name: string | null;
	nextRunAt: string | null;
	lastRunAt: string | null;
	nextSlotAt: string | null;
	failureCount: number;
	lastError: string | null;
}

export interface ScanTelemetry {
	runId: string;
	status: string;
	startedBy: "owner" | "trigger" | "unknown";
	startedAt: string | null;
	endedAt: string | null;
	durationMs: number | null;
	configured: { engine: string; authMode: string; sources: string[]; denied: string[]; collection: string | null; keyField: string | null; maxPages: number; maxMinutes: number };
	sources: { configured: number; reached: number; unreachable: number; reach: Array<{ domain: string; pages: number; blocked: number; failed: string | null }> };
	seen: { pages: number; snapshots: number; findings: number };
	leads: { added: number; duplicates: number; skipped: number; pending: number; recordIds: string[] };
	rejections: Array<{ reason: string; count: number }>;
	handoffs: { emitted: number; note: string };
	warnings: Array<{ code: string; count: number }>;
	errors: Array<{ code: string; count: number }>;
	terminal: { outcome: string; errorCode: string | null; reason: string };
}

/**
 * Cadences the owner can pick. Offered, never applied: a scan spends their machine, their engine
 * subscription and whatever the sites they search make of the traffic, so the platform proposes and
 * the owner decides (#980: "do not silently choose a user cadence").
 */
export const CADENCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "0 * * * *", label: "Every hour" },
	{ value: "0 */4 * * *", label: "Every 4 hours" },
	{ value: "0 7 * * *", label: "Daily at 07:00" },
	{ value: "0 7 * * 1-5", label: "Weekday mornings" },
	{ value: "0 7 * * 1", label: "Weekly (Monday)" },
];

/** `0 7 * * 1-5` → "Weekday mornings", and anything hand-written back as itself. */
export const cadenceLabel = (cadence: string | null): string => (cadence ? (CADENCE_OPTIONS.find((o) => o.value === cadence)?.label ?? cadence) : "not set");

/** The one line the schedule card leads with — the state first, because that is the question. */
export function scheduleHeadline(s: ScanSchedule | null | undefined): { tone: "muted" | "success" | "warning" | "danger"; text: string } {
	if (!s?.configured) return { tone: "muted", text: "Not scheduled — this Scout searches only when you start a scan." };
	if (!s.enabled) return { tone: "warning", text: `Paused — ${cadenceLabel(s.cadence)} is set but switched off.` };
	if (s.failureCount > 0) return { tone: "danger", text: `${cadenceLabel(s.cadence)} — ${s.failureCount} failed attempt(s): ${s.lastError ?? "no reason recorded"}` };
	return { tone: "success", text: `Scanning ${cadenceLabel(s.cadence)}` };
}

/** A timestamp an owner reads, or a dash. Local time, because a schedule is a wall-clock promise. */
export const whenLabel = (iso: string | null | undefined): string => {
	if (!iso) return "—";
	const t = Date.parse(iso);
	return Number.isNaN(t) ? "—" : new Date(t).toLocaleString();
};

/** The structured activity rows the run view shows, in the order an owner asks the questions. */
export function telemetryRows(t: ScanTelemetry): Array<{ label: string; value: string; tone?: "warning" | "danger" }> {
	const reach = t.sources.reach.map((r) => `${r.domain}: ${r.failed ? `unreachable (${r.failed})` : `${r.pages} page${r.pages === 1 ? "" : "s"}`}${r.blocked ? `, ${r.blocked} blocked` : ""}`);
	return [
		{ label: "Started by", value: t.startedBy === "trigger" ? "the schedule" : t.startedBy === "owner" ? "you" : "unknown" },
		{ label: "Sources configured", value: t.configured.sources.length ? t.configured.sources.join(", ") : "none — every site is allowed by the agent's own list" },
		{ label: "Source reachability", value: reach.length ? reach.join(" · ") : "no source reported", ...(t.sources.unreachable ? { tone: "warning" as const } : {}) },
		{ label: "Pages read", value: `${t.seen.pages} (${t.seen.snapshots} snapshot${t.seen.snapshots === 1 ? "" : "s"})` },
		{ label: "Results found", value: String(t.seen.findings) },
		{ label: "Leads added to Data", value: `${t.leads.added}${t.leads.recordIds.length ? ` (${t.leads.recordIds.length} record${t.leads.recordIds.length === 1 ? "" : "s"})` : ""}` },
		{ label: "Rejected", value: t.rejections.length ? t.rejections.map((r) => `${r.count} ${r.reason}`).join(" · ") : "none" },
		{ label: "Handoffs emitted", value: `${t.handoffs.emitted} — ${t.handoffs.note}` },
		...(t.warnings.length ? [{ label: "Warnings", value: t.warnings.map((w) => `${w.code} ×${w.count}`).join(" · "), tone: "warning" as const }] : []),
		...(t.errors.length ? [{ label: "Errors", value: t.errors.map((e) => `${e.code} ×${e.count}`).join(" · "), tone: "danger" as const }] : []),
		{ label: "Outcome", value: t.terminal.reason },
	];
}
