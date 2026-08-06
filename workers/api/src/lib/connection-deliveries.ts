/**
 * The pump's outbox — at-least-once delivery for agent-to-agent events (migration 0058).
 *
 * `deliverEvent` used to run inline and best-effort: a target action that threw was logged
 * and the event was gone. That is at-most-once, which is the wrong guarantee for a chain
 * (lead → site → outreach), because a single transient failure drops a lead partway with
 * nothing anywhere recording it.
 *
 * The shape here is the standard one:
 *   1. ENQUEUE every delivery (persisted) before attempting anything.
 *   2. Attempt immediately — the happy path stays as fast as it was.
 *   3. On failure, back off and leave it pending; the per-minute cron retries.
 *   4. After MAX_ATTEMPTS mark it `dead` — visible and replayable, never silent.
 *
 * The pure parts (backoff schedule, idempotency key, retry decision) live here without env
 * so they are unit-testable; the D1 access is thin around them.
 */
import type { Env } from "../types.js";
import { stableStringify } from "./stable-json.js";

/** How many times a delivery is attempted before it becomes a dead letter. */
export const MAX_ATTEMPTS = 5;

/**
 * Backoff before attempt N (1-indexed), in seconds: ~1m, 5m, 15m, 1h, 3h.
 * Spread wide deliberately — the failures this retries through are outages of someone
 * else's service (a builder MCP, a model provider), which resolve in minutes-to-hours, not
 * milliseconds. Retrying tightly would just burn attempts before the dependency is back.
 */
export function backoffSeconds(attempt: number): number {
	const schedule = [60, 300, 900, 3600, 10800];
	return schedule[Math.min(Math.max(attempt, 1), schedule.length) - 1];
}

/** Whether a delivery with `attemptsSpent` attempts behind it may be tried again. */
export function canRetry(attemptsSpent: number): boolean {
	return attemptsSpent < MAX_ATTEMPTS;
}

/** FNV-1a, 32-bit, hex. Enough to key an outbox row; not a security hash. */
function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/**
 * The key that makes retrying safe. Scoped to (connection, emitting run, payload):
 *
 *  • Two emissions of the same record inside ONE run collide → the consumer's expensive,
 *    irreversible work (creating a site, spending tokens) happens once.
 *  • A deliberate RE-RUN of the source pipeline is a different intent and gets a new
 *    `traceId`, so it delivers again rather than being suppressed forever.
 *
 * Without a run id (an ad-hoc emit) we fall back to the payload alone, which is the
 * conservative choice: duplicates suppress rather than double-charge.
 */
export function idempotencyKey(connectionId: string, traceId: string | null | undefined, payload: unknown): string {
	return `${connectionId}:${traceId ?? "adhoc"}:${fnv1a(stableStringify(payload))}`;
}

