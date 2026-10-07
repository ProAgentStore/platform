// What a BUSY repo is busy WITH (#886).
//
// "already being worked on" was the only signal a caller got when its start found the repo taken,
// and in #886 it meant the caller's OWN earlier start had landed — a start whose approval had timed
// out in the caller's MCP client (a gate before the request reaches this server, which therefore
// never sees it) and was then approved and sent. The caller could not tell "my run is starting"
// from "someone else is working" and had to pattern-match the sentence and poll.
//
// So a busy refusal now names what holds the repo: the RUN working it, with the request id of the
// start receipt that created it, and any start receipts still PROVISIONING on it — the window
// between an accepted start and its run row, which is exactly where #886's retry landed. A caller
// that sent `request_id` X and sees X here knows its start went through; anything else is somebody
// else's run.

import type { Env } from "../types.js";

/** A provisioning receipt older than this is reported `unknown` by `listLoopStarts`, so it is not "in flight". */
const IN_FLIGHT_MS = 5 * 60_000;

export interface BusyHolder {
	/**
	 * The run working this repo now, if one is recorded. `requestId` is null for a run started without
	 * one; `sessionId` is the coding session it drives — its live view in the console (#931).
	 */
	activeRun: { runId: string; objective: string; startedAt: number; requestId: string | null; sessionId: string | null } | null;
	/** Starts accepted on this repo that have not reached a terminal state yet, newest first. */
	inFlightStarts: Array<{ requestId: string; objective: string | null; ageMs: number }>;
}

/** Same reading of "this repo" as the queue (`listQueue`): a named repo also matches repo-less rows. */
const sameRepo = (rowRepo: string | null | undefined, repoId: string | undefined) => repoId === undefined || rowRepo == null || rowRepo === repoId;

export async function describeBusyHolder(
	env: Env,
	/** `excludeRequestId`: the asking start's own receipt, which is provisioning while it is refused. */
	input: { userId: string; instanceId: string; repoId?: string; excludeRequestId?: string; now?: number },
): Promise<BusyHolder> {
	const now = input.now ?? Date.now();
	const runs = await env.DB.prepare(
		`SELECT r.run_id, r.objective, r.started_at, r.session_id, s.repo_id,
		        (SELECT request_id FROM loop_start_receipts k
		          WHERE k.user_id = r.user_id AND k.instance_id = r.instance_id AND json_extract(k.response_json, '$.runId') = r.run_id
		          LIMIT 1) AS request_id
		   FROM agent_loop_runs r
		   LEFT JOIN coding_sessions s ON s.id = r.session_id
		  WHERE r.user_id = ?1 AND r.instance_id = ?2 AND r.status = 'running'
		  ORDER BY r.started_at DESC`,
	)
		.bind(input.userId, input.instanceId)
		.all<{ run_id: string; objective: string; started_at: number; session_id: string | null; repo_id: string | null; request_id: string | null }>();
	const run = (runs.results ?? []).find((r) => sameRepo(r.repo_id, input.repoId));

	// No LIMIT (#898): it applied BEFORE the per-repo filter below, so ten in-flight starts for
	// other repos hid this repo's own. The in-flight window already bounds the rows.
	const receipts = await env.DB.prepare(
		`SELECT request_id, input_json, created_at FROM loop_start_receipts
		  WHERE user_id = ?1 AND instance_id = ?2 AND state = 'provisioning' AND created_at >= ?3
		  ORDER BY created_at DESC`,
	)
		.bind(input.userId, input.instanceId, now - IN_FLIGHT_MS)
		.all<{ request_id: string; input_json: string; created_at: number }>();
	const inFlightStarts = (receipts.results ?? []).flatMap((r) => {
		let parsed: { objective?: unknown; repoId?: unknown } = {};
		try {
			parsed = JSON.parse(r.input_json) as typeof parsed;
		} catch {
			// An unreadable input still names a start in flight; it just cannot be matched to a repo.
		}
		const repo = typeof parsed.repoId === "string" ? parsed.repoId : null;
		if (r.request_id === input.excludeRequestId || !sameRepo(repo, input.repoId)) return [];
		return [{ requestId: r.request_id, objective: typeof parsed.objective === "string" ? parsed.objective : null, ageMs: Math.max(0, now - r.created_at) }];
	});

	return {
		activeRun: run ? { runId: run.run_id, objective: run.objective, startedAt: run.started_at, requestId: run.request_id ?? null, sessionId: run.session_id ?? null } : null,
		inFlightStarts,
	};
}
