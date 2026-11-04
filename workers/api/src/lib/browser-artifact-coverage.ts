/** Stored-frame coverage, not a claim that the runner captured every action or is current. */
import type { Env } from "../types.js";
import type { BrowserArtifactSubject } from "./browser-artifacts.js";

import type { BrowserArtifactCoverage } from "./browser-artifact-response-types.js";
export type { BrowserArtifactCoverage } from "./browser-artifact-response-types.js";

export async function browserArtifactCoverage(env: Pick<Env, "DB">, userId: string, instanceId: string, subjectKind: BrowserArtifactSubject, subjectId: string): Promise<BrowserArtifactCoverage> {
	const scope = [userId, instanceId, subjectKind, subjectId];
	const where = "user_id = ?1 AND instance_id = ?2 AND subject_kind = ?3 AND subject_id = ?4";
	const totals = await env.DB.prepare(`SELECT COUNT(*) AS count, MIN(seq) AS first, MAX(seq) AS last FROM browser_run_artifacts WHERE ${where}`).bind(...scope).first<{ count: number; first: number | null; last: number | null }>();
	// Workflow sequences are action/step indices, not a dense capture counter. Inferring gaps there would invent missing frames.
	const local = subjectKind !== "runtime_task";
	const ranges = local ? (await env.DB.prepare(`SELECT previous_seq + 1 AS fromSeq, seq - 1 AS toSeq FROM (SELECT seq, LAG(seq, 1, 0) OVER (ORDER BY seq) AS previous_seq FROM browser_run_artifacts WHERE ${where}) WHERE seq > previous_seq + 1 ORDER BY seq LIMIT 129`).bind(...scope).all<{ fromSeq: number; toSeq: number }>()).results ?? [] : [];
	const rangesTruncated = ranges.length > 128;
	if (rangesTruncated) ranges.pop();
	return {
		basis: local ? "stored_local_capture_sequences" : "stored_workflow_steps",
		storedFrames: totals?.count ?? 0, firstStoredSeq: totals?.first ?? null, lastStoredSeq: totals?.last ?? null,
		missingRanges: ranges, rangesTruncated,
		notice: "Stored history only. Missing ranges may reflect buffer eviction, rejected frames or expired retention. This does not establish capture completeness or the current browser screen.",
	};
}
