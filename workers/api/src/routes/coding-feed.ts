import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { resolveRunState } from "../lib/coding-run-state.js";
import { listSessions } from "../lib/coding-store.js";
import type { CodingSessionRecord } from "../lib/coding-types.js";
import { loadTerminalSnapshots, loadTimelineFeed } from "../lib/coding-timeline.js";
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
 * Resolution, in order: the `session_id` asked for, else the loop `run_id`'s recorded coding
 * session, else the newest ACTIVE session, else the most recently updated one. That last fallback
 * is deliberate and is what makes one tool answer both issues — the platform ends sessions by
 * itself constantly (the Pilot closes one on every finished run), so a run that finished a minute
 * ago has no active session and is exactly what #527's audit case wants to read.
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
 *
 * ── Which end of the log a caller gets (#674)
 *
 * `since` polls forward, `before` walks back, and a caller who names NEITHER gets the newest page.
 * It used to get the oldest, which meant page 1 of a real run was `brain, brain, command` — every
 * instruction precedes every piece of output — and the owner watching a run over MCP concluded the
 * engine's output was never recorded. See `lib/coding-timeline.ts`'s header for the full reasoning
 * and for the two alternatives that were rejected.
 *
 * ── `?terminal=1`: the same session, its panes UNCUT (#699)
 *
 * The feed's per-row tail is right for a feed and is 5% of what is stored. The arm below answers
 * the other read — whole snapshots, one or a few at a time, `before` walking back — off the same
 * resolution, so a finished run's terminal text has a reader. The reasoning is at the call site.
 */
export function registerFeedRoutes(codingRoutes: Hono<{ Bindings: Env }>): void {
	codingRoutes.get("/:instanceId/coding/timeline", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		// `listSessions` orders by `updated_at DESC`, so the first match of either arm is newest.
		const sessions = await listSessions(c.env, instanceId, uid);
		const wanted = c.req.query("session_id");
		const runId = c.req.query("run_id");
		const runSessionId = !wanted && runId ? await sessionIdForLoopRun(c.env, instanceId, uid, runId) : null;
		const session = wanted
			? sessions.find((s) => s.id === wanted)
			: runId
				? sessions.find((s) => s.id === runSessionId)
				: (sessions.find((s) => s.status === "active") ?? sessions[0]);
		if (!session) throw new HttpError(404, wanted ? "Session not found" : runId ? "Run coding session not found" : "No coding session on this instance");
		const num = (q: string) => {
			const n = Number.parseInt(c.req.query(q) ?? "", 10);
			return Number.isFinite(n) ? n : undefined;
		};
		// ── `?terminal=1` — the SNAPSHOTS, whole, on the same session resolution (#699) ──
		//
		// The feed above cuts a `terminal` row to its 400-character tail, because a page of forty
		// events cannot carry forty 8,000-character panes under `FEED_BYTE_BUDGET`. Measured live on
		// 2026-08-18: an ended session with 8 stored snapshots holds 64,000 characters and the feed
		// reaches 3,200 of them, i.e. 5%. The whole text was never absent — `loadTerminalSnapshots`
		// has served it uncapped to the console's scrollback since #432 — but only from the
		// SESSION-scoped route next door, which needs a session id the caller of this one does not
		// have. So the pane of a finished run was reachable by no MCP tool at all: the feed returns a
		// tail, and `coding_session_capture` correctly answers a finished session with an empty pane
		// because the pane is a runner buffer that no longer exists.
		//
		// It is an ARM of this route rather than a route of its own precisely so the resolution rule
		// above — the session asked for, else the run's recorded session, else the newest active, else
		// the most recently updated — is the same code and not a second statement of it. That fallback
		// is what makes it answer for a run that has already ended, which is the case #527 established
		// and the only case this arm exists for.
		//
		// Bounded by ROW COUNT, not bytes. A snapshot is indivisible here: half a pane cut mid-line is
		// not a smaller answer, it is a different one, and the tail cut is exactly what this arm is
		// undoing. `loadTerminalSnapshots` clamps `limit` to 1..50 and `before` walks back, so the
		// caller pages by whole panes and `hasMore` says whether history remains. `after` is
		// deliberately NOT plumbed: its tail/gap semantics belong to the console's snapshot cache
		// (#550), and a reader walking backwards through history has no cache to extend.
		if (c.req.query("terminal") === "1") {
			const page = await loadTerminalSnapshots(c.env, { sessionId: session.id, before: num("before"), limit: num("limit") });
			return c.json({
				sessionId: session.id,
				sessionStatus: session.status,
				entries: page.entries,
				hasMore: page.hasMore,
				oldestSeq: page.oldestSeq,
				newestSeq: page.newestSeq,
			});
		}
		// `since` and `before` are opposite directions and `loadTimelineFeed` refuses both at once;
		// surfaced as a 400 rather than a 500 because it is the caller's mistake, not the server's.
		let feed: Awaited<ReturnType<typeof loadTimelineFeed>>;
		try {
			feed = await loadTimelineFeed(c.env, {
				sessionId: session.id,
				sinceSeq: num("since"),
				before: num("before"),
				limit: num("limit"),
			});
		} catch (err) {
			throw new HttpError(400, err instanceof Error ? err.message : "Bad cursor");
		}
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

async function sessionIdForLoopRun(env: Env, instanceId: string, uid: string, runId: string): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT session_id FROM agent_loop_runs WHERE run_id = ?1 AND instance_id = ?2 AND user_id = ?3 LIMIT 1",
	)
		.bind(runId, instanceId, uid)
		.first<{ session_id: string | null }>();
	return row?.session_id ?? null;
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
