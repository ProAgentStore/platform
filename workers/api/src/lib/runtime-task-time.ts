// A runtime task's two timestamps: the one the PAYLOAD carries and the one the COLUMNS take.
//
// Split out of `routes/instances-runtime.ts` (the same move #570 made for `runtime-response.ts`):
// pure functions with no Hono, no env and no I/O, in a 900-line route module under a size ratchet.
// Re-exported from there, so every existing importer is unchanged.
import { toSqlTime, type SqlTime } from "./sql-time.js";

/**
 * A task's own timestamp for the payload and for anything served as JSON — ISO-8601, as the runner
 * wrote it (`packages/browser-runner` assigns `new Date().toISOString()` in eleven places).
 *
 * Deliberately NOT the format the columns take. The two are different jobs: this one ends up in a
 * browser's `new Date(...)`, where a `YYYY-MM-DD HH:MM:SS` string is read as LOCAL time.
 */
export function taskTimestamp(value: unknown): string {
	return typeof value === "string" && value.trim() ? value : new Date().toISOString();
}

/**
 * The same instant for the `created_at` / `updated_at` COLUMNS: `datetime('now')`'s own shape.
 *
 * `instance_runtime_tasks.updated_at` is sorted with a LIMIT by three readers — the board, the
 * console task list, and `recentWorkForInstances`, which returns eight cards per subordinate. It
 * had eleven `datetime('now')` writers and this one ISO writer, and SQLite compares TEXT bytewise:
 * `'2026-08-15T00:00:01.000Z' > '2026-08-15 22:38:19'`. So every runner-mirrored task outranked
 * every escalation raised the same day, and the eight cards a supervisor saw were the wrong eight
 * (#634). The instant was never wrong; only the bytes the sort reads were.
 *
 * The conversion belongs at THIS boundary rather than in the runner: the CLI is a separately
 * published npm package, so a fix that needed it to ship first would leave every already-installed
 * copy writing the broken format.
 */
export function taskColumnTimestamp(value: unknown): SqlTime {
	return toSqlTime(value);
}
