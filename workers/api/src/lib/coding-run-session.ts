// A run's story and its session's state, reconciled (#1185).
//
// `agent_loop_runs` says a run is `running` and parked on a question; `coding_sessions` says whether the session that run drives still
// exists. They are written by different steps, and when the session dies without the run noticing — a repin that moved its machine, a
// kill, a restart that ended it — the run row goes on saying "running, waiting, here is the question" while nothing can advance it.
// `coding_loop_status` published only the run's side, so the owner saw a live-looking wait with a progress clock that never moved, and
// found the truth only by driving the session and being told it had ended.
//
// This module reads the OTHER side, once, in one batched query, and folds it into the verdict: a run whose session has ended is
// `stalled` and says why. It changes nothing in D1 — closing a run is a decision for the run's own lifecycle, and for the owner.
//
// It also finds the runs a repin would leave behind: a run parked on a question belongs to the machine it parked on (#1242), and an
// instance pin moved since then does not move it.
import type { Env } from "../types.js";

export interface SessionFact {
	id: string;
	status: string;
	/** ms epoch, or null when not ended / not recorded. */
	endedAt: number | null;
	node: string | null;
}

/**
 * A session that ended moments ago is not yet a contradiction: a run's closing step ends its session just before it settles the run row,
 * so for a short window "running" beside "ended" is the run finishing, not a stuck one.
 */
export const SESSION_END_GRACE_MS = 2 * 60_000;

const CHUNK = 50;

/** The sessions behind these ids, by id. Ids that match no row are simply absent. */
export async function sessionFactsFor(env: Pick<Env, "DB">, userId: string, sessionIds: readonly string[]): Promise<Map<string, SessionFact>> {
	const facts = new Map<string, SessionFact>();
	const ids = [...new Set(sessionIds.filter(Boolean))];
	for (let i = 0; i < ids.length; i += CHUNK) {
		const part = ids.filter((_, n) => n >= i && n < i + CHUNK);
		const marks = part.map((_, n) => `?${n + 2}`).join(",");
		const { results } = await env.DB.prepare(`SELECT id, status, ended_at, runner_node FROM coding_sessions WHERE user_id = ?1 AND id IN (${marks})`)
			.bind(userId, ...part)
			.all<{ id: string; status: string; ended_at: string | null; runner_node: string | null }>();
		for (const r of results ?? []) {
			const at = r.ended_at ? Date.parse(`${r.ended_at.replace(" ", "T")}Z`) : Number.NaN;
			facts.set(r.id, { id: r.id, status: r.status, endedAt: Number.isFinite(at) ? at : null, node: r.runner_node });
		}
	}
	return facts;
}

/** Has the session this run drives been over for long enough that the run is not simply finishing? */
export function sessionIsGone(fact: SessionFact | undefined, now: number): boolean {
	return !!fact && fact.status === "ended" && (fact.endedAt === null || now - fact.endedAt > SESSION_END_GRACE_MS);
}

interface RunView {
	status: string;
	sessionId: string | null;
	health: string;
	waitNote: string | null;
}

/**
 * Fold the session's state into a run's published verdict. A `running` run whose session is gone is `stalled` — "someone has to look" —
 * with the sentence that says what and what to do; `session` carries the evidence either way. A closed run, or one with no session, is
 * returned untouched.
 */
export function reconcileRunWithSession<V extends RunView>(view: V, facts: ReadonlyMap<string, SessionFact>, now: number): V & { session?: { id: string; status: string; endedAt: number | null }; sessionEnded?: true } {
	if (view.status !== "running" || !view.sessionId) return view;
	const fact = facts.get(view.sessionId);
	if (!fact) return view;
	const session = { id: fact.id, status: fact.status, endedAt: fact.endedAt };
	if (!sessionIsGone(fact, now)) return { ...view, session };
	const gone = `Its session ${fact.id} has ended${fact.endedAt ? ` (${new Date(fact.endedAt).toISOString()})` : ""}, so nothing can advance this run or take an answer — what it shows below is where it stopped, not a wait that is still going. Stop it with coding_loop_stop and start it again with coding_loop_start (pass the same issue).`;
	return { ...view, session, sessionEnded: true, health: "stalled", waitNote: view.waitNote ? `${view.waitNote} ${gone}` : gone };
}

export interface ParkedDecisionRun {
	runId: string;
	sessionId: string;
	/** The machine its session lives on, or null when none is recorded. */
	node: string | null;
	question: string | null;
}

/** The instance's runs parked on a question, with the machine each one's session is on. */
export async function parkedDecisionRuns(env: Pick<Env, "DB">, instanceId: string, userId: string): Promise<ParkedDecisionRun[]> {
	const { results } = await env.DB.prepare(
		`SELECT r.run_id, r.session_id, r.waiting_ask, s.runner_node
		   FROM agent_loop_runs r LEFT JOIN coding_sessions s ON s.id = r.session_id
		  WHERE r.instance_id = ?1 AND r.user_id = ?2 AND r.status = 'running' AND r.waiting_reason = 'decision' AND r.session_id IS NOT NULL
		  ORDER BY r.parked_since`,
	)
		.bind(instanceId, userId)
		.all<{ run_id: string; session_id: string; waiting_ask: string | null; runner_node: string | null }>();
	return (results ?? []).map((r) => {
		let question: string | null = null;
		try {
			const ask = r.waiting_ask ? (JSON.parse(r.waiting_ask) as { question?: unknown }) : null;
			question = typeof ask?.question === "string" ? ask.question : null;
		} catch {
			question = null;
		}
		return { runId: r.run_id, sessionId: r.session_id, node: r.runner_node, question };
	});
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * What a repin must say about parked runs. A run parked on a question resumes on the machine it parked on, and only there (#1242) — the
 * pin moving does not move it, and the machine that holds it must stay connected. Runs already on the new machine are not mentioned;
 * with nothing to say this is null and the reply is unchanged.
 */
export function repinParkedWarning(runs: readonly ParkedDecisionRun[], newNode: string): { parkedRuns: ParkedDecisionRun[]; warning: string } | null {
	const left = runs.filter((r) => norm(r.node) !== norm(newNode) || !norm(newNode));
	if (left.length === 0) return null;
	const where = [...new Set(left.map((r) => r.node ?? "an unrecorded machine"))].join(", ");
	return {
		parkedRuns: left,
		warning: `${left.length === 1 ? "A run is" : `${left.length} runs are`} parked on a question on ${where}, not on ${newNode || "the new placement"}. Repinning does not move ${left.length === 1 ? "it" : "them"}: ${left.length === 1 ? "it resumes" : "they resume"} on ${where}, and only there, once answered — keep that machine connected, or stop the run (coding_loop_stop) and start it again on the new machine (coding_loop_start, same issue).`,
	};
}

/** {@link repinParkedWarning} over the instance's own runs, for the pin route to spread into its reply. A failed read says nothing rather than failing the repin, which has already been saved. */
export async function repinNote(env: Pick<Env, "DB">, instanceId: string, userId: string, newNode: string): Promise<{ parkedRuns?: ParkedDecisionRun[]; warning?: string }> {
	try {
		return repinParkedWarning(await parkedDecisionRuns(env, instanceId, userId), newNode) ?? {};
	} catch {
		return {};
	}
}
