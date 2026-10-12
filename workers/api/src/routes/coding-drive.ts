import type { Hono } from "hono";
import { markHumanAnswered } from "../lib/coder-question-store.js";
import { HttpError } from "../lib/auth.js";
import type { CodingActionKind, CodingGoal } from "../lib/coding-loop.js";
import { resolveCodingPause } from "../lib/coding-answer.js";
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
import { withTurnReplay } from "../lib/coding-turn-replay.js";
import { describeOwner, repoFreeForRun, runnerEngineProbe } from "../lib/coding-ownership.js";
import { dispatchOwnedTurn } from "../lib/coding-dispatch.js";
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
		// ONE WRITER PER CHECKOUT (#1015), through the one dispatch contract every engine-writing door
		// shares (lib/coding-dispatch.ts): admitted and RESERVED in one write, fenced again immediately
		// before the send, and a failed send classified rather than re-sent. On this session's own run
		// it is a STEER, and that run stays the owner — unless it ended before the send, in which case
		// this turn continues as the caller's own direct turn and the run stays ended.
		const ownerText = action.text;
		const repoRow = await getRepo(c.env, instanceId, uid, session.repoId);
		const dispatched = await dispatchOwnedTurn(c.env, {
			scope: { instanceId, userId: uid, repoId: session.repoId, sessionId },
			author: "owner",
			ownerText,
			persistent: session.clientType === "claude",
			probe: runnerEngineProbe(c.env, instanceId, uid),
			prepare: async () => {
				// Log the user's clean text first…
				await appendTimeline(c.env, { sessionId, instanceId, userId: uid, type: fromChat ? "chat_user" : "command", content: action.text }).catch(() => undefined);
				// …then prepend the combined rules (instance Special Instructions + per-repo Rules). Manual
				// sends bypass the autonomous brain (which injects rules into its own prompt), so without
				// this the CLI never sees them. This makes the rules bind the CLI no matter how it's driven.
				const combined = [await readSpecialInstructions(c.env, instanceId, uid), repoRow?.instructions].filter(Boolean).join("\n\n");
				const text = combined ? `[Project rules — follow these for everything you do:\n${combined}\n]\n\n${action.text}` : action.text;
				// #693 slice 2: an engine with no memory of its own gets the platform's record with the turn.
				return withTurnReplay(c.env, { instanceId, userId: uid, repoId: session.repoId, clientType: session.clientType }, { ...action, text });
			},
			send: (sent) => callRunner(conn, "/coding/act", { sessionId, action: sent }),
			// The runner restarted and lost the in-memory session: reattach (on a machine SWITCH this
			// relocates it and returns the LIVE machine's connection) and send there, fenced again.
			reattach: async () => {
				const fresh = await getSession(c.env, instanceId, uid, sessionId);
				const repo = fresh ? await getRepo(c.env, instanceId, uid, fresh.repoId) : null;
				const relocated = fresh && repo ? (await startSessionOnRunner(c.env, instanceId, uid, fresh, repo)).conn : null;
				const target = relocated ?? conn;
				return (sent) => callRunner(target, "/coding/act", { sessionId, action: sent });
			},
		});
		if (!dispatched.ok) {
			const detail = dispatched.owner ? describeOwner(dispatched.owner, repoRow?.name ?? "This repository") : dispatched.detail;
			return c.json({ error: detail, admitted: false, reason: dispatched.reason, ...(dispatched.owner ? { owner: dispatched.owner } : {}) }, 409);
		}
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
						// The turn this watcher settles (#1015): it never releases a newer send's reservation.
						directTurnId: dispatched.turnId,
						goal: { objective: action.text, repo: repo?.name ?? "your repo", clientType: session?.clientType ?? "claude" },
					},
				}).catch(noWatcher);
		}
		return c.json({
			...((dispatched.snap as object | null) ?? {}),
			admission: dispatched.kind === "direct" ? { kind: "direct", turnId: dispatched.turnId } : { kind: "steer", runId: dispatched.runId, turnId: dispatched.turnId },
			// `confirmed: false` — the send's answer was lost; it may have arrived, so it was NOT re-sent.
			delivery: { state: dispatched.delivery, engineBefore: dispatched.engineBefore, directiveId: dispatched.directiveId, processed: false, confirmed: dispatched.confirmed },
		}, dispatched.confirmed ? 200 : 202);
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
		// …and no other writer on the CHECKOUT (#1015): a direct turn or a run on another session.
		const free = await repoFreeForRun(c.env, { instanceId, userId: uid, repoId: repo.id, sessionId }, runnerEngineProbe(c.env, instanceId, uid));
		if (!free.free) return c.json({ error: describeOwner(free.owner, repo.name), owner: free.owner }, 409);
		const driverId = crypto.randomUUID();
		if (!(await claimSessionDriver(c.env, instanceId, uid, sessionId, driverId))) {
			throw new HttpError(409, "This session is already being driven — stop the current run before starting another.");
		}

		// The owner's rules are read by the WORKFLOW, before every decision (#1015,
		// lib/coding-standing-constraints.ts) — the same for this route as for `POST /loop` and the queue.
		const goal: CodingGoal = {
			objective,
			repo: repo.name,
			clientType: session.clientType,
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

	/** Resolve a brain handoff: the human finished (or answered), so the workflow may resume. */
	codingRoutes.post("/:instanceId/coding/sessions/:sessionId/resume", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		// `body.value` is the human's answer to a blocked engine — a 2FA code, a field the agent could
		// not fill, a choice it asked for (#960). One delivery path with `/input`: `lib/coding-answer.ts`.
		// #1025: a person's answer wins over a coder-brain decision at any point.
		await markHumanAnswered(c.env, instanceId, c.req.param("sessionId"), Date.now(), typeof body.value === "string" ? body.value : undefined);
		await resolveCodingPause(c.env, instanceId, uid, c.req.param("sessionId"), typeof body.value === "string" ? body.value : undefined);
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
	 * restating them at the next change.
	 */
	codingRoutes.post("/:instanceId/coding/sessions/:sessionId/end", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const ended = await endCodingSession(c.env, { instanceId, userId: uid, sessionId: c.req.param("sessionId") });
		// Said as it is (#1015): ending an already-ended session is not a failure — it is also how an
		// owner releases a steer's claim the watcher could not — so `ok` is "this session is ended",
		// and `session` says whether this call closed it. The claim and the queue are reported only
		// when there was one, and the queue only as the drain itself answered.
		return c.json({
			ok: ended.session !== null,
			session: !ended.session ? "not_found" : ended.alreadyEnded ? "already_ended" : "ended",
			engineStopped: ended.engineStopped,
			...(ended.warning ? { warning: ended.warning } : {}),
			...(ended.directTurn ? { directTurn: ended.directTurn } : {}),
		});
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
