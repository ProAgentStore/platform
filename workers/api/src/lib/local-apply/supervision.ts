/**
 * Durable cloud-supervisor state for a local application run.
 *
 * The runner has no API credential, so PAGS receives checkpoints while it pulls status through
 * the relay.  Directives are written before relay delivery and are immutable per checkpoint. That
 * gives retries an unambiguous operation: deliver the already-recorded directive, never decide a
 * second time.
 */
import type { Env } from "../../types.js";
import type { LocalApplySupervisorFacts } from "./contract.js";
import type { ApplyRun } from "./store.js";

type DB = Pick<Env, "DB">;

export const SUPERVISOR_SCHEMA_VERSION = 1 as const;
export type SupervisorDirectiveKind = "continue" | "request_review" | "stop";
const DIRECTIVES: readonly SupervisorDirectiveKind[] = ["continue", "request_review", "stop"];
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,300}$/;
const PHASES = new Set<LocalApplySupervisorFacts["phase"]>(["initial", "post_navigation", "before_submit", "uncertain"]);
const BLOCKERS = new Set(["captcha", "login_required", "anti_bot", "missing_answer", "screening_ambiguity", "external_redirect", "duplicate_application"]);
const validCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000;
const validUrl = (value: unknown): value is string => typeof value === "string" && value.length <= 2000 && /^https?:\/\/[^\s/]+/i.test(value);
const validDomain = (value: unknown): value is string => typeof value === "string" && value.length <= 253 && /^[a-z0-9.-]+$/i.test(value);
const validTitle = (value: unknown): value is string => typeof value === "string" && value.length <= 300;

export interface SupervisorCheckpointReceipt {
	schemaVersion: typeof SUPERVISOR_SCHEMA_VERSION;
	checkpointId: string;
	/** Bounded runner-derived evidence for the cloud decision; validated below before persistence. */
	facts: LocalApplySupervisorFacts;
	runnerSeq: number;
}

export interface SupervisorCheckpoint {
	runId: string;
	instanceId: string;
	checkpointId: string;
	schemaVersion: number;
	facts: LocalApplySupervisorFacts;
	runnerSeq: number;
	receivedAt: number;
	directive: SupervisorDirective | null;
}

export interface SupervisorDirective {
	id: string;
	runId: string;
	checkpointId: string;
	schemaVersion: number;
	idempotencyKey: string;
	directive: SupervisorDirectiveKind;
	createdAt: number;
	deliveryAttemptedAt: number | null;
	deliveredAt: number | null;
}

interface CheckpointRow {
	run_id: string;
	instance_id: string;
	checkpoint_id: string;
	schema_version: number;
	facts: string;
	runner_seq: number;
	received_at: number;
	directive_id: string | null;
	directive_schema_version: number | null;
	idempotency_key: string | null;
	directive: SupervisorDirectiveKind | null;
	directive_created_at: number | null;
	delivery_attempted_at: number | null;
	delivered_at: number | null;
}

interface DirectiveRow {
	id: string;
	run_id: string;
	checkpoint_id: string;
	schema_version: number;
	idempotency_key: string;
	directive: SupervisorDirectiveKind;
	created_at: number;
	delivery_attempted_at: number | null;
	delivered_at: number | null;
}

const validId = (value: unknown): value is string => typeof value === "string" && SAFE_ID.test(value);
export const isSupervisorDirective = (value: unknown): value is SupervisorDirectiveKind => DIRECTIVES.includes(value as SupervisorDirectiveKind);

/** Accept only decision evidence the runner derived from bridge state, never arbitrary model text. */
export function sanitizeSupervisorFacts(value: unknown): LocalApplySupervisorFacts | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const facts = value as Record<string, unknown>;
	if (!PHASES.has(facts.phase as LocalApplySupervisorFacts["phase"]) || !validCount(facts.actions) || !validCount(facts.filled) || !validCount(facts.uploaded)) return null;
	if (!Array.isArray(facts.blockers) || facts.blockers.length > BLOCKERS.size || facts.blockers.some((v) => typeof v !== "string" || !BLOCKERS.has(v))) return null;
	if ((facts.url !== undefined && !validUrl(facts.url)) || (facts.domain !== undefined && !validDomain(facts.domain)) || (facts.title !== undefined && !validTitle(facts.title))) return null;
	return {
		phase: facts.phase as LocalApplySupervisorFacts["phase"],
		actions: facts.actions,
		filled: facts.filled,
		uploaded: facts.uploaded,
		blockers: [...new Set(facts.blockers)] as LocalApplySupervisorFacts["blockers"],
		...(facts.url === undefined ? {} : { url: facts.url }),
		...(facts.domain === undefined ? {} : { domain: facts.domain.toLowerCase() }),
		...(facts.title === undefined ? {} : { title: facts.title }),
	};
}

