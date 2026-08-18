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
import { nextDirection, parseDirection, type AgentDirection, type DirectionAuthor } from "./agent-direction.js";
import { logEvent } from "./events.js";

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
	/**
	 * The standing direction this supervisor holds for this subordinate — an epic (#330).
	 *
	 * Lifted out of `config` rather than left inside it because `config` was a write-only column:
	 * written at create, parsed into this view, and read by nothing. A field a consumer has to go
	 * digging for in an untyped blob is a field the console and the prompt will each parse their
	 * own way, which is how the two end up disagreeing about what the owner set.
	 */
	direction: AgentDirection | null;
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
	const config = parseConfig(row.config);
	return {
		id: row.id,
		supervisorInstanceId: row.supervisor_instance_id,
		subordinateInstanceId: row.subordinate_instance_id,
		enabled: row.enabled !== 0,
		config,
		direction: parseDirection(config),
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

async function readGraph(env: Env, userId: string, enabledOnly: boolean): Promise<SupervisionEdge[]> {
	const res = await env.DB.prepare(
		enabledOnly
			? "SELECT supervisor_instance_id, subordinate_instance_id FROM agent_supervision WHERE user_id = ?1 AND enabled = 1"
			: "SELECT supervisor_instance_id, subordinate_instance_id FROM agent_supervision WHERE user_id = ?1",
	)
		.bind(userId)
		.all<Pick<SupervisionRow, "supervisor_instance_id" | "subordinate_instance_id">>();
	return (res.results ?? []).map((r) => ({
		supervisorInstanceId: r.supervisor_instance_id,
		subordinateInstanceId: r.subordinate_instance_id,
	}));
}

/**
 * The graph that ROUTES — disabled edges excluded (#664).
 *
 * Every caller of this is a run-time routing decision: may this supervisor drive that agent
 * (`delegateToInstance`), who does a stuck run escalate to (`escalationTarget`), which agents does
 * a supervisor's team tool list, whose budget does a delegation belong to (`rootOf`). A paused edge
 * must answer "nobody" to all of them, or `enabled` is a switch that stops one voice-vocabulary
 * read and nothing else — which is what #664 was filed about. The composite index
 * `idx_supervision_supervisor(supervisor_instance_id, enabled)` was built for this predicate in
 * migration 0060; it just never got written.
 *
 * Whole graph, not one instance's slice, because the walks above it (cycle guard, root, depth) can
 * pass through a node the caller never named.
 */
export async function loadGraph(env: Env, userId: string): Promise<SupervisionEdge[]> {
	return readGraph(env, userId, true);
}

/**
 * The graph that is WIRED — disabled edges INCLUDED. Validation only, and the distinction is
 * load-bearing rather than tidy (#664).
 *
 * `idx_supervision_subordinate` is UNIQUE and unconditional, so a paused edge still reserves its
 * subordinate: validating the one-supervisor rule against the routing graph would accept a second
 * parent and then be refused by the index, turning a precise message into a 409. The cycle check
 * has no such backstop and that is the real hazard — with A→B paused, `wouldCreateCycle` on the
 * routing graph accepts B→A, and re-enabling A→B then closes a loop that nothing ever validated.
 * A pause must not be a way to smuggle an illegal edge past the rules.
 */
export async function loadConfiguredGraph(env: Env, userId: string): Promise<SupervisionEdge[]> {
	return readGraph(env, userId, false);
}

/**
 * The owner's edges as views, most recent first; optionally scoped to one supervisor.
 *
 * Deliberately NOT filtered on `enabled` (#664): this is the control surface. An edge hidden while
 * paused is an edge that cannot be resumed, and `enabled` is already on the view for the caller to
 * render.
 */
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

	// The CONFIGURED graph, not the routing one — see `loadConfiguredGraph`. A paused edge still
	// holds its subordinate under the unique index and still becomes a cycle the moment it resumes.
	const graph = await loadConfiguredGraph(env, userId);
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

/**
 * Pause or resume one of the caller's supervision edges (#664).
 *
 * `enabled` had exactly one writer — the literal `1` in the INSERT above — so a column the view
 * publishes as a boolean was a constant, and the only way to stop a supervisor driving an agent was
 * to DELETE the edge. Deleting is not a pause: `config` carries the edge's label, its per-edge
 * budget defaults (#184) and the subordinate's standing DIRECTION (#330), and the direction is the
 * expensive one — it is the epic the owner wrote, provenance-stamped `setBy: "user"`, and the whole
 * point of #330's security boundary is that an agent cannot reproduce it. Re-wiring after a delete
 * means retyping it, and any budget row or trace that referred to the old edge id refers to
 * nothing. Standing a subordinate down while it is being reconfigured is an ordinary act; making it
 * cost the owner's epic is not.
 *
 * Owner-scoped by id alone, matching `deleteSupervision` rather than the direction routes' tighter
 * supervisor scope: this is the reversible form of that delete, and an edge only ever has one
 * supervisor, so naming it adds a way to get a 404 and no safety.
 *
 * Returns the updated view, or null when no row matched (wrong id, or not the caller's).
 */
export async function setSupervisionEnabled(env: Env, userId: string, id: string, enabled: boolean): Promise<SupervisionView | null> {
	const res = await env.DB.prepare("UPDATE agent_supervision SET enabled = ?3, updated_at = datetime('now') WHERE id = ?1 AND user_id = ?2")
		.bind(id, userId, enabled ? 1 : 0)
		.run();
	if ((res.meta?.changes ?? 0) === 0) return null;
	const row = await env.DB.prepare("SELECT * FROM agent_supervision WHERE id = ?1 AND user_id = ?2").bind(id, userId).first<SupervisionRow>();
	if (!row) return null;
	// The pause has to be VISIBLE, which is the half #644 found mattered most. Every consequence of
	// disabling an edge is an ABSENCE — a subordinate missing from the roster, a delegation refused
	// with "that agent is not supervised by this one", an escalation that reaches the human instead
	// of the Lead — and each of those reads exactly like an edge that was never wired. One row in
	// the unified trace (`agent_events`, surfaced by GET /v1/instances/:id/trace) is what lets the
	// owner tell the two apart afterwards.
	await logEvent(env, {
		source: "supervision",
		event: enabled ? "supervision.resumed" : "supervision.paused",
		level: enabled ? "info" : "warn",
		message: enabled
			? `Supervision resumed: ${row.supervisor_instance_id} delegates to ${row.subordinate_instance_id} again`
			: `Supervision paused: ${row.supervisor_instance_id} no longer delegates to ${row.subordinate_instance_id}, and ${row.subordinate_instance_id} escalates past it`,
		userId,
		instanceId: row.supervisor_instance_id,
		context: { supervisionId: row.id, subordinateInstanceId: row.subordinate_instance_id, enabled },
	}).catch(() => undefined);
	return toView(row);
}

/** Remove one of the caller's supervision edges. Returns whether a row went away. */
export async function deleteSupervision(env: Env, userId: string, id: string): Promise<boolean> {
	const res = await env.DB.prepare("DELETE FROM agent_supervision WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
	return (res.meta?.changes ?? 0) > 0;
}

/**
 * The standing direction (#330) for each of a supervisor's subordinates, keyed by subordinate id.
 *
 * One indexed statement (`idx_supervision_supervisor`) rather than a join onto the roster read:
 * the roster query already reads `agent_instances`, and folding a second table into it would make
 * "which agents do I supervise" and "what are they for" fail together. Subordinates without a
 * direction are simply absent from the map — an epic is optional, and most edges will never have
 * one.
 *
 * Filtered on `enabled` (#664) for the same reason the routing graph is: this map is read beside
 * `subordinatesOf` in the supervisor's team tool, and a direction for an agent that same tool
 * cannot delegate to is an instruction with no way to carry it out.
 */
export async function directionsForSupervisor(
	env: Env,
	userId: string,
	supervisorInstanceId: string,
): Promise<Map<string, AgentDirection>> {
	const res = await env.DB.prepare(
		"SELECT subordinate_instance_id, config FROM agent_supervision WHERE user_id = ?1 AND supervisor_instance_id = ?2 AND enabled = 1",
	)
		.bind(userId, supervisorInstanceId)
		.all<{ subordinate_instance_id: string; config: string | null }>();
	const out = new Map<string, AgentDirection>();
	for (const r of res.results ?? []) {
		const d = parseDirection(parseConfig(r.config));
		if (d) out.set(r.subordinate_instance_id, d);
	}
	return out;
}

/**
 * The rows the `## Your Agents` prompt block is built from: who this supervisor supervises, what
 * the owner named them, and what each is FOR.
 *
 * ONE statement, and it runs only for an agent that declares a supervision tool — a prompt block
 * is paid for on every turn, so this is deliberately not the roster read the tools do (which also
 * probes runners, repos and activity). `json_valid` guards the display-name extraction because a
 * malformed instance config must cost that agent its NICKNAME, not the whole block: `json_extract`
 * on invalid JSON is a D1 error, and an error here would take the supervisor's standing direction
 * off its prompt for a reason that has nothing to do with direction.
 *
 * Filtered on `enabled` (#664): this block is the supervisor's answer to "who works for me". A
 * paused agent listed here is one the model will plan around and then be refused when it delegates
 * — the prompt would be describing a team the runtime does not have.
 */
export async function directionRosterFor(
	env: Env,
	userId: string,
	supervisorInstanceId: string,
): Promise<Array<{ instanceId: string; name: string; direction: AgentDirection | null }>> {
	const res = await env.DB.prepare(
		`SELECT s.subordinate_instance_id AS id,
		        s.config AS sup_config,
		        CASE WHEN json_valid(i.config) THEN json_extract(i.config, '$.displayName') END AS display_name,
		        a.name AS agent_name
		   FROM agent_supervision s
		   JOIN agent_instances i ON i.id = s.subordinate_instance_id AND i.user_id = s.user_id
		   LEFT JOIN agents a ON a.id = i.agent_id
		  WHERE s.user_id = ?1 AND s.supervisor_instance_id = ?2 AND s.enabled = 1`,
	)
		.bind(userId, supervisorInstanceId)
		.all<{ id: string; sup_config: string | null; display_name: string | null; agent_name: string | null }>();
	return (res.results ?? []).map((r) => ({
		instanceId: r.id,
		name: (r.display_name || "").trim() || r.agent_name || r.id,
		direction: parseDirection(parseConfig(r.sup_config)),
	}));
}

export interface SetDirectionInput {
	supervisorInstanceId: string;
	/** Address the edge by its own id (the owner's route) … */
	supervisionId?: string;
	/** … or by who it points at (the agent's tool, which resolved a NAME to an instance). */
	subordinateInstanceId?: string;
	/** `null` CLEARS it — owner only, because clearing is how an epic is closed. */
	text: string | null;
	setBy: DirectionAuthor;
}

/**
 * Set, replace or clear one edge's direction.
 *
 * Two things this does not do the obvious way, both deliberate:
 *
 *  • It rewrites the WHOLE `config` blob, but only after re-reading it, and the UPDATE is a
 *    compare-and-swap on the exact bytes that were read. `config` is shared with the per-edge
 *    label and budget defaults, so a blind write here would silently drop whatever a concurrent
 *    writer had just put beside the direction — the same defect `patchInstanceConfig` exists to
 *    prevent on `agent_instances`. A lost CAS is reported, not retried: the loser's own read is
 *    stale, and re-running the `setBy` check against fresh bytes is the caller's decision.
 *  • The owner-vs-agent rule lives in the pure `nextDirection`, not here, so the security-relevant
 *    branch is tested without a database.
 *
 * Its lookup is NOT filtered on `enabled` (#664), unlike the two reads that feed the prompt.
 * Clearing a direction is how the owner closes an epic, and an edge whose direction cannot be
 * cleared while it is paused would have to be resumed to be tidied up. A write here is inert while
 * the edge is down — `directionsForSupervisor` and `directionRosterFor` will not read it back — so
 * the agent path costs nothing either, and the agent cannot reach an edge it can no longer name.
 */
export async function setSupervisionDirection(
	env: Env,
	userId: string,
	input: SetDirectionInput,
): Promise<{ ok: true; supervision: SupervisionView } | { ok: false; status: number; error: string }> {
	const where = input.supervisionId
		? { sql: "SELECT * FROM agent_supervision WHERE id = ?1 AND user_id = ?2 AND supervisor_instance_id = ?3", arg: input.supervisionId }
		: {
				sql: "SELECT * FROM agent_supervision WHERE subordinate_instance_id = ?1 AND user_id = ?2 AND supervisor_instance_id = ?3",
				arg: input.subordinateInstanceId ?? "",
			};
	const row = await env.DB.prepare(where.sql).bind(where.arg, userId, input.supervisorInstanceId).first<SupervisionRow>();
	// 404 covers "no such edge" AND "not yours" AND "not yours to supervise" — the caller may not
	// learn which, because that difference is a probe of another tenant's graph.
	if (!row) return { ok: false, status: 404, error: "supervision link not found" };

	const config = parseConfig(row.config);
	const current = parseDirection(config);
	if (input.text === null) {
		if (input.setBy !== "user") {
			return {
				ok: false,
				status: 403,
				error: "Only the owner can clear an agent's direction — clearing it is how they close it out. Say that you believe it is done and let them.",
			};
		}
		delete config.direction;
	} else {
		const next = nextDirection(current, { text: input.text, setBy: input.setBy });
		if (!next.ok) return { ok: false, status: input.setBy === "user" ? 400 : 403, error: next.error };
		config.direction = next.direction as unknown as Record<string, unknown>;
	}

	const res = await env.DB.prepare(
		`UPDATE agent_supervision SET config = ?1, updated_at = datetime('now')
		  WHERE id = ?2 AND user_id = ?3 AND COALESCE(config, '') = ?4`,
	)
		.bind(JSON.stringify(config), row.id, userId, row.config ?? "")
		.run();
	if ((res.meta?.changes ?? 0) === 0) {
		return { ok: false, status: 409, error: "That supervision link changed while this was being written. Read it again and retry." };
	}
	const fresh = await env.DB.prepare("SELECT * FROM agent_supervision WHERE id = ?1").bind(row.id).first<SupervisionRow>();
	return { ok: true, supervision: toView(fresh as SupervisionRow) };
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
