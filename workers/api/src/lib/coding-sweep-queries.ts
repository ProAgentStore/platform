// The two queries only the per-minute coding sweep makes (#302, extracted at #698).
//
// `coding-store.ts` is the coding registry's D1 access and everything about repos and sessions
// lived there — which is right until a query stops being about the registry. These two are not
// read by any route, tool or workflow: `listIdleSessions` and `listInstancesWithQuietSessions`
// have exactly ONE caller each, `coding-session-sweeper.ts`, and they exist to answer the cron's
// question ("what is nobody looking at?") rather than the registry's ("what does this workspace
// have?").
//
// The move was FORCED, and by the right thing. #698 added three joins and a documented row shape
// so the sleep notification could name a repo the way its owner names it, which took
// `coding-store.ts` from 798 lines to 844 and tripped the #302 ratchet. The registry in
// `scripts/check-file-size.mjs` records what happened the last time this exact file crossed 800,
// at #676: the new function moved out to where the rest of its question already lived, and the
// note ends "a pin was the easy answer and the wrong one; the gate asking for a decision is what
// produced the better placement." Pinning it this time would have contradicted a decision the
// registry itself carries.
//
// Cross-tenant by construction — no `user_id` filter, because the sweep runs as the platform and
// the owner rides on every row so the caller can scope what it does next.
import type { CodingClientType } from "./coding-types.js";
import type { Env } from "../types.js";

const CLIENTS: CodingClientType[] = ["claude", "gemini", "codex", "grok"];
const client = (v: unknown): CodingClientType => (CLIENTS.includes(v as CodingClientType) ? (v as CodingClientType) : "claude");

/** One `active` session row, as the cross-tenant sweeper needs it (owner included). */
export interface IdleSessionRow {
	id: string;
	instanceId: string;
	userId: string;
	repoId: string;
	runnerNode: string | null;
	/**
	 * The engine it ran. Only Claude has a resume protocol, so this decides whether the sleep
	 * notification may promise the conversation at all (#698) — see `resolveSessionContinuity`.
	 */
	clientType: string;
	/**
	 * The clock the reap measured idleness against, and the SAME column
	 * `resolveSessionContinuity` measures the four-day resume window against. That shared origin is
	 * why the notification can state a deadline instead of a vague reassurance.
	 */
	lastActivityAt: number | null;
	/** For the notification's body. Null when the repo row has since gone. */
	repoName: string | null;
	/** The name the owner sees in the console — their per-instance rename, else the agent's. */
	instanceName: string | null;
}

/**
 * Active sessions nobody has touched since `cutoff`, across all owners — the sweeper's input.
 *
 * `driver_at` is in the predicate as well as `last_activity_at`, and against the SAME cutoff: the
 * claim has to be as stale as the session before either is reaped. That is far stricter than
 * `STALE_DRIVER_MS` needs (15 minutes vs six hours) and deliberately so — reaping a session out
 * from under a live run is the one outcome strictly worse than the leak, so the cheap over-caution
 * is bought at the price of a few extra idle hours in a case that should not arise at all.
 * `COALESCE(..., updated_at)` covers a row whose column predates the backfill (a session created by
 * an in-flight isolate mid-deploy).
 *
 * The joins are for the NOTIFICATION (#698), which has to name things the way the owner names them
 * — "Chess coder 2 went to sleep on apps/chess-academy" — and every one is a LEFT join returning
 * null rather than dropping the row. A repo deleted between the last activity and the sweep must
 * still have its engine released; losing the reap because the label is missing would trade a
 * cosmetic gap for the resident process this whole sweep exists to kill.
 */
export async function listIdleSessions(env: Env, cutoff: number, limit: number): Promise<IdleSessionRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT s.id, s.instance_id, s.user_id, s.repo_id, s.runner_node, s.client_type,
		        COALESCE(s.last_activity_at, CAST(strftime('%s', s.updated_at) AS INTEGER) * 1000) AS last_activity_at,
		        r.name AS repo_name,
		        COALESCE(
		          NULLIF(TRIM(CASE WHEN json_valid(i.config) THEN json_extract(i.config, '$.displayName') END), ''),
		          a.name
		        ) AS instance_name
		   FROM coding_sessions s
		   LEFT JOIN coding_repos r ON r.id = s.repo_id
		   LEFT JOIN agent_instances i ON i.id = s.instance_id
		   LEFT JOIN agents a ON a.id = i.agent_id
		  WHERE s.status = 'active'
		    AND COALESCE(s.last_activity_at, CAST(strftime('%s', s.updated_at) AS INTEGER) * 1000) < ?1
		    AND (s.driver_at IS NULL OR s.driver_at < ?2)
		  ORDER BY COALESCE(s.last_activity_at, 0) ASC
		  LIMIT ?3`,
	)
		.bind(cutoff, cutoff, limit)
		.all<{
			id: string;
			instance_id: string;
			user_id: string;
			repo_id: string;
			runner_node: string | null;
			client_type: string | null;
			last_activity_at: number | null;
			repo_name: string | null;
			instance_name: string | null;
		}>();
	return (results ?? []).map((r) => ({
		id: r.id,
		instanceId: r.instance_id,
		userId: r.user_id,
		repoId: r.repo_id,
		runnerNode: r.runner_node,
		clientType: client(r.client_type ?? undefined),
		lastActivityAt: typeof r.last_activity_at === "number" ? r.last_activity_at : null,
		repoName: r.repo_name,
		instanceName: r.instance_name,
	}));
}

/**
 * Instances holding an `active` session that has been quiet for a while — the orphan reconcile's
 * input.
 *
 * Quiet-gated on purpose. Reconciling asks the RUNNER what it is tracking, which is a relay round
 * trip per instance per cron tick; a session being captured every 3 seconds is self-evidently not
 * orphaned, so the common case (somebody actually working) costs nothing.
 */
export async function listInstancesWithQuietSessions(
	env: Env,
	quietBefore: number,
	limit: number,
): Promise<Array<{ instanceId: string; userId: string }>> {
	const { results } = await env.DB.prepare(
		`SELECT DISTINCT instance_id, user_id FROM coding_sessions
		  WHERE status = 'active'
		    AND COALESCE(last_activity_at, CAST(strftime('%s', updated_at) AS INTEGER) * 1000) < ?1
		  LIMIT ?2`,
	)
		.bind(quietBefore, limit)
		.all<{ instance_id: string; user_id: string }>();
	return (results ?? []).map((r) => ({ instanceId: r.instance_id, userId: r.user_id }));
}
