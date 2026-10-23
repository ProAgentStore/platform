/** Compatibility for two-phase reservations written by the published 0279 picker. New starts
 * use atomic admissions instead; only these existing rows retain the old two-minute recovery clock.
 */
import type { Env } from "../types.js";

/** A reservation older than this whose objective was never enqueued is a crash's leftover (#1315). */
export const RESERVATION_TTL_MS = 2 * 60_000;

/** The objective is queued: the reservation becomes a complete start, remembering its entry. */
async function confirmReservation(env: Env, reservationId: string, entryId: string): Promise<void> {
	await env.DB.prepare("UPDATE auto_pickup_log SET reserved = 0, entry_id = ?2 WHERE id = ?1").bind(reservationId, entryId).run();
}

/** Enqueue failed: give the allowance back. */
async function releaseReservation(env: Env, reservationId: string): Promise<void> {
	await env.DB.prepare("DELETE FROM auto_pickup_log WHERE id = ?1 AND reserved = 1").bind(reservationId).run();
}

/**
 * Settle reservations a crash left between reserving and enqueueing (#1315): one whose objective did get
 * queued (the entry is found by its issue, created after the reservation) is completed, never queued a
 * second time; one with no entry is deleted so its allowance is not leaked. Only reservations older than
 * {@link RESERVATION_TTL_MS} are touched — a younger one belongs to a wake still running. Never throws.
 */
export async function recoverReservations(env: Env, iid: string, now = Date.now()): Promise<number> {
	let settled = 0;
	try {
		const { results } = await env.DB.prepare("SELECT id, repo, issue_number, created_at FROM auto_pickup_log WHERE instance_id = ?1 AND reserved = 1 AND created_at <= ?2").bind(iid, now - RESERVATION_TTL_MS).all<{ id: string; repo: string; issue_number: number; created_at: number }>();
		for (const r of results ?? []) {
			const entry = await env.DB.prepare(
				`SELECT id FROM instance_objective_queue WHERE instance_id = ?1 AND created_at >= ?2
				    AND json_extract(metadata, '$.autoPickup.repo') = ?3 AND json_extract(metadata, '$.autoPickup.issue') = ?4 ORDER BY created_at LIMIT 1`,
			)
				.bind(iid, r.created_at, r.repo, r.issue_number)
				.first<{ id: string }>();
			if (entry) await confirmReservation(env, r.id, entry.id);
			else await releaseReservation(env, r.id);
			settled++;
		}
	} catch {
		// The next wake looks again; a failed recovery must not stop this one.
	}
	return settled;
}
