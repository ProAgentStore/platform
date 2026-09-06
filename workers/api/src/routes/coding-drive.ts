import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import type { CodingActionKind, CodingGoal } from "../lib/coding-loop.js";
import { endCodingSession } from "../lib/coding-session-end.js";
import { startSessionOnRunner } from "../lib/coding-session-open.js";
import { claimSessionDriver, getRepo, getSession, touchSessionActivity } from "../lib/coding-store.js";
import { appendTimeline } from "../lib/coding-timeline.js";
import { openBudget } from "../lib/delegation-budget-store.js";
import { noteUnmeteredHeadlessDrive } from "../lib/engine-metering.js";
import { logError } from "../lib/error-log.js";
import { resolveCloneCredential } from "../lib/git-credentials.js";
import { callRunner } from "../lib/runner-client.js";
import { getSessionRunnerConn, readSpecialInstructions, requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

/**
 * Driving a coding session and ending it (#775).
 *
 * The second half of the session lifecycle: send a message straight to the CLI, hand the session
 * to the autonomous brain (the durable Workflow), resolve a brain handoff, end it, restart it.
 *
 * The split from `coding-sessions-open.ts` is where a session stops being SET UP and starts
 * being WORKED: everything here presumes an attached session and acts on it. The routes that
 * call a MODEL to decide what to send are not here — those are the Co-pilot/Agent/Overseer three
 * in `coding-brains.ts`. This module only carries the instruction.
 */
export function registerDriveRoutes(codingRoutes: Hono<{ Bindings: Env }>): void {
	/** Send a message straight to the CLI (manual drive, no brain). Keystrokes are refused — see below. */
	codingRoutes.post("/:instanceId/coding/sessions/:sessionId/message", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const sessionId = c.req.param("sessionId");
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const session = await getSession(c.env, instanceId, uid, sessionId);
		if (!session) throw new HttpError(404, "Session not found");
		// A keystroke has never been deliverable here, and this route used to answer one with an
		// ordinary 200 and a fresh snapshot (#448). The engine is a child process with no PTY, so
		// `HeadlessSession.key()` only pushed a line into the transcript; a caller reading
		// `{status, pane}` had no reason to parse it, and "sent, nothing happened" was
		// indistinguishable from success. That cost a full 40-decision BYOK run once — the reasoning
		// is written out at `lib/coding-loop.ts` where `press_keys` was withdrawn from the brain's
		// tool list. The brain was fixed there; the HTTP boundary was not, and the boundary is where
		// the claim is made. Refusing HERE rather than only on the runner is deliberate: a published
		// `@proagentstore/cli` older than this change still accepts `{kind:"keys"}` and no-ops it, so
		// the cloud has to be the one that says no.
		//
		// AFTER `getSession` on purpose: the sibling routes (`resume`, `restart`) 404 an unknown
		// session first, and a 409 raised ahead of the lookup would invert that ordering.
		if (typeof body.keys === "string") {
			throw new HttpError(
				409,
				"This session has no terminal attached, so a keystroke can't be delivered — a human needs to answer the prompt. Phrase the answer as an instruction and send it as {\"text\": \"...\"} on this route, or restart the engine with POST /v1/instances/:id/coding/sessions/:sid/restart.",
			);
		}
		const action: CodingActionKind = { kind: "message", text: String(body.text ?? "") };
		// An empty instruction is not deliverable either (#504), for the same reason a keystroke isn't:
		// `session.input("")` writes an empty user turn to the engine's stdin, which flips the pane to
		// "thinking" and answers 200 with a snapshot — indistinguishable from having sent something. The
		// Pilot is guarded in `runCodingLoop`; this is the other door into `/coding/act`, and MCP's
		// `coding_session_message` passes its argument straight through it.
		if (!action.text.trim()) {
			throw new HttpError(400, "An instruction can't be empty — send the text you want the engine to act on.");
		}
		await touchSessionActivity(c.env, instanceId, uid, sessionId);
		// `chat:true` = sent from the Agent chat (relay my words to Claude on my behalf),
		// so persist it as a chat turn (survives reload) — not just the raw command log.
		const fromChat = body.chat === true;
		const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
		if (!conn) throw new HttpError(409, "No coding runner connected. Start it with: pags up");
		if (action.kind === "message" && action.text) {
			// Log the user's clean text first…
			await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: fromChat ? "chat_user" : "command", content: action.text }).catch(() => undefined);
			// …then prepend the combined rules (instance Special Instructions + per-repo
			// Rules) before sending to the CLI. Manual sends bypass the autonomous brain
			// (which injects rules into its own prompt), so without this the CLI never sees
			// them. This makes the rules bind the CLI no matter how it's driven.
			const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
			const combined = [await readSpecialInstructions(c.env, instanceId, uid), repo?.instructions].filter(Boolean).join("\n\n");
			if (combined) action.text = `[Project rules — follow these for everything you do:\n${combined}\n]\n\n${action.text}`;
		}
		let snap = await callRunner(conn, "/coding/act", { sessionId, action }).catch(() => null);
		if (snap === null) {
			// The runner is online but lost the in-memory session (it restarted) — its
			// tmux pane usually survives, so reattach (CodingSession.start reconnects to
			// the live tmux, no new CLI) and retry once. On a machine SWITCH, startSessionOnRunner
			// relocates the session and returns the LIVE machine's connection — retry on that, not
			// the captured `conn` (which points at the old, now-dead machine → 409).
			const fresh = await getSession(c.env, instanceId, uid, sessionId);
			const repo = fresh ? await getRepo(c.env, instanceId, uid, fresh.repoId) : null;
			const relocated = fresh && repo ? (await startSessionOnRunner(c.env, instanceId, uid, fresh, repo)).conn : null;
			snap = await callRunner(relocated ?? conn, "/coding/act", { sessionId, action }).catch(() => null);
		}
		if (snap === null) throw new HttpError(409, "This session isn't live on the runner — open it again (or run pags up).");
		await noteUnmeteredHeadlessDrive(c.env, { userId: uid, instanceId, traceId: sessionId }, session);

		// Drove the CLI with a real instruction → spin up a durable watcher that waits
		// for it to finish, then summarizes + notifies (reaches the user even if they
		// close the console). Each send supersedes the prior watcher: we stamp the
		// session with this watcher's id, and a watcher only notifies if it's still the
		// stamped one — so several sends can't fire several push notifications for one
		// completion.
		if (action.kind === "message" && action.text) {
			const repo = session ? await getRepo(c.env, instanceId, uid, session.repoId) : null;
			const watchId = `cw-${sessionId}-${Date.now()}`;
			// The stamp IS the supersession rule, so losing it inverts it: the column still holds the
			// PREVIOUS send's watchId, this watcher stands down as "superseded by a newer send", and the
			// stale one — still stamped — announces "✅ Coder finished" against the earlier instruction.
			// A wrong completion notice is worse than a missing one; start no watcher unless it can win.
			const stamped = await c.env.DB.prepare(
				"UPDATE coding_sessions SET watch_workflow_id = ?1 WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4",
			)
				.bind(watchId, sessionId, instanceId, uid)
				.run()
				.then(() => true, () => false);
			const noWatcher = () =>
				appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: "system", content: "(Couldn't start the progress watcher — I won't auto-report when this finishes; ask me for an update.)" }).catch(() => undefined);
			if (!stamped) await noWatcher();
			else
				await c.env.CODING_SESSION.create({
					id: watchId,
					params: {
						instanceId,
						userId: uid,
						sessionId,
						repoId: repo?.id ?? "",
						runnerNode: session.runnerNode ?? null,
						mode: "watch",
						watchId,
						goal: { objective: action.text, repo: repo?.name ?? "your repo", clientType: session?.clientType ?? "claude" },
					},
				}).catch(noWatcher);
		}
		return c.json(snap as object);
	});

	/** Hand the session to the autonomous brain (the durable Workflow) with an objective. */
	codingRoutes.post("/:instanceId/coding/sessions/:sessionId/run", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const sessionId = c.req.param("sessionId");
		const session = await getSession(c.env, instanceId, uid, sessionId);
		if (!session) throw new HttpError(404, "Session not found");
		const repo = await getRepo(c.env, instanceId, uid, session.repoId);
		if (!repo) throw new HttpError(404, "Repo not found");
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const objective = String(body.objective ?? "").trim();
		if (!objective) return c.json({ error: "objective is required" }, 400);

		// One driver per engine (#208). Claimed BEFORE the workflow is created, because the damage
		// isn't a duplicate row — it's two Pilots typing into the same tmux pane, each reasoning over
		// a terminal the other is also writing to. A 409 is the honest answer: the work IS already
		// running, and starting a second one would corrupt the first.
		const driverId = crypto.randomUUID();
		if (!(await claimSessionDriver(c.env, instanceId, uid, sessionId, driverId))) {
			throw new HttpError(409, "This session is already being driven — stop the current run before starting another.");
		}

		const instanceInstructions = await readSpecialInstructions(c.env, instanceId, uid);
		const repoInstructions = repo.instructions;
		const combined = [instanceInstructions, repoInstructions].filter(Boolean).join("\n\n");
		const goal: CodingGoal = {
			objective,
			repo: repo.name,
			clientType: session.clientType,
			specialInstructions: combined || undefined,
			dryRun: body.dryRun === true,
		};
		// One credential seam for every provider (#221) — see lib/git-credentials.ts.
		const credential = await resolveCloneCredential(c.env, uid, repo);
		// Every autonomous entry point opens a pool (#184, #502). This one did not: it created the
		// workflow with no `budgetId`, and the Pilot's `decide` short-circuits straight past `reserve`
		// when it has none — so a run started here spent BYOK Claude with nothing reserving, nothing
		// settling, and nothing to trip when the account ceiling is reached. `POST /loop` has done this
		// since #374; a direct drive of one named session is the same commitment made through a
		// narrower door. Depth 0: this is a root run, not a delegation.
		const budget = await openBudget(c.env, uid, instanceId);
		const wf = await c.env.CODING_SESSION.create({
			params: {
				instanceId,
				userId: uid,
				sessionId,
				repoId: repo.id,
				runnerNode: session.runnerNode ?? null,
				cloneUrl: repo.cloneUrl,
				branch: repo.branch || undefined,
				token: credential?.token,
				tokenUsername: credential?.username,
				goal,
				driverId,
				budgetId: budget.id,
				depth: 0,
			},
		});
		// The Pilot's own act loop lives in the Workflow and drives the same engine forty more times;
		// the day-coarse row id means this one observation at the handoff covers all of them (#556).
		await noteUnmeteredHeadlessDrive(c.env, { userId: uid, instanceId, traceId: sessionId }, session);
		return c.json({ workflowId: wf.id, sessionId, budgetId: budget.id });
	});

	/** Resolve a brain handoff: the human finished, so the workflow may resume. */
	codingRoutes.post("/:instanceId/coding/sessions/:sessionId/resume", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const sessionId = c.req.param("sessionId");
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const session = await getSession(c.env, instanceId, uid, sessionId);
		if (!session) throw new HttpError(404, "Session not found");
		const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
		if (!conn) throw new HttpError(409, "No coding runner connected");
		await touchSessionActivity(c.env, instanceId, uid, sessionId);
		// `body.value` is the human's answer to a blocked engine — a 2FA code, a field the agent could
		// not fill. Swallowing the delivery reported it landed and threw it away: the Pilot goes on
		// polling /coding/takeover-status, never sees `resolved`, and closes the run
		// "<reason> not resolved in time" — a run recorded as the HUMAN's timeout when the human did
		// answer. Same rule the ticket-cancel route states: don't report success for a call that failed.
		const delivered = await callRunner(conn, `/coding/takeover/${encodeURIComponent(sessionId)}/resolve`, {
			value: typeof body.value === "string" ? body.value : undefined,
		}).then(() => true, () => false);
		if (!delivered) throw new HttpError(502, "Couldn't hand your answer to the coding runner — it's still waiting. Try again.");
		return c.json({ ok: true });
	});

	/**
	 * End a session: stop the engine on the machine + close the D1 record.
	 *
	 * The body moved to `lib/coding-session-end.ts` at #540, unchanged, because the agent's own
	 * `end_coding_session` tool has to end a session exactly the way this button does — and the four
	 * things this route does beyond flipping the row (drain the closing turn's spend #267, record who
	 * paid #554, drain the closing acts #294, refuse to report a stop the engine did not confirm) are
	 * each here because they were once missing. A second copy would restate them today and stop
	 * restating them at the next change. The response shape is unchanged.
	 */
	codingRoutes.post("/:instanceId/coding/sessions/:sessionId/end", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const ended = await endCodingSession(c.env, { instanceId, userId: uid, sessionId: c.req.param("sessionId") });
		return c.json(ended.warning ? { ok: ended.ok, engineStopped: false, warning: ended.warning } : { ok: ended.ok });
	});

	/**
	 * Diagnostics: restart a session's CLI process on the runner (kill + relaunch
	 * with the SAME session id, keeping the D1 row). For recovering a wedged engine
	 * without losing the session/timeline.
	 */
	codingRoutes.post("/:instanceId/coding/sessions/:sessionId/restart", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const session = await getSession(c.env, instanceId, uid, c.req.param("sessionId"));
		if (!session) throw new HttpError(404, "Session not found");
		if (session.status !== "active") return c.json({ ok: false, error: "session has ended" }, 409);
		const repo = await getRepo(c.env, instanceId, uid, session.repoId);
		if (!repo) throw new HttpError(404, "Repo not found");
		const conn = await getSessionRunnerConn(c.env, instanceId, uid, session);
		if (!conn) return c.json({ ok: false, runnerConnected: false });
		await touchSessionActivity(c.env, instanceId, uid, session.id);
		// Restart is kill-then-relaunch under the SAME session id. Swallowing the kill meant a failed
		// stop still fell through to the relaunch, putting TWO engine processes on one working tree —
		// the exact race `coding/headless.ts` guards against, and the one restart exists to escape.
		// A wedged engine is recoverable; two engines writing the same checkout corrupts the work. So
		// a failed stop aborts the restart instead of doubling the problem.
		const stopFailed = await callRunner(conn, "/coding/end", { sessionId: session.id }).then(
			() => null,
			(e: unknown) => (e instanceof Error ? e.message : String(e)),
		);
		if (stopFailed) {
			await logError(c.env, {
				source: "coding",
				userId: uid,
				message: `Refused to restart session ${session.id}: the running engine did not stop (${stopFailed})`,
				context: { instanceId, sessionId: session.id, repoId: repo.id },
			});
			return c.json(
				{
					ok: false,
					runnerConnected: true,
					error: "Could not stop the running engine, so it was not relaunched — restarting anyway would leave two engines editing this repo at once. Try again, or end the session from Diagnostics → Sessions.",
				},
				409,
			);
		}
		const started = await startSessionOnRunner(c.env, instanceId, uid, session, repo);
		if (!started.conn) {
			// Re-read the repo to get the clone error
			const freshRepo = await getRepo(c.env, instanceId, uid, session.repoId);
			return c.json({ ok: false, runnerConnected: true, error: freshRepo?.cloneError || "Failed to start session on runner" });
		}
		// A restart always launches a NEW engine, so what it came up holding is never rhetorical (#738).
		return c.json({ ok: true, runnerConnected: true, resumed: started.resumed, seeded: started.seeded });
	});
}