export interface DeliveryRow {
	id: string;
	connection_id: string;
	/** 'connection' | 'trigger' (#17). Older rows predate the column and read as 'connection'. */
	source?: string | null;
	user_id: string;
	source_instance_id: string;
	target_instance_id: string;
	event_type: string;
	action: string;
	payload: string;
	config: string | null;
	idempotency_key: string;
	trace_id: string | null;
	status: string;
	attempts: number;
	next_attempt_at: string | null;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

/** What kind of edge produced a durable attempt. Triggers share this outbox (#17) rather than
 *  growing a second one with its own backoff table and dead-letter concept. */
export type DeliverySource = "connection" | "trigger";

export interface EnqueueInput {
	/** The producing edge: a connection id, or a trigger id when `source` is "trigger". */
	connectionId: string;
	source?: DeliverySource;
	userId: string;
	sourceInstanceId: string;
	targetInstanceId: string;
	eventType: string;
	action: string;
	payload: unknown;
	config: Record<string, unknown>;
	traceId?: string | null;
	/** The caller will attempt this delivery inline — hold it off the cron sweep meanwhile. */
	claimedInline?: boolean;
}

/**
 * Persist a delivery. Returns the CLAIM the caller's inline attempt should present when it
 * writes an outcome, or null when an identical one already exists — `INSERT OR IGNORE` on the
 * unique idempotency key is what collapses a duplicate emission, so the caller simply doesn't
 * attempt it.
 */
export async function enqueueDelivery(env: Env, input: EnqueueInput): Promise<DeliveryClaim | null> {
	const id = crypto.randomUUID();
	const key = idempotencyKey(input.connectionId, input.traceId, input.payload);
	const now = new Date().toISOString();
	// A caller that will attempt this delivery INLINE (deliverEvent) pre-claims it, so the
	// per-minute cron can't see the freshly-inserted row as due and run the same delivery
	// concurrently. If the inline attempt dies before writing an outcome, the hold lapses and the
	// sweep picks it up — nothing is stranded. Callers that only enqueue (a failed trigger being
	// handed to the outbox) leave it due now, so the normal ~1m backoff applies.
	const dueAt = input.claimedInline ? new Date(Date.now() + CLAIM_HOLD_MS).toISOString() : now;
	const res = await env.DB.prepare(
		`INSERT OR IGNORE INTO agent_connection_deliveries
       (id, connection_id, source, user_id, source_instance_id, target_instance_id, event_type, action,
        payload, config, idempotency_key, trace_id, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?1, ?2, ?13, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', 0, ?14, ?12, ?12)`,
	)
		.bind(
			id,
			input.connectionId,
			input.userId,
			input.sourceInstanceId,
			input.targetInstanceId,
			input.eventType,
			input.action,
			JSON.stringify(input.payload ?? null),
			JSON.stringify(input.config ?? {}),
			key,
			input.traceId ?? null,
			now,
			// #17: the outbox is shared with triggers now. Defaults to 'connection' so every
			// existing caller is unchanged.
			input.source ?? "connection",
			dueAt,
		)
		.run();
	// `dueAt` is this row's `next_attempt_at`, so it doubles as the inline attempt's claim —
	// the same value `claimDelivery` would have written had the cron got there first.
	return (res.meta?.changes ?? 0) > 0 ? { id, hold: dueAt } : null;
}

/**
 * A held claim on one delivery — the identity a terminal write must present.
 *
 * `hold` is the exact `next_attempt_at` the claimer wrote. Any completed attempt clears or
 * rewrites that column, so presenting a stale `hold` is precisely "someone else already finished
 * with this row". No new column, no migration: the CAS value IS the claim token.
 */
export interface DeliveryClaim {
	id: string;
	hold: string;
}

/**
 * What a failed attempt should do next. Pure so the bound is testable without a database.
 *
 * `attemptsSpent` is the count INCLUDING the attempt that just failed.
 */
export function planNextAttempt(attemptsSpent: number, now: Date): { outcome: "retrying"; nextAttemptAt: string } | { outcome: "dead" } {
	if (!canRetry(attemptsSpent)) return { outcome: "dead" };
	return { outcome: "retrying", nextAttemptAt: new Date(now.getTime() + backoffSeconds(attemptsSpent) * 1000).toISOString() };
}

/**
 * The guard both terminal writes carry (#239).
 *
 * `claimDelivery` stopped two sweeps STARTING the same delivery, but the writes that END an
 * attempt keyed on `id` alone. A slow attempt that outlived its 5-minute hold could therefore
 * still corrupt the row after another attempt had finished with it:
 *
 *  • a `delivered` row pushed back to `pending` and delivered a THIRD time — site-builder
 *    building and billing twice, which is exactly what the outbox promises it prevents;
 *  • a `dead` row overwritten as `delivered`, so a real failure vanished from `?status=dead`
 *    and from replay;
 *  • two overlapping attempts both writing a stale absolute `attempts`, so the counter never
 *    advanced and MAX_ATTEMPTS was never reached — retrying forever, the opposite of the
 *    bounded at-least-once contract.
 *
 * Requiring `status = 'pending'` AND the claimer's own `next_attempt_at` makes a late writer a
 * no-op instead. Same shape as `saveJob()` matching `startedAt` in the repo-ingest alarm, and
 * the actionable-ticket runner's atomic status claim.
 */
const CLAIM_GUARD = "status = 'pending' AND next_attempt_at IS";

/**
 * Mark a delivery successfully delivered. Returns false when the claim is stale — another
 * attempt already finished with this row and nothing was written.
 */
export async function markDelivered(env: Env, claim: DeliveryClaim): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE agent_connection_deliveries
     SET status = 'delivered', attempts = attempts + 1, next_attempt_at = NULL,
         last_error = NULL, updated_at = ?2
     WHERE id = ?1 AND ${CLAIM_GUARD} ?3`,
	)
		.bind(claim.id, new Date().toISOString(), claim.hold)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/**
 * Record a failed attempt: schedule the next one, or dead-letter when the attempts are spent.
 * Returns what happened so the caller can log it accurately, or "stale" when the claim no longer
 * holds — a late writer must not resurrect a row another attempt already settled.
 *
 * `attempts` is the count BEFORE this attempt; the write increments RELATIVELY (`attempts + 1`)
 * rather than storing that read-back absolute, so the counter cannot stall at a stale value.
 */
export async function markAttemptFailed(env: Env, claim: DeliveryClaim, attempts: number, error: string, now = new Date()): Promise<"retrying" | "dead" | "stale"> {
	const plan = planNextAttempt(attempts + 1, now); // this attempt is now spent
	const res =
		plan.outcome === "dead"
			? await env.DB.prepare(
					`UPDATE agent_connection_deliveries
       SET status = 'dead', attempts = attempts + 1, next_attempt_at = NULL, last_error = ?2, updated_at = ?3
       WHERE id = ?1 AND ${CLAIM_GUARD} ?4`,
				)
					.bind(claim.id, error.slice(0, 2000), now.toISOString(), claim.hold)
					.run()
			: await env.DB.prepare(
					`UPDATE agent_connection_deliveries
     SET status = 'pending', attempts = attempts + 1, next_attempt_at = ?2, last_error = ?3, updated_at = ?4
     WHERE id = ?1 AND ${CLAIM_GUARD} ?5`,
				)
					.bind(claim.id, plan.nextAttemptAt, error.slice(0, 2000), now.toISOString(), claim.hold)
					.run();
	if ((res.meta?.changes ?? 0) === 0) return "stale";
	return plan.outcome;
}

/**
 * How long a claimed delivery is held before it becomes due again.
 *
 * Long enough for the slowest attempt (starting a consumer pipeline / DO fetch) to finish, short
 * enough that an attempt killed mid-flight by an isolate reset comes back rather than stranding.
 */
const CLAIM_HOLD_MS = 5 * 60 * 1000;

/**
 * Claim a delivery for THIS attempt. Returns false when someone else already has it.
 *
 * Compare-and-swap on `next_attempt_at`, exactly the trick `runDueTriggers` uses on
 * `next_run_at` — and for the same reason. Without it the sweep SELECTed due rows and only wrote
 * `status` AFTER the action completed, so nothing stopped two runs executing the same delivery:
 * the cron is `* * * * *`, `enqueueDelivery` inserts with `next_attempt_at = now` and the caller
 * then attempts it INLINE, and a sweep of 25 rows each starting a Workflow can easily exceed 60s
 * and overlap the next tick. A `run_pipeline` delivery executed twice means the consuming
 * pipeline runs twice — site-builder builds and bills BYOK tokens twice, site-deploy deploys
 * twice — and both attempts then `markDelivered`, so nothing records that it happened. That
 * directly breaks the stated "the consumer's irreversible work can't happen twice".
 *
 * The idempotency key protects the ENQUEUE, not the attempt; this protects the attempt.
 *
 * Pushing `next_attempt_at` forward (rather than moving to an `attempting` status) keeps the row
 * recoverable: if the attempt dies without writing an outcome, it simply becomes due again.
 *
 * The hold it writes is returned as the attempt's CLAIM, which both terminal writes must present
 * (#239) — so an attempt that outlives its hold can no longer overwrite a newer outcome.
 */
export async function claimDelivery(env: Env, row: DeliveryRow, now = new Date()): Promise<DeliveryClaim | null> {
	const hold = new Date(now.getTime() + CLAIM_HOLD_MS).toISOString();
	const res = await env.DB.prepare(
		`UPDATE agent_connection_deliveries SET next_attempt_at = ?2, updated_at = ?3
       WHERE id = ?1 AND status = 'pending' AND next_attempt_at IS ?4`,
	)
		.bind(row.id, hold, now.toISOString(), row.next_attempt_at)
		.run();
	return (res.meta?.changes ?? 0) > 0 ? { id: row.id, hold } : null;
}

/** Pending deliveries whose next attempt is due (the cron sweep's only read). */
export async function dueDeliveries(env: Env, now = new Date(), limit = 25): Promise<DeliveryRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT * FROM agent_connection_deliveries
     WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
     ORDER BY next_attempt_at ASC LIMIT ?2`,
	)
		.bind(now.toISOString(), limit)
		.all<DeliveryRow>();
	return results ?? [];
}

