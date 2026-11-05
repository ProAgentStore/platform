/** Server-received heartbeat evidence, independent of CLI sample clocks and live probes. */
import type { Env } from "../types.js";
import { normalizeMachineId, normalizeRunnerNode } from "./runtime-nodes.js";

export const AVAILABILITY_BUCKET_MS = 60_000;
export const AVAILABILITY_RETENTION_MS = 86_400_000;
export interface AvailabilityBucket {
	at: string;
	receipts: number;
	firstReceivedAt: string;
	lastReceivedAt: string;
}
export interface RunnerAvailability {
	source: "heartbeat_receipts";
	bucketMs: number;
	from: string;
	to: string;
	retentionMs: number;
	coverage: "observed_only";
	missingBucketMeaning: "no_recorded_receipt";
	error: string | null;
	truncated: boolean;
	buckets: AvailabilityBucket[];
}

/** Only the authenticated heartbeat route calls this. Counts requests, not distinct machines/cycles. */
export async function recordHeartbeatReceipt(env: Pick<Env, "DB">, userId: string, node: string, machineId: unknown, receivedAt = Date.now()): Promise<void> {
	const name = normalizeRunnerNode(node);
	if (!name) return;
	const key = normalizeMachineId(machineId) || `node:${name}`;
	const bucket = Math.floor(receivedAt / AVAILABILITY_BUCKET_MS) * AVAILABILITY_BUCKET_MS;
	await env.DB.batch([
		env.DB.prepare(`INSERT INTO runner_heartbeat_receipts (user_id, machine_key, bucket_at, receipts, first_received_at, last_received_at)
		 VALUES (?1, ?2, ?3, 1, ?4, ?4) ON CONFLICT (user_id, machine_key, bucket_at) DO UPDATE SET
		 receipts = receipts + 1, first_received_at = MIN(first_received_at, excluded.first_received_at), last_received_at = MAX(last_received_at, excluded.last_received_at)`)
			.bind(userId, key, bucket, receivedAt),
		env.DB.prepare("DELETE FROM runner_heartbeat_receipts WHERE user_id = ?1 AND bucket_at < ?2").bind(userId, Math.floor((receivedAt - AVAILABILITY_RETENTION_MS) / AVAILABILITY_BUCKET_MS) * AVAILABILITY_BUCKET_MS),
	]);
}

/** Full bounded window on every poll: the resource-sample cursor cannot safely address receipt buckets. */
export async function runnerAvailability(env: Pick<Env, "DB">, userId: string, keys: string[], requestedFrom: number, requestedTo: number, now = Date.now(), bucketMs = AVAILABILITY_BUCKET_MS): Promise<RunnerAvailability> {
	const windowMs = bucketMs === AVAILABILITY_BUCKET_MS ? 2 * 3600000 : AVAILABILITY_RETENTION_MS;
	const to = Math.max(now - windowMs, Math.min(requestedTo, now));
	const from = Math.min(to, Math.max(requestedFrom, now - windowMs));
	const result: RunnerAvailability = { source: "heartbeat_receipts", bucketMs, from: new Date(from).toISOString(), to: new Date(to).toISOString(), retentionMs: AVAILABILITY_RETENTION_MS, coverage: "observed_only", missingBucketMeaning: "no_recorded_receipt", error: null, truncated: requestedFrom < now - windowMs || requestedTo < now - windowMs || requestedTo > now, buckets: [] };
	const boundedKeys = [...new Set(keys)].slice(0, 90);
	result.truncated ||= new Set(keys).size > boundedKeys.length;
	if (!boundedKeys.length || requestedTo < now - windowMs) return result;
	const maxBuckets = Math.ceil(windowMs / bucketMs) + 1;
	try {
		const marks = boundedKeys.map((_, i) => `?${i + 5}`).join(",");
		const rows = (await env.DB.prepare(`SELECT CAST(bucket_at / ?4 AS INTEGER) * ?4 AS at, SUM(receipts) AS receipts, MIN(first_received_at) AS first_received_at, MAX(last_received_at) AS last_received_at
		 FROM runner_heartbeat_receipts WHERE user_id = ?1 AND bucket_at >= ?2 AND bucket_at <= ?3 AND machine_key IN (${marks})
		 GROUP BY at ORDER BY at LIMIT ${maxBuckets + 1}`).bind(userId, Math.floor(from / AVAILABILITY_BUCKET_MS) * AVAILABILITY_BUCKET_MS, to, bucketMs, ...boundedKeys).all<{ at: number; receipts: number; first_received_at: number; last_received_at: number }>()).results ?? [];
		result.truncated ||= rows.length > maxBuckets;
		result.buckets = rows.slice(0, maxBuckets).map((r) => ({ at: new Date(r.at).toISOString(), receipts: r.receipts, firstReceivedAt: new Date(r.first_received_at).toISOString(), lastReceivedAt: new Date(r.last_received_at).toISOString() }));
	} catch { result.error = "Heartbeat receipt history unavailable"; }
	return result;
}
