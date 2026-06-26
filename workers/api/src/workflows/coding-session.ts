import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
	decideCodingAction,
	runCodingLoop,
	type CodingActionKind,
	type CodingDecision,
	type CodingDeps,
	type CodingGoal,
	type CodingPaneSnapshot,
	type CodingResult,
} from "../lib/coding-loop.js";
import { callRunner, getRunnerConn } from "../lib/runner-client.js";
import { appendTimeline, contextForCopilot } from "../lib/coding-timeline.js";
import { copilotSummary } from "../lib/coding-copilot.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

export interface CodingSessionParams {
	instanceId: string;
	userId: string;
	/** The coding_sessions row this workflow drives. */
	sessionId: string;
	/** Repo identity + clone source, so the runner can (re)clone if it lost the session. */
	repoId: string;
	cloneUrl?: string;
	branch?: string;
	/** GitHub App installation token for cloning a private repo. */
	token?: string;
	goal: CodingGoal;
	/**
	 * "watch": don't drive the CLI — the user just sent it an instruction manually
	 * (➤ Agent). Wait for the pane to go idle, then summarize what happened and
	 * notify the user. Durable, so it reaches them even with the console closed.
	 */
	mode?: "watch";
	/** This watcher's id — only the one currently stamped on the session notifies. */
	watchId?: string;
}

/** Max minutes to wait for a human to resolve a stuck/needs-input handoff. */
const HANDOFF_WAIT_POLLS = 180; // 180 × 5s = 15 min

/**
 * The coding orchestrator's remote brain: a durable Cloudflare Workflow that
 * drives the user's local coding CLI (in tmux) toward an objective — read the
 * pane, ask Claude (BYOK) for the next instruction, send it, wait for idle,
 * repeat. On a stuck/needs-input it hands off to the human via the same console
 * takeover, polls until resolved, then resumes. Durable steps → survives the 30s
 * request limit, same machinery as {@link JobApplyWorkflow} for the browser.
 */
