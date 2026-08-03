// Supervision edges in D1 (#183, migration 0060). The RULES live in the pure
// `supervision-graph.ts`; this module is the store around them — ownership checks, persistence,
// and loading the owner's graph so those rules can be applied before an edge is written.
//
// Everything is owner-scoped. Both endpoints of an edge must belong to the caller, so a user's
// graph can never contain another tenant's instance and validation can never leak one.

import type { Env } from "../types.js";
import {
	validateEdge,
	subordinatesOf,
	supervisorOf,
	rootOf,
	type SupervisionEdge,
} from "./supervision-graph.js";

interface SupervisionRow {
	id: string;
	user_id: string;
	supervisor_instance_id: string;
	subordinate_instance_id: string;
	enabled: number;
	config: string | null;
	created_at: string;
	updated_at: string;
}

export interface SupervisionView {
	id: string;
	supervisorInstanceId: string;
	subordinateInstanceId: string;
	enabled: boolean;
	config: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

function parseConfig(raw: string | null): Record<string, unknown> {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw) as unknown;
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function toView(row: SupervisionRow): SupervisionView {
	return {
		id: row.id,
		supervisorInstanceId: row.supervisor_instance_id,
		subordinateInstanceId: row.subordinate_instance_id,
		enabled: row.enabled !== 0,
		config: parseConfig(row.config),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

async function ownsInstance(env: Env, instanceId: string, userId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ id: string }>();
	return !!row;
}

/** Every edge the owner has. Cycle and depth checks need the WHOLE graph, not one instance's
 *  slice — a loop can close through a node the new edge never mentions. */
export async function loadGraph(env: Env, userId: string): Promise<SupervisionEdge[]> {
	const res = await env.DB.prepare(
		"SELECT supervisor_instance_id, subordinate_instance_id FROM agent_supervision WHERE user_id = ?1",
	)
		.bind(userId)
		.all<Pick<SupervisionRow, "supervisor_instance_id" | "subordinate_instance_id">>();
	return (res.results ?? []).map((r) => ({
		supervisorInstanceId: r.supervisor_instance_id,
		subordinateInstanceId: r.subordinate_instance_id,
	}));
}

/** The owner's edges as views, most recent first; optionally scoped to one supervisor. */
export async function listSupervision(
	env: Env,
	userId: string,
	opts: { supervisorInstanceId?: string } = {},
): Promise<SupervisionView[]> {
	const stmt = opts.supervisorInstanceId
		? env.DB.prepare(
				"SELECT * FROM agent_supervision WHERE user_id = ?1 AND supervisor_instance_id = ?2 ORDER BY created_at DESC",
			).bind(userId, opts.supervisorInstanceId)
		: env.DB.prepare("SELECT * FROM agent_supervision WHERE user_id = ?1 ORDER BY created_at DESC").bind(userId);
	const res = await stmt.all<SupervisionRow>();
	return (res.results ?? []).map(toView);
}

export interface CreateSupervisionInput {
	supervisorInstanceId: string;
	subordinateInstanceId: string;
	config?: Record<string, unknown>;
}

/**
 * Wire a supervisor over a subordinate.
 *
 * Validation happens HERE, at wiring time, because every rejection case (cycle, tower, fan-out,
 * two managers) is invisible at run time until it has already cost money. The unique index on
 * `subordinate_instance_id` backs the one-supervisor rule in the schema too, so a race between
 * two concurrent writes cannot produce a second parent.
 */
export async function createSupervision(
	env: Env,
	userId: string,
	input: CreateSupervisionInput,
): Promise<{ ok: true; supervision: SupervisionView } | { ok: false; status: number; error: string }> {
	const supervisorInstanceId = (input.supervisorInstanceId || "").trim();
	const subordinateInstanceId = (input.subordinateInstanceId || "").trim();
	if (!supervisorInstanceId || !subordinateInstanceId) {
		return { ok: false, status: 400, error: "supervisorInstanceId and subordinateInstanceId are required" };
	}
	if (!(await ownsInstance(env, supervisorInstanceId, userId))) {
		return { ok: false, status: 404, error: "supervisor instance not found" };
	}
	if (!(await ownsInstance(env, subordinateInstanceId, userId))) {
		return { ok: false, status: 404, error: "subordinate instance not found" };
	}

	const graph = await loadGraph(env, userId);
	const check = validateEdge(graph, supervisorInstanceId, subordinateInstanceId);
	if (!check.ok) return { ok: false, status: 400, error: check.message ?? "Invalid supervision link" };

	const id = crypto.randomUUID();
	try {
		await env.DB.prepare(
			`INSERT INTO agent_supervision (id, user_id, supervisor_instance_id, subordinate_instance_id, config, enabled, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, 1, datetime('now'), datetime('now'))`,
		)
			.bind(id, userId, supervisorInstanceId, subordinateInstanceId, JSON.stringify(input.config ?? {}))
			.run();
	} catch {
		// The unique index fired — another writer added a supervisor for this subordinate between
		// our validation and our insert. Report the rule, not a raw SQL error.
		return { ok: false, status: 409, error: "That agent already reports to another supervisor." };
	}
	const row = await env.DB.prepare("SELECT * FROM agent_supervision WHERE id = ?1").bind(id).first<SupervisionRow>();
	return { ok: true, supervision: toView(row as SupervisionRow) };
}

/** Remove one of the caller's supervision edges. Returns whether a row went away. */
export async function deleteSupervision(env: Env, userId: string, id: string): Promise<boolean> {
	const res = await env.DB.prepare("DELETE FROM agent_supervision WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
	return (res.meta?.changes ?? 0) > 0;
}

/** Direct reports of a supervisor — what a supervisor's brain reads each turn to decide. */
export async function subordinateIdsOf(env: Env, userId: string, supervisorInstanceId: string): Promise<string[]> {
	return subordinatesOf(await loadGraph(env, userId), supervisorInstanceId);
}

/** The instance a subordinate escalates to, or null at the root (escalate to the human). */
export async function supervisorIdOf(env: Env, userId: string, subordinateInstanceId: string): Promise<string | null> {
	return supervisorOf(await loadGraph(env, userId), subordinateInstanceId);
}

/** Top of the tree an instance belongs to — the node that owns the delegation's budget (#184)
 *  and its trace, so spend is attributed to the work that started it rather than to whichever
 *  node happened to run last. */
export async function rootInstanceOf(env: Env, userId: string, instanceId: string): Promise<string> {
	return rootOf(await loadGraph(env, userId), instanceId);
}
