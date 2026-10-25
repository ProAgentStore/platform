import { maskPaneText } from "./pane-mask.js";
import type { Env } from "../types.js";

/**
 * Re-redact terminal text stored before it was masked on the way in (#1195).
 *
 * Bounded and resumable: each source keeps a watermark (`pane_redaction_progress`), a tick processes a few batches past it, and a
 * row is rewritten only if masking changes it. Idempotent — masking already-masked text changes nothing — so a repeated or
 * overlapping tick is harmless. Never throws.
 */
export const SWEEP_BATCH = 200;
export const SWEEP_BATCHES_PER_TICK = 5;

interface Source {
	name: string;
	/** Select `rowid` plus the text columns, past the watermark. */
	select: string;
	columns: string[];
	update: string;
}

const SOURCES: Source[] = [
	{
		name: "terminal_history",
		select: "SELECT rowid AS rid, content FROM terminal_history WHERE rowid > ?1 ORDER BY rowid LIMIT ?2",
		columns: ["content"],
		update: "UPDATE terminal_history SET content = ?1 WHERE rowid = ?2",
	},
	{
		name: "coding_timeline",
		select: "SELECT rowid AS rid, content FROM coding_timeline WHERE rowid > ?1 AND type IN ('terminal', 'command') ORDER BY rowid LIMIT ?2",
		columns: ["content"],
		update: "UPDATE coding_timeline SET content = ?1 WHERE rowid = ?2",
	},
	{
		name: "error_log",
		select: "SELECT rowid AS rid, message, context FROM error_log WHERE rowid > ?1 ORDER BY rowid LIMIT ?2",
		columns: ["message", "context"],
		update: "UPDATE error_log SET message = ?1, context = ?3 WHERE rowid = ?2",
	},
];

/** How many rows were rewritten, over every source, this tick. */
export async function redactStoredPanes(env: Env, now = Date.now()): Promise<number> {
	let changed = 0;
	for (const source of SOURCES) {
		try {
			let last = (await env.DB.prepare("SELECT last_rowid FROM pane_redaction_progress WHERE source = ?1").bind(source.name).first<{ last_rowid: number }>())?.last_rowid ?? 0;
			for (let batch = 0; batch < SWEEP_BATCHES_PER_TICK; batch++) {
				const rows = (await env.DB.prepare(source.select).bind(last, SWEEP_BATCH).all<Record<string, unknown>>()).results ?? [];
				if (!rows.length) break;
				let rewritten = 0;
				for (const row of rows) {
					const before = source.columns.map((c) => (typeof row[c] === "string" ? (row[c] as string) : null));
					const after = before.map((v) => (v === null ? null : maskPaneText(v)));
					if (after.every((v, i) => v === before[i])) continue;
					if (source.name === "error_log") await env.DB.prepare(source.update).bind(after[0], row.rid, after[1]).run();
					else await env.DB.prepare(source.update).bind(after[0], row.rid).run();
					rewritten++;
				}
				last = Number(rows[rows.length - 1].rid);
				changed += rewritten;
				await env.DB.prepare(
					`INSERT INTO pane_redaction_progress (source, last_rowid, rows_changed, updated_at) VALUES (?1, ?2, ?3, ?4)
					 ON CONFLICT(source) DO UPDATE SET last_rowid = excluded.last_rowid, rows_changed = rows_changed + excluded.rows_changed, updated_at = excluded.updated_at`,
				)
					.bind(source.name, last, rewritten, now)
					.run();
				if (rows.length < SWEEP_BATCH) break;
			}
		} catch {
			// One source's trouble must not stop the others; it resumes from its watermark next tick.
		}
	}
	return changed;
}
