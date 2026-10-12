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
import { getGmailScoutConfig, getGmailScoutScanState } from "../gmail-scout/config.js";
import { emailPermitted } from "../connectors/gmail.js";
import { listGmailScoutReceipts } from "../gmail-scout/receipts.js";

/** Scheduled Gmail scans run this often (see `runDueGmailScoutScans`); a source silent for longer is stale. */
export const GMAIL_SCOUT_SCAN_INTERVAL_MS = 6 * 60 * 60_000;
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
	| "source_stale";

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
	trigger: "schedule" | "on_demand";
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
	gmail: { enabled: boolean; emailPermitted: boolean; lastScanAt: string | null; lastFailureAt: string | null; lastFailureMessage: string | null; lastReceipt?: LatestReceipt | null } | null;
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
		const lastScanAt = iso(g?.lastScanAt ?? null);
		const lastFailureAt = iso(g?.lastFailureAt ?? null);
		const failing = !!lastFailureAt && (!lastScanAt || Date.parse(lastFailureAt) >= Date.parse(lastScanAt));
		const add = (code: PipelineProblemCode, message: string) => problems.push({ code, instanceId: s.instanceId, message });
		if (kind === "none") add("source_unavailable", `Scout ${s.instanceId} has no mailbox configured and no browser runtime, so it cannot find new leads.`);
		else if (g && !g.enabled) add("source_disabled", `Scout ${s.instanceId}'s Gmail source is disabled.`);
		else if (g && !g.emailPermitted) add("source_email_off", `Scout ${s.instanceId} cannot read its mailbox: email access is switched off.`);
		else if (g && failing) add("source_failing", `Scout ${s.instanceId}'s last scan failed: ${g.lastFailureMessage ?? "no reason recorded"}.`);
		else if (g && !lastScanAt) add("source_never_scanned", `Scout ${s.instanceId} has never scanned its mailbox.`);
		else if (g && lastScanAt && input.now - Date.parse(lastScanAt) > SOURCE_STALE_AFTER_MS) add("source_stale", `Scout ${s.instanceId} last scanned at ${lastScanAt}, more than ${SOURCE_STALE_AFTER_MS / 3_600_000} hours ago.`);
		const ready = kind === "browser" || (!!g && g.enabled && g.emailPermitted && !failing && !!lastScanAt && input.now - Date.parse(lastScanAt) <= SOURCE_STALE_AFTER_MS);
		return { instanceId: s.instanceId, kind, ready, scheduled: !!g && g.enabled, lastScanAt, lastFailureAt, lastFailureMessage: g?.lastFailureMessage ?? null, lastReceipt: g?.lastReceipt ?? null };
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
				? { enabled: config.enabled, emailPermitted: await emailPermitted(env, instanceId).catch(() => false), lastScanAt: state.lastScanAt, lastFailureAt: state.lastFailureAt, lastFailureMessage: state.lastFailureMessage, lastReceipt }
				: null;
			return { instanceId, runtime: caps?.runtime ?? null, gmail };
		}),
	);
	return pipelineHealthFrom({ pipeline, edges, sources, now });
}