export class CodingSessionWorkflow extends WorkflowEntrypoint<Env, CodingSessionParams> {
	async run(event: WorkflowEvent<CodingSessionParams>, step: WorkflowStep): Promise<CodingResult> {
		if (event.payload.mode === "watch") return this.runWatch(event, step);
		const { instanceId, userId, sessionId, repoId, cloneUrl, branch, token, goal } = event.payload;
		const env = this.env;

		const conn = await getRunnerConn(env, instanceId, userId);
		if (!conn) {
			return { outcome: "failed", detail: "No coding runner connected. Start it with: pags up", steps: 0 };
		}

		// Ensure the tmux session is up and the CLI launched (clones the repo if the
		// runner doesn't already have this session, e.g. after a runner restart).
		await step.do("start", { retries: { limit: 1, delay: "3 seconds" as const, backoff: "constant" as const }, timeout: "5 minutes" as const }, () =>
			callRunner<{ sessionId?: string }>(conn, "/coding/start", { sessionId, repoId, cloneUrl, branch, token, clientType: goal.clientType }),
		);
		// Record the run in the session history (idempotent across replays).
		await step.do("tl-start", async () => {
			await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: `AI run started — objective: ${goal.objective}` });
			return null;
		});

		const retry = { retries: { limit: 2, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "3 minutes" as const };
		// waitIdle polls internally for minutes, so it needs a longer step budget than `retry`.
		const idleRetry = { retries: { limit: 1, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "10 minutes" as const };
		let n = 0;
		const capture = () => callRunner<CodingPaneSnapshot & { sessionId: string }>(conn, "/coding/capture", { sessionId });

		const deps: CodingDeps = {
			snapshot: () => step.do(`s${n++}-snapshot`, retry, capture) as Promise<CodingPaneSnapshot>,
			act: (a: CodingActionKind) =>
				step.do(`s${n++}-act`, retry, () => callRunner<CodingPaneSnapshot>(conn, "/coding/act", { sessionId, action: a })) as Promise<CodingPaneSnapshot>,
			decide: (p) => step.do(`s${n++}-decide`, retry, () => decideCodingAction(env, userId, p)) as Promise<CodingDecision>,
			// Poll capture until the CLI goes idle (the pane stops "thinking"/"responding").
			// Bounded so the loop can't outrun idleRetry's 10-minute step timeout.
			waitIdle: () =>
				step.do(`s${n++}-waitidle`, idleRetry, async () => {
					// Settle first: a just-sent instruction may not have flipped the pane
					// to "thinking" yet, so an immediate capture could read a stale idle.
					await sleep(1500);
					let snap = await capture();
					for (let poll = 0; poll < 240 && snap.runState !== "idle" && snap.alive && !snap.cancelled; poll++) {
						await sleep(2000);
						snap = await capture();
					}
					return snap;
				}) as Promise<CodingPaneSnapshot>,
			onEvent: (type, message, data) =>
				step.do(`s${n++}-event`, async () => {
					await callRunner(conn, "/coding/event", { sessionId, type, message, data }).catch(() => undefined);
					return null;
				}).then(() => undefined),
		};

		let result: CodingResult = { outcome: "failed", detail: "did not start", steps: 0 };
		for (let round = 0; round < 12; round++) {
			result = await runCodingLoop(deps, goal, { maxSteps: 40 });
			if (result.outcome !== "stuck" && result.outcome !== "needs_input") break;

			const reason = result.outcome === "needs_input" ? "needs_input" : "stuck";
			const label = result.outcome === "needs_input" ? result.fieldNeeded ?? "a value" : result.detail ?? "this step";
			await step.do(`handoff-${round}`, () => callRunner<{ ok?: boolean }>(conn, "/coding/takeover", { sessionId, label, reason }));
			// Ping the user — the agent is paused waiting on them.
			await step.do(`notify-handoff-${round}`, async () => {
				await notifyUser(env, userId, "coding", "🙋 Coder needs you", `${goal.repo}: ${label}`, `/console/instances/${instanceId}/coding`).catch(() => undefined);
				return null;
			});

			let resolved = false;
			let providedValue: string | undefined;
			for (let poll = 0; poll < HANDOFF_WAIT_POLLS && !resolved; poll++) {
				await step.sleep(`wait-${round}-${poll}`, "5 seconds");
				const status = await step.do(`hstatus-${round}-${poll}`, () =>
					callRunner<{ resolved: boolean; value?: string }>(conn, "/coding/takeover-status", { sessionId }),
				).catch(() => ({ resolved: false }) as { resolved: boolean; value?: string });
				resolved = status.resolved;
				if (resolved) providedValue = status.value;
			}
			if (!resolved) {
				return { outcome: "failed", detail: `${reason} not resolved in time`, steps: result.steps, transcript: result.transcript };
			}
			if (result.outcome === "needs_input" && providedValue && result.fieldNeeded) {
				goal.userHint = `${result.fieldNeeded}: ${providedValue}`;
			}
			await step.do(`resume-${round}`, () => callRunner<{ ok?: boolean }>(conn, `/coding/takeover/${encodeURIComponent(sessionId)}/end`, {}));
		}

		await step.do("end", async () => {
			await callRunner<{ ok?: boolean }>(conn, "/coding/end", { sessionId }).catch(() => undefined);
			// The runner session is now gone — sync the D1 row so it doesn't sit
			// "active" forever (the row was created active by the /sessions route).
			const status = result.outcome === "failed" || result.outcome === "max_steps" ? "error" : "ended";
			await env.DB.prepare(
				"UPDATE coding_sessions SET status = ?4, ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status = 'active'",
			).bind(sessionId, instanceId, userId, status).run();
			await appendTimeline(env, { sessionId, instanceId, userId, type: "outcome", content: `${result.outcome}${result.detail ? ` — ${result.detail}` : ""}` });
			return null;
		});

		// Tell the user the run is over so they can check the results + summary.
		await step.do("notify-end", async () => {
			const ok = result.outcome !== "failed" && result.outcome !== "max_steps";
			const title = ok ? "✅ Coder finished" : "⚠️ Coder stopped";
			const body = `${goal.repo}: ${result.detail || result.outcome}`;
			await notifyUser(env, userId, "coding", title, body, `/console/instances/${instanceId}/coding`).catch(() => undefined);
			return null;
		});
		return result;
	}

	/**
	 * Watch a manually-driven session: the user typed an instruction into the CLI
	 * (➤ Agent). Wait for the pane to settle to idle, then summarize what happened,
	 * persist it to the chat thread, and notify the user — so "the agent comes back
	 * to you" the same way the autonomous run does, even with the console closed.
	 */
	private async runWatch(event: WorkflowEvent<CodingSessionParams>, step: WorkflowStep): Promise<CodingResult> {
		const { instanceId, userId, sessionId, goal } = event.payload;
		const env = this.env;
		const conn = await getRunnerConn(env, instanceId, userId);
		if (!conn) return { outcome: "failed", detail: "No coding runner connected.", steps: 0 };

		// Wait for the just-sent instruction to run to completion (pane goes idle).
		const finalPane = (await step.do(
			"watch-idle",
			{ retries: { limit: 1, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "15 minutes" as const },
			async () => {
				const capture = () => callRunner<CodingPaneSnapshot & { sessionId: string }>(conn, "/coding/capture", { sessionId });
				await sleep(2500); // let the CLI receive the input
				let snap = await capture();
				// Phase 1: wait for Claude to actually START on it (go non-idle), up to ~24s.
				// A quick/no-op message may never go busy — fall through and summarize anyway,
				// rather than reading a premature idle and reporting "nothing happened".
				for (let i = 0; i < 12 && snap.runState === "idle" && snap.alive && !snap.cancelled; i++) {
					await sleep(2000);
					snap = await capture();
				}
				// Phase 2: wait for it to FINISH (return to idle).
				for (let poll = 0; poll < 360 && snap.runState !== "idle" && snap.alive && !snap.cancelled; poll++) {
					await sleep(2000);
					snap = await capture();
				}
				return snap;
			},
		)) as CodingPaneSnapshot;

		// Bow out if a later send superseded this watcher — only the latest one
		// notifies, so one completion can't fire several push notifications.
		const stillLatest = (await step.do("watch-is-latest", async () => {
			if (!event.payload.watchId) return true;
			const row = await env.DB.prepare("SELECT watch_workflow_id FROM coding_sessions WHERE id = ?1")
				.bind(sessionId)
				.first<{ watch_workflow_id: string | null }>();
			return !row?.watch_workflow_id || row.watch_workflow_id === event.payload.watchId;
		})) as boolean;
		if (!stillLatest) return { outcome: "done", detail: "superseded by a newer send", steps: 0 };

		// Summarize what the agent did, post it to the thread, and ping the user.
		await step.do("watch-summarize", async () => {
			const memory = await contextForCopilot(env, sessionId);
			const reply = await copilotSummary(env, userId, { finished: true, memory, pane: finalPane.pane || "" }).catch(() => "");
			if (reply) await appendTimeline(env, { sessionId, instanceId, userId, type: "chat_assistant", content: reply });
			await notifyUser(
				env,
				userId,
				"coding",
				"✅ Coder finished",
				`${goal.repo}: ${reply ? reply.slice(0, 140) : "done — open to see what it did"}`,
				`/console/instances/${instanceId}/coding`,
			).catch(() => undefined);
			return null;
		});
		return { outcome: "done", detail: "watched to idle", steps: 0 };
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
