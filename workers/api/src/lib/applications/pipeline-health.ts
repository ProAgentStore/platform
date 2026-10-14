/**
 * Is the owner's Scout → Tailor → Runner pipeline able to move work right now? (#1022)
 *
 * Measured live: the Tailor → Runner edge was disabled and nothing said so — `pipelineOf` follows
 * ENABLED edges only, so a member behind a disabled edge simply dropped out of the graph. One Scout
 * had no mailbox and no browser runtime, so it could never find a lead, and the other had not
 * scanned for three days because no schedule existed; both read as healthy (`failureCount: 0`).
 *
 * This reports every such fact as a named problem beside the queue. It decides nothing and enables
 * nothing: re-enabling an edge or binding a mailbox stays the owner's act.
 */
import type { Env } from "../../types.js";
import { capabilitiesForInstance } from "../agent-capabilities.js";
import { GMAIL_SCOUT_SCAN_INTERVAL_MS, getGmailScoutConfig, getGmailScoutScanState } from "../gmail-scout/config.js";
import { emailPermitted } from "../connectors/gmail.js";
import { listGmailScoutReceipts } from "../gmail-scout/receipts.js";
import { gmailLeadIntakeRejection, readGmailScoutLeadRecords } from "../gmail-scout/scan.js";

export { GMAIL_SCOUT_SCAN_INTERVAL_MS };
/** A source silent for longer than two scheduled scans is stale. */
export const SOURCE_STALE_AFTER_MS = 2 * GMAIL_SCOUT_SCAN_INTERVAL_MS;

export type PipelineProblemCode =
	| "edge_disabled"
	| "edge_dead_letters"
	| "no_tailor"
	| "no_runner"
	| "source_unavailable"
	| "source_disabled"
	| "source_email_off"
	| "source_failing"
	| "source_never_scanned"
	| "source_not_scheduled"
	| "source_stale"
	| "source_junk_leads";

export interface PipelineProblem {
	code: PipelineProblemCode;
	message: string;
	instanceId?: string;
	connectionId?: string;
}

export interface SourceHealth {
	instanceId: string;
	/** `gmail` scans a mailbox on a schedule; `browser` is scanned by a local runner; `none` has no source. */
	kind: "gmail" | "browser" | "none";
	ready: boolean;
	scheduled: boolean;
	lastScanAt: string | null;
	lastFailureAt: string | null;
	lastFailureMessage: string | null;
	/** #1023: the latest scan's receipt — scheduled or on demand — so the owner sees what it found. */
	lastReceipt: LatestReceipt | null;
}

/** The parts of a scan receipt health reports: who started it, how it ended, and what it found. */
export interface LatestReceipt {
	id: string;
	trigger: "schedule" | "on_demand" | "reprocess";
	status: "running" | "completed" | "failed";
	completedAt: string | null;
	added: number | null;
	candidates: number | null;
	deduped: number | null;
}

export interface PipelineHealth {
	ok: boolean;
	problems: PipelineProblem[];
	sources: SourceHealth[];
}

export interface EdgeFact {
	id: string;
	eventType: string;
	sourceInstanceId: string;
	targetInstanceId: string;
	enabled: boolean;
	dead: number;
}

export interface SourceFact {
	instanceId: string;
	runtime: string | null;
	gmail: { enabled: boolean; emailPermitted: boolean; lastScanAt: string | null; lastFailureAt: string | null; lastFailureMessage: string | null; lastReceipt?: LatestReceipt | null; junkLeads?: Partial<Record<string, number>> } | null;
	/**
	 * A local-browser Scout's real state (#1022): its `run_local_browser` scan schedule and when a scan
	 * last COMPLETED. Health used to hard-code such a Scout as ready, so one that was never scheduled and
	 * had never scanned read as healthy.
	 */
	browser?: { scheduled: boolean; lastCompletedAt: string | null } | null;
}

/** SQLite `datetime('now')` text is UTC without a zone; read it as UTC. */
const utc = (v: string | null): number => (v ? Date.parse(v.includes("T") ? v : `${v.replace(" ", "T")}Z`) : Number.NaN);
const iso = (v: string | null): string | null => (Number.isFinite(utc(v)) ? new Date(utc(v)).toISOString() : null);

