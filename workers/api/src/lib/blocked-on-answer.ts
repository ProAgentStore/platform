import type { Env } from "../types.js";
import { listBlockedOnAnswer } from "./agent-loop-store.js";
import { describeRepoHolder } from "./coding-ownership.js";

export type BlockedOnAnswer = Awaited<ReturnType<typeof listBlockedOnAnswer>>[number] & { waitingOn: { text: string; endsOnItsOwn: boolean } | null };

/**
 * {@link listBlockedOnAnswer}, with what each ANSWERED run is still waiting on named (#1323): the holder of its
 * repo (session/run, machine, idle since) and whether it will ever end on its own. "Resumes as soon as the
 * repository is free" named nothing, and an idle session that never ends made it a wait with no end.
 */
export async function listBlockedOnAnswerWithHolder(env: Env, instanceId: string, userId: string, repoId?: string): Promise<BlockedOnAnswer[]> {
	const runs = await listBlockedOnAnswer(env, instanceId, userId, repoId);
	const out: BlockedOnAnswer[] = [];
	for (const r of runs) {
		const at = r.answered
			? await env.DB.prepare("SELECT s.id AS session_id, s.repo_id, cr.name FROM agent_loop_runs a JOIN coding_sessions s ON s.id = a.session_id LEFT JOIN coding_repos cr ON cr.id = s.repo_id WHERE a.run_id = ?1")
					.bind(r.runId)
					.first<{ session_id: string; repo_id: string; name: string | null }>()
					.catch(() => null)
			: null;
		const waitingOn = at ? await describeRepoHolder(env, { instanceId, userId, repoId: at.repo_id, exceptSessionId: at.session_id }, at.name || "the repository").catch(() => null) : null;
		out.push({ ...r, waitingOn });
	}
	return out;
}
