/**
 * Is the Original Finder able to keep up? (#1608) Pipeline-health entries beside the queue: a disabled or dead-lettered
 * Scout -> Finder connection, leads the Finder gave up on, and a backlog (the daily research budget used, or leads waiting
 * for a long time). Reports; decides and enables nothing.
 */
import type { Env } from "../../types.js";
import { JOB_LEAD_ORIGINAL_MISSING_EVENT } from "../job-lead-triage.js";
import { finderSettingsFor } from "./settings.js";

export interface FinderFact {
	instanceId: string;
	edgeId: string;
	edgeEnabled: boolean;
	deadLetters: number;
	queued: number;
	failed: number;
	lastFailure: string | null;
	oldestQueuedAt: number | null;
	usedToday: number;
	dailyCap: number;
}

export interface FinderProblem {
	code: "finder_edge_disabled" | "finder_edge_dead_letters" | "finder_failing" | "finder_backlog";
	message: string;
	instanceId: string;
	connectionId?: string;
}

/** The instances that are an Original Finder: targets of a `job.lead.original_missing` connection, enabled or not (#1616). */
export async function finderInstanceIds(env: Env, uid: string): Promise<Set<string>> {
	const { results } = await env.DB.prepare("SELECT DISTINCT target_instance_id AS id FROM agent_connections WHERE user_id = ?1 AND event_type = ?2").bind(uid, JOB_LEAD_ORIGINAL_MISSING_EVENT).all<{ id: string }>();
	return new Set((results ?? []).map((r) => r.id));
}

/** Research runs this Finder started in the last 24 hours (the budget's meter). */
export async function runsStartedToday(env: Env, instanceId: string, userId: string, now = Date.now()): Promise<number> {
	return (await env.DB.prepare("SELECT COUNT(*) AS n FROM local_browser_runs WHERE instance_id = ?1 AND user_id = ?2 AND created_at >= ?3").bind(instanceId, userId, now - 24 * 60 * 60_000).first<{ n: number }>())?.n ?? 0;
}

/** Leads waiting longer than this with budget left mean the machine is not taking them. */
export const FINDER_STALE_AFTER_MS = 2 * 60 * 60_000;

/** Pure: the facts in, every problem out. */
export function finderProblems(facts: readonly FinderFact[], now: number): FinderProblem[] {
	const out: FinderProblem[] = [];
	for (const f of facts) {
		const add = (code: FinderProblem["code"], message: string, connectionId?: string) => out.push({ code, message, instanceId: f.instanceId, ...(connectionId ? { connectionId } : {}) });
		if (!f.edgeEnabled) add("finder_edge_disabled", `The Scout → Original Finder connection ${f.edgeId} is disabled, so leads with no original posting are not researched until it is re-enabled.`, f.edgeId);
		if (f.deadLetters > 0) add("finder_edge_dead_letters", `${f.deadLetters} hand-off${f.deadLetters === 1 ? "" : "s"} to Original Finder ${f.instanceId} on connection ${f.edgeId} failed permanently and can be replayed.`, f.edgeId);
		if (f.failed > 0) add("finder_failing", `Original Finder ${f.instanceId} gave up on ${f.failed} lead${f.failed === 1 ? "" : "s"} after retries (last: ${f.lastFailure ?? "no reason recorded"}).`);
		const capped = f.queued > 0 && f.usedToday >= f.dailyCap;
		const stale = f.queued > 0 && f.oldestQueuedAt !== null && now - f.oldestQueuedAt > FINDER_STALE_AFTER_MS;
		if (capped) add("finder_backlog", `Original Finder ${f.instanceId} has ${f.queued} lead${f.queued === 1 ? "" : "s"} waiting and has used its daily research budget (${f.usedToday} of ${f.dailyCap} runs in 24 hours); they resume as runs age out of the window, or raise dailyCap.`);
		else if (stale) add("finder_backlog", `Original Finder ${f.instanceId} has had ${f.queued} lead${f.queued === 1 ? "" : "s"} waiting for over ${FINDER_STALE_AFTER_MS / 3_600_000} hours. Check that its runner is online (\`pags up\`) and its browser sites are allowed.`);
	}
	return out;
}

/** The facts for every Original Finder connected to these Scouts. */
export async function finderFacts(env: Env, uid: string, scouts: readonly string[], now = Date.now()): Promise<FinderFact[]> {
	if (!scouts.length) return [];
	const marks = scouts.map((_, i) => `?${i + 3}`).join(", ");
	const { results } = await env.DB.prepare(
		`SELECT c.id, c.target_instance_id AS instance_id, c.enabled,
		        (SELECT COUNT(*) FROM agent_connection_deliveries d WHERE d.connection_id = c.id AND d.status = 'dead') AS dead
		   FROM agent_connections c WHERE c.user_id = ?1 AND c.event_type = ?2 AND c.source_instance_id IN (${marks})`,
	).bind(uid, JOB_LEAD_ORIGINAL_MISSING_EVENT, ...scouts).all<{ id: string; instance_id: string; enabled: number; dead: number }>();
	const facts: FinderFact[] = [];
	for (const c of results ?? []) {
		const q = await env.DB.prepare("SELECT SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN state = 'failed' AND updated_at >= ?3 THEN 1 ELSE 0 END) AS failed, MIN(CASE WHEN state = 'queued' THEN created_at END) AS oldest FROM original_finder_leads WHERE instance_id = ?1 AND user_id = ?2")
			.bind(c.instance_id, uid, now - 14 * 24 * 60 * 60_000).first<{ queued: number | null; failed: number | null; oldest: number | null }>().catch(() => null);
		const last = await env.DB.prepare("SELECT detail FROM original_finder_leads WHERE instance_id = ?1 AND user_id = ?2 AND state = 'failed' ORDER BY updated_at DESC LIMIT 1").bind(c.instance_id, uid).first<{ detail: string | null }>().catch(() => null);
		facts.push({
			instanceId: c.instance_id,
			edgeId: c.id,
			edgeEnabled: c.enabled === 1,
			deadLetters: Number(c.dead ?? 0),
			queued: Number(q?.queued ?? 0),
			failed: Number(q?.failed ?? 0),
			lastFailure: last?.detail ?? null,
			oldestQueuedAt: q?.oldest ?? null,
			usedToday: await runsStartedToday(env, c.instance_id, uid, now),
			dailyCap: (await finderSettingsFor(env, c.instance_id, uid)).dailyCap,
		});
	}
	return facts;
}