/** Pure: the facts in, every problem out. */
export function pipelineHealthFrom(input: { pipeline: { scouts: string[]; tailors: string[]; runners: string[] }; edges: EdgeFact[]; sources: SourceFact[]; now: number }): PipelineHealth {
	const problems: PipelineProblem[] = [];
	for (const e of input.edges) {
		if (!e.enabled) problems.push({ code: "edge_disabled", connectionId: e.id, message: `The ${e.eventType === "job.application.materials_ready" ? "Tailor → Runner" : "Scout → Tailor"} connection ${e.id} is disabled, so nothing moves along it until it is re-enabled.` });
		if (e.dead > 0) problems.push({ code: "edge_dead_letters", connectionId: e.id, message: `${e.dead} hand-off${e.dead === 1 ? "" : "s"} on connection ${e.id} failed permanently and can be replayed.` });
	}
	if (input.pipeline.scouts.length && !input.pipeline.tailors.length) problems.push({ code: "no_tailor", message: "No Application Tailor is connected, so an approved lead cannot get materials." });
	if (input.pipeline.tailors.length && !input.pipeline.runners.length) problems.push({ code: "no_runner", message: "No Application Runner is connected, so ready materials cannot be filled." });
	const sources: SourceHealth[] = input.sources.map((s) => {
		const g = s.gmail;
		const kind: SourceHealth["kind"] = g ? "gmail" : s.runtime === "local_browser" ? "browser" : "none";
		const b = kind === "browser" ? (s.browser ?? { scheduled: false, lastCompletedAt: null }) : null;
		const lastScanAt = iso(g?.lastScanAt ?? b?.lastCompletedAt ?? null);
		const lastFailureAt = iso(g?.lastFailureAt ?? null);
		const failing = !!lastFailureAt && (!lastScanAt || Date.parse(lastFailureAt) >= Date.parse(lastScanAt));
		const add = (code: PipelineProblemCode, message: string) => problems.push({ code, instanceId: s.instanceId, message });
		// No workaround (#1022): there is no cloud job-board scanner, and the job boards refuse server
		// requests (SEEK and Indeed answered the agent's fetches with HTTP 403). Name the supported sources.
		if (kind === "none") add("source_unavailable", `Scout ${s.instanceId} has no mailbox configured and no browser runtime, so it cannot find new leads. Job boards are not scanned from the cloud (SEEK and Indeed refuse server requests with HTTP 403): bind a Gmail mailbox that receives job alerts, or run a local browser runtime with \`pags up\`.`);
		else if (g && !g.enabled) add("source_disabled", `Scout ${s.instanceId}'s Gmail source is disabled.`);
		else if (g && !g.emailPermitted) add("source_email_off", `Scout ${s.instanceId} cannot read its mailbox: email access is switched off.`);
		else if (g && failing) add("source_failing", `Scout ${s.instanceId}'s last scan failed: ${g.lastFailureMessage ?? "no reason recorded"}.`);
		else if (g && !lastScanAt) add("source_never_scanned", `Scout ${s.instanceId} has never scanned its mailbox.`);
		else if (g && lastScanAt && input.now - Date.parse(lastScanAt) > SOURCE_STALE_AFTER_MS) add("source_stale", `Scout ${s.instanceId} last scanned at ${lastScanAt}, more than ${SOURCE_STALE_AFTER_MS / 3_600_000} hours ago.`);
		// #1022: a browser Scout scans only when its local runner is told to — by a schedule, or by hand.
		if (b && !b.scheduled) add("source_not_scheduled", `Scout ${s.instanceId} has no enabled scan schedule, so it searches only when a run is started by hand. Set a cadence (a run_local_browser trigger) to have it search by itself.`);
		if (b && !lastScanAt) add("source_never_scanned", `Scout ${s.instanceId} has never completed a browser scan.`);
		// #1022: leads stored before the concrete-job intake rules are still in the queue offering "apply".
		// Reported, never archived here — archiving is terminal and stays the owner's decision.
		const junk = Object.entries(g?.junkLeads ?? {}).filter(([, n]) => (n ?? 0) > 0);
		const junkTotal = junk.reduce((sum, [, n]) => sum + (n ?? 0), 0);
		if (junkTotal) add("source_junk_leads", `Scout ${s.instanceId} holds ${junkTotal} stored lead${junkTotal === 1 ? "" : "s"} that today's intake rules reject (${junk.map(([reason, n]) => `${n} ${reason.replace(/_/g, " ")}`).join(", ")}). They are not concrete jobs; archive them rather than apply.`);
		const ready = (!!b && b.scheduled && !!lastScanAt) || (!!g && g.enabled && g.emailPermitted && !failing && !!lastScanAt && input.now - Date.parse(lastScanAt) <= SOURCE_STALE_AFTER_MS);
		return { instanceId: s.instanceId, kind, ready, scheduled: b ? b.scheduled : !!g && g.enabled, lastScanAt, lastFailureAt, lastFailureMessage: g?.lastFailureMessage ?? null, lastReceipt: g?.lastReceipt ?? null };
	});
	return { ok: problems.length === 0, problems, sources };
}

