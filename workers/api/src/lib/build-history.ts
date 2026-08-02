import type { Env } from "../types.js";

/**
 * Durable build history for a repo (CODER-002, #78). GitHub Actions history is
 * retention-limited; this keeps a compact per-repo log so `/deployments` can serve
 * history beyond GitHub's window and survive transient GitHub failures. Stored in KV
 * (the only provisioned namespace, `OAUTH_KV`, under a `builds:` prefix — a new namespace
 * would need infra provisioning). Writes are best-effort: a storage failure NEVER fails
 * the read path. A Durable Object is only warranted if we later need serialized writes or
 * real-time fan-out (CODER-007) — KV is sufficient and cheapest here.
 */

/** One build run — the same shape `/deployments` maps from a GitHub Actions run. */
export interface BuildRun {
	status?: unknown; // queued | in_progress | completed
	conclusion?: unknown; // success | failure | cancelled | null
	name?: unknown;
	runNumber?: number | null;
	url?: string;
	branch?: string;
	sha?: string;
	updatedAt?: string;
}

/** Cap on stored/returned history — bounds KV value size and response size. */
export const BUILD_HISTORY_CAP = 50;

const key = (instanceId: string, repoId: string) => `builds:${instanceId}:${repoId}`;

/** Stable dedupe key for a run: runNumber if present, else its URL. */
function runKey(r: BuildRun): string {
	return r.runNumber != null ? `n:${r.runNumber}` : `u:${r.url ?? ""}`;
}

/**
 * Merge stored history with freshly-fetched live runs: dedupe by runNumber (fallback URL),
 * keeping the newer `updatedAt` on collision, sort newest-first, cap. Pure + deterministic.
 */
export function mergeRuns(stored: BuildRun[], live: BuildRun[]): BuildRun[] {
	const byKey = new Map<string, BuildRun>();
	for (const r of [...stored, ...live]) {
		const k = runKey(r);
		const existing = byKey.get(k);
		if (!existing || (r.updatedAt ?? "") >= (existing.updatedAt ?? "")) byKey.set(k, r);
	}
	return [...byKey.values()]
		.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
		.slice(0, BUILD_HISTORY_CAP);
}

/**
 * Weak ETag derived from the newest run (count + its updatedAt + sha). Changes iff the latest
 * build changes, so `If-None-Match` can short-circuit an unchanged poll to a 304. Pure.
 */
export function computeETag(runs: BuildRun[]): string {
	const latest = runs[0];
	if (!latest) return 'W/"builds-empty"';
	return `W/"builds-${runs.length}-${latest.updatedAt ?? ""}-${latest.sha ?? ""}"`;
}

/** Read the stored history (newest-first). Returns [] if KV is absent or on any error. */
export async function readBuildHistory(env: Env, instanceId: string, repoId: string): Promise<BuildRun[]> {
	if (!env.OAUTH_KV) return [];
	try {
		const raw = await env.OAUTH_KV.get(key(instanceId, repoId));
		return raw ? (JSON.parse(raw) as BuildRun[]) : [];
	} catch {
		return [];
	}
}

/** Best-effort persist of the (already merged + capped) history. Never throws. */
export async function persistBuildHistory(
	env: Env,
	instanceId: string,
	repoId: string,
	runs: BuildRun[],
): Promise<void> {
	if (!env.OAUTH_KV) return;
	try {
		await env.OAUTH_KV.put(key(instanceId, repoId), JSON.stringify(runs.slice(0, BUILD_HISTORY_CAP)));
	} catch {
		// best-effort: a storage failure must not fail the read path
	}
}
