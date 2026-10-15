/**
 * Durable recovery for telemetry that its primary store refused (#1084).
 *
 * Every telemetry writer was best-effort and its fallback was `console`: `logError` /
 * `logEvent` / `recordAdminAction` write D1, the MCP audit writes KV, and a failed write was a
 * console line — gone. This is the second leg: a record the primary refused is SPOOLED in the OTHER
 * failure domain and replayed by the per-minute cron until it lands, or is declared dead and counted.
 *
 *   D1 sinks (`error_log`, `agent_events`, `admin_audit_log`) spool to KV — a D1 outage cannot take
 *   the spool down with it. The MCP audit lives in KV, and its only failure the MCP Worker can
 *   recover is a PARTIAL index write (one of its two keys); that is spooled here too, under the
 *   same KV, and the API cron reconciles it. A whole-KV outage in the MCP Worker has no second
 *   store to fall back to, and is reported as loss rather than hidden.
 *
 * Rules this module keeps:
 *   - STABLE IDS. A record is spooled under the id it would have had in the primary store, and is
 *     replayed with `INSERT … ON CONFLICT(id) DO NOTHING` (KV: the same key and value). Replaying
 *     the same record twice — a retry after a lost response, two cron ticks — cannot write a
 *     second fact.
 *   - NO RECURSION. Nothing here calls `logError` / `logEvent`; its own failures go to `console`.
 *   - BOUNDED. At most {@link MAX_SPOOL_PER_SINK} pending records per sink, each with a TTL; a record
 *     that cannot be spooled is COUNTED as lost per sink per day, so loss is a number, not silence.
 *   - SAME CONTENT. A spooled record is the exact row the sink would have written — already clipped
 *     and redacted by that sink — so ADR 0004's metadata-only policy and each table's retention hold.
 */
import type { Env } from "../types.js";

export type TelemetrySink = "error_log" | "agent_events" | "admin_audit_log" | "mcp_audit";
export const TELEMETRY_SINKS: readonly TelemetrySink[] = ["error_log", "agent_events", "admin_audit_log", "mcp_audit"];

/** What a telemetry write did, told truthfully to whoever asks (#1084). */
export type TelemetryWrite = "persisted" | "queued" | "lost";

