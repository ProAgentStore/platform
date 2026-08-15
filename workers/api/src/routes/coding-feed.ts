import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { resolveRunState } from "../lib/coding-run-state.js";
import { listSessions } from "../lib/coding-store.js";
import type { CodingSessionRecord } from "../lib/coding-types.js";
import { loadTimelineFeed } from "../lib/coding-timeline.js";
import { callRunner, READ_TIMEOUT_MS } from "../lib/runner-client.js";
import type { Env } from "../types.js";
import { getSessionRunnerConn, requireOwned } from "./coding-shared.js";

/**
 * `GET /v1/instances/:instanceId/coding/timeline` — the cursored read of what a coding run is
 * doing, answerable WHILE the run is in flight (#581) and after it has ended (#527).
 *
 * ── Why this is an instance-level route and not a query on the session one
 *
 * The session-scoped `…/coding/sessions/:sessionId/timeline` next door needs a session id, and
 * the caller who most needs this does not have one: #581's measured case is an MCP client
 * watching a run it started with `coding_loop_start`, which returns a RUN id. Making the caller
 * fetch the session list first is a round trip whose answer this route can compute, and it is
 * one more place for the "first active session" rule to be written down differently.
 *
 * Resolution, in order: the `session_id` asked for, else the newest ACTIVE session, else the most
 * recently updated one. That last fallback is deliberate and is what makes one tool answer both
 * issues — the platform ends sessions by itself constantly (the Pilot closes one on every finished
 * run), so a run that finished a minute ago has no active session and is exactly what #527's audit
 * case wants to read.
 *
 * ── `runState`, and the distinction it exists to draw
 *
 * #581 AC3: an empty page means two opposite things, and an event list alone cannot tell them
 * apart. Empty + `thinking`/`responding` is a long step. Empty + `idle`/`offline` is #580's case —
 * a run whose engine died at step 1 while the run record read `running` for 4.35 hours.
 *
 * An ENDED session reports `ended` rather than the runner's `idle`. #527 measured
 * `coding_session_capture` answering a real, finished, 6-minute run with `runState:"idle"` and an
 * empty pane, which is indistinguishable from a session that never did anything — and no runner
 * is asked about a session it no longer holds, so `idle` there is not even a reading.
 */
export function registerFeedRoutes(codingRoutes: Hono<{ Bindings: Env }>): void {
	codingRoutes.get("/:instanceId/coding/timeline", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		// `listSessions` orders by `updated_at DESC`, so the first match of either arm is newest.
		const sessions = await listSessions(c.env, instanceId, uid);
		const wanted = c.req.query("session_id");
		const session = wanted
			? sessions.find((s) => s.id === wanted)
			: (sessions.find((s) => s.status === "active") ?? sessions[0]);
		if (!session) throw new HttpError(404, wanted ? "Session not found" : "No coding session on this instance");
		const num = (q: string) => {
			const n = Number.parseInt(c.req.query(q) ?? "", 10);
			return Number.isFinite(n) ? n : undefined;
		};
		const feed = await loadTimelineFeed(c.env, { sessionId: session.id, sinceSeq: num("since"), limit: num("limit") });
		const { runState, runnerConnected } = await readRunState(c.env, instanceId, uid, session);
		return c.json({
			sessionId: session.id,
			sessionStatus: session.status,
			repoId: session.repoId,
			engineLabel: session.tmuxSession ?? null,
			runState,
			runnerConnected,
			...feed,
		});
	});
}

/**
 * What the engine is doing, as far as anything can say.
 *
 * `unknown` is a real answer and is not collapsed into `idle`: the runner is connected but did not
 * answer the capture, so the honest report is that nobody knows. Collapsing it would be the same
 * defect #580 is about — a dead thing reported as a benign state.
 *
 * The mapping itself moved to `lib/coding-run-state.ts` (#593). It was stated here first and
 * correctly, while `/capture` — the same probe, the surface MCP publishes — answered `idle` on all
 * three of these paths. Two vocabularies over one probe is what let the older one keep shipping.
 */
async function readRunState(
	env: Env,
	instanceId: string,
	uid: string,
	session: CodingSessionRecord,
): Promise<{ runState: string; runnerConnected: boolean }> {
	if (session.status !== "active") return { runState: resolveRunState({ sessionActive: false, runnerConnected: false }), runnerConnected: false };
	const conn = await getSessionRunnerConn(env, instanceId, uid, session).catch(() => null);
	if (!conn) return { runState: resolveRunState({ sessionActive: true, runnerConnected: false }), runnerConnected: false };
	const snap = await callRunner<{ runState?: string }>(conn, "/coding/capture", { sessionId: session.id }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => null);
	return { runState: resolveRunState({ sessionActive: true, runnerConnected: true, engineRunState: snap?.runState }), runnerConnected: true };
}