const storedFacts = (raw: string): LocalApplySupervisorFacts => {
	try {
		const parsed = JSON.parse(raw);
		const facts = sanitizeSupervisorFacts(parsed);
		if (facts) return facts;
	} catch {
		// A corrupted D1 row should not turn an owner-scoped read into a worker error.
	}
	return { phase: "uncertain", actions: 0, filled: 0, uploaded: 0, blockers: [] };
};

const presentDirective = (r: DirectiveRow): SupervisorDirective => ({
	id: r.id,
	runId: r.run_id,
	checkpointId: r.checkpoint_id,
	schemaVersion: Number(r.schema_version),
	idempotencyKey: r.idempotency_key,
	directive: r.directive,
	createdAt: r.created_at,
	deliveryAttemptedAt: r.delivery_attempted_at,
	deliveredAt: r.delivered_at,
});

const presentCheckpoint = (r: CheckpointRow): SupervisorCheckpoint => ({
	runId: r.run_id,
	instanceId: r.instance_id,
	checkpointId: r.checkpoint_id,
	schemaVersion: Number(r.schema_version),
	runnerSeq: Number(r.runner_seq),
	receivedAt: r.received_at,
	facts: storedFacts(r.facts),
	directive:
		r.directive_id === null || r.directive_schema_version === null || r.idempotency_key === null || r.directive === null || r.directive_created_at === null
			? null
			: {
				id: r.directive_id,
				runId: r.run_id,
				checkpointId: r.checkpoint_id,
				schemaVersion: Number(r.directive_schema_version),
				idempotencyKey: r.idempotency_key,
				directive: r.directive,
				createdAt: r.directive_created_at,
				deliveryAttemptedAt: r.delivery_attempted_at,
				deliveredAt: r.delivered_at,
			},
});

const checkpointSelect = `SELECT c.run_id, c.instance_id, c.checkpoint_id, c.schema_version, c.facts, c.runner_seq, c.received_at,
 d.id AS directive_id, d.schema_version AS directive_schema_version, d.idempotency_key, d.directive,
 d.created_at AS directive_created_at, d.delivery_attempted_at, d.delivered_at
 FROM local_apply_supervisor_checkpoints c
 LEFT JOIN local_apply_supervisor_directives d ON d.run_id = c.run_id AND d.checkpoint_id = c.checkpoint_id`;

export async function getSupervisorCheckpoint(env: DB, run: Pick<ApplyRun, "id" | "instanceId">, checkpointId: string): Promise<SupervisorCheckpoint | null> {
	const row = await env.DB.prepare(`${checkpointSelect} WHERE c.run_id = ?1 AND c.instance_id = ?2 AND c.checkpoint_id = ?3`)
		.bind(run.id, run.instanceId, checkpointId)
		.first<CheckpointRow>();
	return row ? presentCheckpoint(row) : null;
}

export async function listSupervisorCheckpoints(env: DB, run: Pick<ApplyRun, "id" | "instanceId">): Promise<SupervisorCheckpoint[]> {
	const { results } = await env.DB.prepare(`${checkpointSelect} WHERE c.run_id = ?1 AND c.instance_id = ?2 ORDER BY c.received_at, c.runner_seq, c.checkpoint_id`)
		.bind(run.id, run.instanceId)
		.all<CheckpointRow>();
	return (results ?? []).map(presentCheckpoint);
}

/** Validate and store a runner-reported checkpoint. Repeated status polls return the same row. */
export async function receiveSupervisorCheckpoint(
	env: DB,
	run: Pick<ApplyRun, "id" | "instanceId">,
	userId: string,
	receipt: SupervisorCheckpointReceipt,
	now: number,
): Promise<SupervisorCheckpoint | null> {
	const facts = sanitizeSupervisorFacts(receipt.facts);
	if (receipt.schemaVersion !== SUPERVISOR_SCHEMA_VERSION || !validId(receipt.checkpointId) || !facts || !Number.isInteger(receipt.runnerSeq) || receipt.runnerSeq < 0) return null;
	await env.DB.prepare(
		`INSERT INTO local_apply_supervisor_checkpoints (run_id, instance_id, user_id, checkpoint_id, schema_version, facts, runner_seq, received_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
		 ON CONFLICT(run_id, checkpoint_id) DO NOTHING`,
	)
		.bind(run.id, run.instanceId, userId, receipt.checkpointId, receipt.schemaVersion, JSON.stringify(facts), receipt.runnerSeq, now)
		.run();
	return getSupervisorCheckpoint(env, run, receipt.checkpointId);
}