/** Pending records per sink. One KV list page, so the capacity check is one call. */
export const MAX_SPOOL_PER_SINK = 1000;
/** Replay attempts before a record is declared dead. */
export const MAX_ATTEMPTS = 5;
/** Wait before attempt n+1 (after n failures). */
export const BACKOFF_MS = [5_000, 30_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
/** A spooled record outlives every backoff above with room to spare, then expires. */
export const SPOOL_TTL_SECONDS = 7 * 86_400;
/** Dead records and loss counters are kept as long as the error log itself (30 days). */
export const DEAD_TTL_SECONDS = 30 * 86_400;
/** Due records replayed per sink per cron tick — the cron shares one invocation's subrequest budget. */
export const DRAIN_PER_SINK = 25;

const SPOOL = (sink: TelemetrySink) => `tel_spool:${sink}:`;
const DEAD = (sink: TelemetrySink) => `tel_dead:${sink}:`;
const LOSS = (sink: TelemetrySink) => `tel_loss:${sink}:`;
const LAST_DRAIN_KEY = "tel_drain_last";
const day = (ms: number) => new Date(ms).toISOString().split("T")[0];

/** One spooled record: where it belongs, the row it is, and how its delivery is going. */
export interface SpoolRecord {
	sink: TelemetrySink;
	id: string;
	/** The exact row (D1 sinks), or `{ keys, value, expiration, metadata }` for the MCP audit. */
	payload: Record<string, unknown>;
	attempts: number;
	nextAt: number;
	createdAt: number;
	/** Why the last replay failed — a class, never a value. */
	lastError?: string;
	deadAt?: number;
}

type KvEnv = Partial<Pick<Env, "OAUTH_KV">>;

/** Carried as KV key metadata, so a listing says what is due and how old it is without a read per record. */
interface SpoolMeta {
	nextAt: number;
	createdAt: number;
}
const spoolMeta = (r: SpoolRecord): SpoolMeta => ({ nextAt: r.nextAt, createdAt: r.createdAt });

/** Count one lost record for a sink, today. Best-effort: a lost counter is the floor, not the truth. */
async function countLoss(env: KvEnv, sink: TelemetrySink, why: string, now: number): Promise<void> {
	console.warn(JSON.stringify({ event: "telemetry.lost", sink, why }));
	const kv = env.OAUTH_KV;
	if (!kv) return;
	try {
		const key = `${LOSS(sink)}${day(now)}`;
		const n = Number((await kv.get(key)) ?? 0) || 0;
		await kv.put(key, String(n + 1), { expirationTtl: DEAD_TTL_SECONDS });
	} catch {
		// Nothing left to write to. The console line above is the record.
	}
}

/**
 * Spool a record its primary store refused. Returns what happened: `queued` (it will be replayed),
 * or `lost` (no spool store, the spool is full, or the spool write failed too — each counted).
 */
export async function spoolTelemetry(env: KvEnv, sink: TelemetrySink, id: string, payload: Record<string, unknown>, now = Date.now()): Promise<TelemetryWrite> {
	const kv = env.OAUTH_KV;
	if (!kv) {
		await countLoss(env, sink, "no_spool_store", now);
		return "lost";
	}
	try {
		const pending = await kv.list({ prefix: SPOOL(sink), limit: MAX_SPOOL_PER_SINK });
		if (pending.keys.length >= MAX_SPOOL_PER_SINK && !pending.keys.some((k) => k.name === `${SPOOL(sink)}${id}`)) {
			await countLoss(env, sink, "spool_full", now);
			return "lost";
		}
		const record: SpoolRecord = { sink, id, payload, attempts: 0, nextAt: now + BACKOFF_MS[0], createdAt: now };
		await kv.put(`${SPOOL(sink)}${id}`, JSON.stringify(record), { expirationTtl: SPOOL_TTL_SECONDS, metadata: spoolMeta(record) });
		return "queued";
	} catch {
		await countLoss(env, sink, "spool_write_failed", now);
		return "lost";
	}
}

/** Write one record into its primary store, idempotently. Throws on failure — the drain decides. */
async function deliver(env: Pick<Env, "DB"> & { OAUTH_KV: KVNamespace }, r: SpoolRecord, now: number): Promise<void> {
	const p = r.payload;
	switch (r.sink) {
		case "error_log":
			await env.DB.prepare(
				"INSERT INTO error_log (id, created_at, user_id, source, status, message, context, level, build, last_seen_at, instance_id, run_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?2, ?10, ?11) ON CONFLICT(id) DO NOTHING",
			)
				.bind(r.id, p.created_at, p.user_id ?? null, p.source, p.status ?? null, p.message, p.context ?? null, p.level, p.build ?? null, p.instance_id ?? null, p.run_id ?? null)
				.run();
			return;
		case "agent_events":
			await env.DB.prepare(
				"INSERT INTO agent_events (id, ts, created_at, user_id, instance_id, trace_id, source, level, event, message, context) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(id) DO NOTHING",
			)
				.bind(r.id, p.ts, p.created_at, p.user_id ?? null, p.instance_id ?? null, p.trace_id ?? null, p.source, p.level, p.event, p.message ?? null, p.context ?? null)
				.run();
			return;
		case "admin_audit_log":
			await env.DB.prepare(
				"INSERT INTO admin_audit_log (id, created_at, actor_user_id, action, target_type, target_id, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO NOTHING",
			)
				.bind(r.id, p.created_at, p.actor_user_id, p.action, p.target_type ?? null, p.target_id ?? null, p.detail ?? null)
				.run();
			return;
		case "mcp_audit": {
			// Written by the MCP Worker (`workers/mcp/src/safety.ts`) when one of an event's two index
			// keys landed and the other did not. The same key, the same value, the same ABSOLUTE expiry:
			// re-putting one that already landed changes nothing, and nothing outlives its 90 days.
			const keys = Array.isArray(p.keys) ? (p.keys as string[]) : [];
			const expiration = typeof p.expiration === "number" ? p.expiration : 0;
			// KV refuses an expiry under a minute away; an event that close to its end has nothing to restore.
			if (expiration < Math.floor(now / 1000) + 60) return;
			const metadata = p.metadata && typeof p.metadata === "object" ? p.metadata : undefined;
			await Promise.all(keys.map((k) => env.OAUTH_KV.put(k, String(p.value), { expiration, ...(metadata ? { metadata } : {}) })));
			return;
		}
	}
}

export interface DrainStats {
	delivered: number;
	retrying: number;
	dead: number;
	/** Listed but gone before it could be read — expired or drained by an overlapping tick. */
	vanished: number;
}

/**
 * Replay what is due, per sink — the per-minute cron's half (#1084). A delivered record is deleted;
 * a failed one backs off ({@link BACKOFF_MS}); after {@link MAX_ATTEMPTS} it becomes DEAD — kept,
 * counted and readable, never silently dropped (past {@link MAX_SPOOL_PER_SINK} dead it is counted
 * as lost instead, so the dead letters stay bounded too). Never throws.
 */
export async function drainTelemetrySpool(env: Pick<Env, "DB" | "OAUTH_KV">, now = Date.now()): Promise<DrainStats> {
	const stats: DrainStats = { delivered: 0, retrying: 0, dead: 0, vanished: 0 };
	const kv = env.OAUTH_KV;
	if (!kv) return stats;
	const store = { DB: env.DB, OAUTH_KV: kv };
	for (const sink of TELEMETRY_SINKS) {
		let due: string[];
		try {
			const listed = await kv.list<SpoolMeta>({ prefix: SPOOL(sink), limit: MAX_SPOOL_PER_SINK });
			// A key without metadata is read and judged on its value — never skipped for lacking it.
			due = listed.keys.filter((k) => !k.metadata || !(k.metadata.nextAt > now)).map((k) => k.name);
		} catch (e) {
			console.warn(JSON.stringify({ event: "telemetry.drain_list_failed", sink, error: e instanceof Error ? e.message : String(e) }));
			continue;
		}
		let handled = 0;
		for (const name of due) {
			if (handled++ >= DRAIN_PER_SINK) break;
			const raw = await kv.get(name).catch(() => null);
			if (raw === null) {
				stats.vanished++;
				continue;
			}
			let r: SpoolRecord | null = null;
			try {
				r = JSON.parse(raw) as SpoolRecord;
			} catch {
				// Unreadable: it can never be delivered. It becomes dead as it is, below.
			}
			if (r && r.nextAt > now) continue;
			const record: SpoolRecord = r ?? { sink, id: name.substring(SPOOL(sink).length), payload: { unparseable: raw.length }, attempts: MAX_ATTEMPTS - 1, nextAt: now, createdAt: now };
			try {
				if (!r) throw new Error("unparseable");
				await deliver(store, record, now);
				await kv.delete(name);
				stats.delivered++;
				continue;
			} catch (e) {
				record.attempts += 1;
				record.lastError = !r ? "unparseable" : e instanceof Error ? e.name || "Error" : "Error";
			}
			try {
				if (record.attempts >= MAX_ATTEMPTS) {
					record.deadAt = now;
					const dead = await kv.list({ prefix: DEAD(sink), limit: MAX_SPOOL_PER_SINK });
					if (dead.keys.length >= MAX_SPOOL_PER_SINK) await countLoss(env, sink, "dead_letters_full", now);
					else await kv.put(`${DEAD(sink)}${record.id}`, JSON.stringify(record), { expirationTtl: DEAD_TTL_SECONDS });
					await kv.delete(name);
					stats.dead++;
				} else {
					record.nextAt = now + BACKOFF_MS[Math.min(record.attempts, BACKOFF_MS.length - 1)];
					await kv.put(name, JSON.stringify(record), { expirationTtl: SPOOL_TTL_SECONDS, metadata: spoolMeta(record) });
					stats.retrying++;
				}
			} catch (e) {
				console.warn(JSON.stringify({ event: "telemetry.drain_update_failed", sink, error: e instanceof Error ? e.message : String(e) }));
			}
		}
	}
	// The cron's own receipt — what `telemetry_health` shows as `lastDrain`, so "is the drain even
	// running?" has an answer that is not inferred from an empty spool.
	await kv.put(LAST_DRAIN_KEY, JSON.stringify({ at: now, ...stats }), { expirationTtl: DEAD_TTL_SECONDS }).catch(() => undefined);
	return stats;
}

export interface SinkDelivery {
	sink: TelemetrySink;
	/** Spooled and waiting for replay. `pendingCapped` when there are at least {@link MAX_SPOOL_PER_SINK}. */
	pending: number;
	pendingCapped: boolean;
	/** Age of the oldest pending record, ms. Null when nothing is pending. */
	oldestPendingMs: number | null;
	/** Gave up after {@link MAX_ATTEMPTS} replays — kept for {@link DEAD_TTL_SECONDS}. */
	dead: number;
	/** Could not even be spooled, in the last 30 days (a floor — see `countLoss`). */
	lost: number;
}

/**
 * Delivery health for every sink (#1084) — what MCP `telemetry_health` and the audit coverage read.
 * `complete` is true only when nothing is pending, dead or lost: a record still in the spool is a
 * fact the primary store does not have yet. A storage failure THROWS rather than reading as healthy.
 */
export async function telemetryDelivery(env: KvEnv, now = Date.now(), sinks: readonly TelemetrySink[] = TELEMETRY_SINKS): Promise<{ complete: boolean; sinks: SinkDelivery[] }> {
	const kv = env.OAUTH_KV;
	if (!kv) throw new Error("no telemetry spool store is bound");
	const out: SinkDelivery[] = [];
	for (const sink of sinks) {
		const [pending, dead, losses] = await Promise.all([
			kv.list<SpoolMeta>({ prefix: SPOOL(sink), limit: MAX_SPOOL_PER_SINK }),
			kv.list({ prefix: DEAD(sink), limit: MAX_SPOOL_PER_SINK }),
			kv.list({ prefix: LOSS(sink), limit: 40 }),
		]);
		let oldest: number | null = null;
		for (const k of pending.keys) {
			const created = k.metadata?.createdAt;
			if (typeof created === "number" && (oldest === null || created < oldest)) oldest = created;
		}
		let lost = 0;
		for (const k of losses.keys) lost += Number((await kv.get(k.name)) ?? 0) || 0;
		out.push({
			sink,
			pending: pending.keys.length,
			pendingCapped: !pending.list_complete || pending.keys.length >= MAX_SPOOL_PER_SINK,
			oldestPendingMs: oldest === null ? null : Math.max(0, now - oldest),
			dead: dead.keys.length,
			lost,
		});
	}
	return { complete: out.every((s) => s.pending === 0 && s.dead === 0 && s.lost === 0), sinks: out };
}

/**
 * Everything `GET /v1/errors/telemetry-health` and MCP `telemetry_health` answer (#1084): per-sink
 * delivery, the last drain the cron recorded, and the policy those numbers are measured against.
 */
export async function telemetryHealth(env: KvEnv, now = Date.now()) {
	const delivery = await telemetryDelivery(env, now);
	const raw = await (env.OAUTH_KV as KVNamespace).get(LAST_DRAIN_KEY);
	const last = raw ? (JSON.parse(raw) as DrainStats & { at: number }) : null;
	return {
		...delivery,
		lastDrain: last ? { ...last, ageMs: Math.max(0, now - last.at) } : null,
		policy: {
			maxAttempts: MAX_ATTEMPTS,
			backoffMs: BACKOFF_MS,
			capacityPerSink: MAX_SPOOL_PER_SINK,
			drainPerSinkPerMinute: DRAIN_PER_SINK,
			spoolTtlDays: SPOOL_TTL_SECONDS / 86_400,
			deadAndLossRetentionDays: DEAD_TTL_SECONDS / 86_400,
		},
		semantics:
			"pending = refused by its primary store and spooled for replay (accepted, not yet durable); dead = replay gave up after maxAttempts (kept for inspection); lost = could not be spooled at all (a floor: a loss while KV itself is down cannot be counted). complete = nothing pending, dead or lost in the window. The MCP audit's pending entries are events present in one of its two indexes.",
	};
}