/** Read the facts for the queue's pipeline and judge them. */
export async function pipelineHealth(env: Env, uid: string, pipeline: { scouts: string[]; tailors: string[]; runners: string[] }, edges: EdgeFact[], now = Date.now()): Promise<PipelineHealth> {
	const sources = await Promise.all(
		pipeline.scouts.map(async (instanceId): Promise<SourceFact> => {
			const [caps, config, state, receipts] = await Promise.all([capabilitiesForInstance(env, instanceId, uid), getGmailScoutConfig(env, instanceId), getGmailScoutScanState(env, instanceId), listGmailScoutReceipts(env, instanceId, 1)]);
			const r = receipts[0];
			const lastReceipt: LatestReceipt | null = r ? { id: r.id, trigger: r.trigger, status: r.status, completedAt: r.completedAt, added: r.added, candidates: r.candidates, deduped: r.deduped } : null;
			const gmail = config
				? { enabled: config.enabled, emailPermitted: await emailPermitted(env, instanceId).catch(() => false), lastScanAt: state.lastScanAt, lastFailureAt: state.lastFailureAt, lastFailureMessage: state.lastFailureMessage, lastReceipt, junkLeads: await junkLeadsOf(env, instanceId) }
				: null;
			const browser = !gmail && caps?.runtime === "local_browser" ? await browserSourceOf(env, instanceId, uid) : null;
			return { instanceId, runtime: caps?.runtime ?? null, gmail, browser };
		}),
	);
	return pipelineHealthFrom({ pipeline, edges, sources, now });
}

/**
 * Untouched Gmail leads (`new`/`unverified`) that today's intake rules would reject, by reason.
 * Undefined when the collection cannot be read: unknown is not "none".
 */
async function junkLeadsOf(env: Env, instanceId: string): Promise<Partial<Record<string, number>> | undefined> {
	const records = await readGmailScoutLeadRecords(env, instanceId).catch(() => null);
	if (!records) return undefined;
	const out: Partial<Record<string, number>> = {};
	for (const r of records) {
		const data = r.data ?? {};
		if (data.status !== "new" && data.status !== "unverified") continue;
		const reason = gmailLeadIntakeRejection(data);
		if (reason) out[reason] = (out[reason] ?? 0) + 1;
	}
	return out;
}

/** A local-browser Scout's scan schedule and its latest COMPLETED scan (#1022), owner-scoped. */
async function browserSourceOf(env: Env, instanceId: string, uid: string): Promise<{ scheduled: boolean; lastCompletedAt: string | null }> {
	// The trigger is `local-browser/schedule.ts`'s SCAN_TRIGGER_ACTION; read here, not through that module,
	// which imports triggers.ts — an import cycle back through the application queue.
	const [schedule, last] = await Promise.all([
		env.DB.prepare("SELECT 1 AS on_ FROM agent_triggers WHERE instance_id = ?1 AND user_id = ?2 AND type = 'cron' AND action = 'run_local_browser' AND enabled = 1 LIMIT 1")
			.bind(instanceId, uid)
			.first<{ on_: number }>()
			.catch(() => null),
		env.DB.prepare("SELECT MAX(ended_at) AS ended FROM local_browser_runs WHERE instance_id = ?1 AND user_id = ?2 AND status = 'completed'")
			.bind(instanceId, uid)
			.first<{ ended: number | null }>()
			.catch(() => null),
	]);
	return { scheduled: !!schedule, lastCompletedAt: last?.ended ? new Date(last.ended).toISOString() : null };
}