/** One delivery, owner-scoped. */
export async function getDelivery(env: Env, userId: string, id: string): Promise<DeliveryRow | null> {
	return await env.DB.prepare("SELECT * FROM agent_connection_deliveries WHERE id = ?1 AND user_id = ?2")
		.bind(id, userId)
		.first<DeliveryRow>();
}

/** The owner's deliveries, most recent first; optionally narrowed to one status. */
export async function listDeliveries(
	env: Env,
	userId: string,
	opts: { status?: string; limit?: number } = {},
): Promise<DeliveryRow[]> {
	const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
	const stmt = opts.status
		? env.DB.prepare("SELECT * FROM agent_connection_deliveries WHERE user_id = ?1 AND status = ?2 ORDER BY created_at DESC LIMIT ?3").bind(userId, opts.status, limit)
		: env.DB.prepare("SELECT * FROM agent_connection_deliveries WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2").bind(userId, limit);
	const { results } = await stmt.all<DeliveryRow>();
	return results ?? [];
}

/** Re-arm a dead delivery for immediate retry (the owner-facing replay). */
export async function replayDelivery(env: Env, userId: string, id: string): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE agent_connection_deliveries
     SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ?3
     WHERE id = ?1 AND user_id = ?2 AND status = 'dead'`,
	)
		.bind(id, userId, new Date().toISOString())
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/** Parse a stored JSON column back to a record (tolerant — a malformed row yields {}). */
export function parseJsonColumn(s: string | null): Record<string, unknown> {
	if (!s) return {};
	try {
		const v = JSON.parse(s);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