export type IssueSupervisorDirective =
	| { kind: "issued" | "existing"; directive: SupervisorDirective }
	| { kind: "missing_checkpoint" }
	| { kind: "idempotency_conflict" | "checkpoint_already_directed"; directive: SupervisorDirective };

/**
 * Record exactly one directive for one received checkpoint. An idempotency-key retry of identical
 * intent returns that directive; reusing a key or trying to revise a checkpoint is a conflict.
 */
export async function issueSupervisorDirective(
	env: DB,
	run: Pick<ApplyRun, "id" | "instanceId">,
	userId: string,
	input: { checkpointId: string; schemaVersion: number; idempotencyKey: string; directive: SupervisorDirectiveKind },
	now: number,
): Promise<IssueSupervisorDirective> {
	if (input.schemaVersion !== SUPERVISOR_SCHEMA_VERSION || !validId(input.checkpointId) || !validId(input.idempotencyKey) || !isSupervisorDirective(input.directive)) {
		throw new Error("Invalid supervisor directive input");
	}
	const checkpoint = await getSupervisorCheckpoint(env, run, input.checkpointId);
	if (!checkpoint) return { kind: "missing_checkpoint" };
	const byKey = await env.DB.prepare(
		"SELECT * FROM local_apply_supervisor_directives WHERE run_id = ?1 AND idempotency_key = ?2",
	)
		.bind(run.id, input.idempotencyKey)
		.first<DirectiveRow>();
	if (byKey) {
		const existing = presentDirective(byKey);
		return existing.checkpointId === input.checkpointId && existing.schemaVersion === input.schemaVersion && existing.directive === input.directive
			? { kind: "existing", directive: existing }
			: { kind: "idempotency_conflict", directive: existing };
	}
	const existing = checkpoint.directive;
	if (existing) return { kind: "checkpoint_already_directed", directive: existing };
	const id = crypto.randomUUID();
	await env.DB.prepare(
		`INSERT INTO local_apply_supervisor_directives
		 (id, run_id, checkpoint_id, instance_id, user_id, schema_version, idempotency_key, directive, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
		 ON CONFLICT(run_id, checkpoint_id) DO NOTHING`,
	)
		.bind(id, run.id, input.checkpointId, run.instanceId, userId, input.schemaVersion, input.idempotencyKey, input.directive, now)
		.run();
	let stored = await env.DB.prepare("SELECT * FROM local_apply_supervisor_directives WHERE run_id = ?1 AND checkpoint_id = ?2")
		.bind(run.id, input.checkpointId)
		.first<DirectiveRow>();
	// A racing request can claim this idempotency key for another checkpoint between our first
	// lookup and insert. Return that explicit conflict instead of pretending storage failed.
	if (!stored) stored = await env.DB.prepare("SELECT * FROM local_apply_supervisor_directives WHERE run_id = ?1 AND idempotency_key = ?2")
		.bind(run.id, input.idempotencyKey)
		.first<DirectiveRow>();
	if (!stored) throw new Error("Supervisor directive was not stored");
	const directive = presentDirective(stored);
	if (directive.id === id) return { kind: "issued", directive };
	if (directive.checkpointId !== input.checkpointId || directive.idempotencyKey !== input.idempotencyKey) return { kind: "idempotency_conflict", directive };
	return directive.idempotencyKey === input.idempotencyKey && directive.directive === input.directive && directive.schemaVersion === input.schemaVersion
		? { kind: "existing", directive }
		: { kind: "checkpoint_already_directed", directive };
}

export async function noteSupervisorDirectiveDelivery(env: DB, directive: SupervisorDirective, now: number, delivered: boolean): Promise<SupervisorDirective | null> {
	await env.DB.prepare(
		`UPDATE local_apply_supervisor_directives
		    SET delivery_attempted_at = ?1, delivered_at = CASE WHEN ?2 THEN COALESCE(delivered_at, ?1) ELSE delivered_at END
		  WHERE id = ?3 AND run_id = ?4`,
	)
		.bind(now, delivered ? 1 : 0, directive.id, directive.runId)
		.run();
	const row = await env.DB.prepare("SELECT * FROM local_apply_supervisor_directives WHERE id = ?1 AND run_id = ?2")
		.bind(directive.id, directive.runId)
		.first<DirectiveRow>();
	return row ? presentDirective(row) : null;
}
