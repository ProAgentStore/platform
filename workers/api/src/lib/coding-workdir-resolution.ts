import type { Env } from "../types.js";
import { clipMarked } from "./clip-marked.js";

/**
 * Record how a machine expanded this repo's folder (#1379). Written only from a runner's own answer to `/coding/start`, and best-effort:
 * a failed write is the loss of a debugging line, never of a session.
 */
export async function recordWorkdirResolution(env: Env, repoId: string, r: { path: string; via: string }): Promise<void> {
	await env.DB.prepare("UPDATE coding_repos SET workdir_resolved = ?2, workdir_resolved_via = ?3, workdir_resolved_at = datetime('now') WHERE id = ?1 AND (workdir_resolved IS NOT ?2 OR workdir_resolved_via IS NOT ?3 OR workdir_resolved_at < datetime('now', '-1 hour') OR workdir_resolved_at IS NULL)")
		.bind(repoId, clipMarked(r.path, 1000, { within: true }), r.via.length > 40 ? "other" : r.via)
		.run();
}
