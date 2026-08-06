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
import { callRunner, getRunnerConn, getBoundRunnerConn, relayConnected, READ_TIMEOUT_MS } from "../lib/runner-client.js";
import { endSession, getSession, getRepo, reassignSessionNode, releaseSessionDriver, touchSessionActivity, touchSessionDriver } from "../lib/coding-store.js";
import { shouldEndSessionAfterRun } from "../lib/coding-session-lifecycle.js";
import { describeRepoState, readRepoWorkingState, type RepoWorkingState } from "../lib/repo-state.js";
import { closeWorkCards, setWorkCardProgress, upsertWorkCard } from "../lib/work-card.js";
import { normalizeRunnerNode } from "../lib/runtime-nodes.js";
import { resolveEngineEnv } from "../lib/coding-engines.js";
import { appendTimeline, contextForCopilot, lastTerminal } from "../lib/coding-timeline.js";
import { delegationTaskRecord } from "../lib/delegation.js";
import { copilotSummary } from "../lib/coding-copilot.js";
import { notifyUser } from "../routes/push.js";
import { markExhausted, reserve, settle } from "../lib/delegation-budget-store.js";
import { instanceSpendMicros, recordEngineUsage } from "../lib/usage.js";
import { sanitizeEngineUsage } from "../lib/engine-usage.js";
import { finishLoopRun, recordIteration } from "../lib/agent-loop-store.js";
import type { Env } from "../types.js";

/** Bounded worst case for one Pilot decide step, in USD micros. Settle refunds the rest. */
const CODING_RESERVE_MICROS = 150_000; // $0.15

export interface CodingSessionParams {
	instanceId: string;
	userId: string;
	/** The coding_sessions row this workflow drives. */
	sessionId: string;
	/** Repo identity + clone source, so the runner can (re)clone if it lost the session. */
	repoId: string;
	/** Runner node that owns this coding session. Null/empty falls back to the legacy default runner. */
	runnerNode?: string | null;
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
	/**
	 * When set, this run is a delegated GOAL (e.g. the Overseer handing work to this Pilot on
	 * the user's behalf, #155). The Pilot updates this board task's status at its terminal
	 * state (done/error) so the delegation is observable on the board, not just in the thread.
	 */
	boardTaskId?: string;
	/**
	 * Delegation budget to draw against (#184). Present ONLY when a supervisor delegated this
	 * run — a human driving their own Coder from the Coding tab passes none and is unmetered,
	 * exactly as before. Adding a cap to that path would change behaviour nobody asked for.
	 */
	budgetId?: string | null;
	/** Depth in the supervision tree; the budget refuses past its cap. */
	depth?: number;
	/**
	 * agent_loop_runs row to close when this finishes (#159). A delegated coding run must be
	 * answerable through `check_delegation` like every other delegation — otherwise the
	 * supervisor is handed a run id it cannot look up.
	 */
	loopRunId?: string | null;
	/**
	 * The single-flight claim this run holds on the session (#208). Released when the run ends —
	 * including the early no-runner return, which is exactly where a claim would otherwise be
	 * stranded and lock the session out of every future run.
	 */
	driverId?: string | null;
	/**
	 * Did THIS run open the session it drives? (#271)
	 *
	 * Absent/false means a human (or an earlier run) opened it, and the Pilot leaves it live when
	 * it finishes. It used to end the session unconditionally, which made delegation single-use:
	 * `loop-drivers.ts` required a live session, the Pilot consumed it, and the next goal 409'd
	 * with a message blaming the runner. It also quietly deleted a session the user had opened by
	 * hand and expected to still be there.
	 *
	 * Defaulting to false is the safe direction: the worst case is an idle session left live,
	 * which the user can end from the Coding tab. The reverse — closing someone else's session —
	 * is not recoverable.
	 */
	sessionOpenedByRun?: boolean;
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
		const { instanceId, userId, sessionId, repoId, runnerNode, cloneUrl, branch, token, goal } = event.payload;
		const env = this.env;

		let conn = await getRunnerConn(env, instanceId, userId, runnerNode ?? null);
		// Machine-switch reclaim (matches the interactive /message path). A durable /run can be
		// queued/resumed long after it was created, by which point the session's owning machine
		// may be offline while the user is running `pags up` elsewhere. `conn` resolves from the
		// DB even for a dead node (the `status` column isn't cleared on disconnect), so verify the
		// relay socket is live; if not, relocate the session to whatever machine the agent runs on
		// now (live + pin-aware) instead of failing the whole autonomous run.
		const live = await relayConnected(env, instanceId, runnerNode ?? null).catch(() => false);
		if (!live) {
			const fallback = await getBoundRunnerConn(env, instanceId, userId);
			if (fallback && normalizeRunnerNode(fallback.runnerNode) !== normalizeRunnerNode(runnerNode)) {
				await reassignSessionNode(env, instanceId, userId, sessionId, fallback.runnerNode ?? null).catch(() => undefined);
				conn = fallback;
			}
		}
		/**
		 * Steps this Pilot has driven, CUMULATIVE across handoff rounds.
		 *
		 * `runCodingLoop` restarts its own `step` counter at 0 each round (up to 12), so
		 * `result.steps` is the LAST round's count, not the run's. The terminal
		 * `recordIteration(runId, outcome.steps)` therefore understated even at the end — and
		 * mid-run it reported nothing at all, so `check_delegation` and `subordinate_status` both
		 * read "iteration 0 of 10" for a run a dozen steps deep. That is the supervisor's only
		 * progress signal, permanently reading zero.
		 */
		let pilotSteps = 0;

		/**
		 * Thoughts seen, for throttling the progress line below.
		 *
		 * The Lead sees card titles, outcomes and step counts — not the terminal text the hardcoded
		 * Overseer reads. There is no clean way for supervision to reach that text and it must not
		 * try (the coupling reverted in 3f14bd3). So the Pilot pushes a plain-language line into its
		 * OWN card instead, and the Lead reads live progress through a generic record while still
		 * knowing nothing about tmux. #207B — the deliberate finish line for Overseer parity.
		 */
		let pilotThoughts = 0;

		/**
		 * Put a line in the OWNER'S CHAT THREAD.
		 *
		 * A loop on a coding agent drives the engine, so the Assistant tab saw nothing at all while
		 * work happened — you pressed Loop and the next thing you learned was that a commit existed.
		 * The instructions the loop sends on your behalf, and the outcome, belong in the
		 * conversation you started it from.
		 *
		 * Written by the WORKFLOW, not the browser. The completion notice used to come from the
		 * console's poll, so closing the tab meant it was never recorded anywhere — the run finished
		 * and the thread simply never mentioned it.
		 */
		const postToChat = async (content: string) => {
			try {
				const stub = env.AGENT.get(env.AGENT.idFromName(instanceId));
				await stub.fetch(
					new Request("https://agent/system-message", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ content }),
					}),
				);
			} catch {
				// The thread is a record, never the work. A failed append must not fail the run.
			}
		};

		/**
		 * Close the rows a DELEGATED run opened — the loop-run row `check_delegation` reads and the
		 * board card the supervisor watches. One writer for both, so they cannot disagree.
		 *
		 * `suffix` distinguishes the step names on the two call paths; a Workflow step name must be
		 * unique within an instance.
		 */
		const closeDelegation = async (outcome: CodingResult, suffix = "") => {
			if (event.payload.loopRunId) {
				await step.do(`delegation-run-done${suffix}`, async () => {
					const reason =
						outcome.outcome === "cancelled"
							? "cancelled"
							: outcome.outcome === "max_steps"
								? "max_iterations"
								: outcome.outcome === "failed"
									? "failed"
									: "done";
					// The Pilot drives its own loop and never called `recordIteration`, so
					// `check_delegation` reported "iteration: 0 of 10" for a run that took a dozen
					// steps — the supervisor's only progress signal, permanently reading zero.
					// Recorded at the terminal state, which is when the real count is known.
					// max(): `outcome.steps` is only the last round's count (see pilotSteps above).
					await recordIteration(env, event.payload.loopRunId as string, Math.max(pilotSteps, outcome.steps ?? 0)).catch(() => undefined);
					await finishLoopRun(
						env,
						event.payload.loopRunId as string,
						reason,
						`outcome: ${outcome.outcome}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
						Date.now(),
					).catch(() => undefined);
					// The result, in the thread the loop was started from. Written HERE rather than by
					// the console's poll: the browser version only existed if the tab happened to be
					// open, so a run finished while you were elsewhere was never recorded at all.
					const ok = reason === "done";
					await postToChat(
						`${ok ? "**Loop complete**" : `**Loop stopped** (${reason})`}${outcome.detail ? `\n\n${outcome.detail}` : ""}`,
					);
				});
			}
			if (event.payload.boardTaskId) {
				await step.do(`delegation-task-done${suffix}`, async () => {
					const ok = outcome.outcome !== "failed" && outcome.outcome !== "max_steps";
					// Same shared record shape as the route that opened the card (#155) — only the
					// status + outcome note change. Inline upsert keeps the workflow off a routes import.
					const task = delegationTaskRecord({
						id: event.payload.boardTaskId as string,
						targetLabel: goal.repo,
						objective: goal.objective,
						status: ok ? "completed" : "failed",
						now: new Date().toISOString(),
						note: `outcome: ${outcome.outcome}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
					});
					await upsertWorkCard(env, { instanceId, userId, id: event.payload.boardTaskId as string, task });
					return null;
				});
			}
		};

		if (!conn) {
			// This return is BEFORE the try/finally, so the delegation rows have to be closed
			// here explicitly. They weren't: `delegateToPilot` inserts agent_loop_runs (running)
			// and a board card (running) before creating the workflow, so a Lead delegating to a
			// Repo Coder whose machine had gone offline left both rows `running` PERMANENTLY —
			// `check_delegation` told the supervisor the run was still going and the card never
			// moved. Exactly the "looks delegated and never moves" failure the design forbids.
			const noRunner: CodingResult = { outcome: "failed", detail: "No coding runner connected. Start it with: pags up", steps: 0 };
			await closeDelegation(noRunner, "-no-runner");
			// The only exit that leaves the session ACTIVE, so it is the only one that has to free
			// the claim itself — everywhere else `endSession` does it. Miss this and one offline
			// moment locks the session out of every future run.
			if (event.payload.driverId) {
				await releaseSessionDriver(env, instanceId, userId, sessionId, event.payload.driverId);
			}
			return noRunner;
		}

		const retry = { retries: { limit: 2, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "3 minutes" as const };
		// waitIdle polls internally for minutes, so it needs a longer step budget than `retry`.
		const idleRetry = { retries: { limit: 1, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "10 minutes" as const };
		let n = 0;
		/**
		 * Read the pane AND whether the run should stop.
		 *
		 * `runCodingLoop` branches on `snap.cancelled` in two places and both workflow poll loops
		 * test it — but nothing ever SET it: `CodingSnapshot` has no such field and neither the
		 * runner nor the routes produce one. So the outcome "cancelled" was unreachable in
		 * production, and a user who started a run with the wrong objective had no way to stop it
		 * short of killing the session; the Pilot kept going for up to 12 rounds × 40 steps of
		 * BYOK Claude decisions.
		 *
		 * The signal already exists and is already user-driven: Kill / End / Restart set the
		 * `coding_sessions` row out of 'active'. Reading it here makes those buttons a clean stop
		 * — the loop finishes its current step and returns `cancelled` — instead of the run only
		 * ending indirectly when a later capture happens to fail.
		 */
		const capture = async (): Promise<CodingPaneSnapshot & { sessionId: string }> => {
			const [snap, row] = await Promise.all([
				// `drainUsage` — an autonomous Pilot run is exactly the case where no console is
				// open, so this is the only path collecting the Engine's own spend (#267) for the
				// longest and most expensive sessions the platform has.
				callRunner<CodingPaneSnapshot & { sessionId: string; usage?: unknown }>(
					conn,
					"/coding/capture",
					{ sessionId, drainUsage: true },
					{ timeoutMs: READ_TIMEOUT_MS },
				),
				env.DB.prepare("SELECT status FROM coding_sessions WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
					.bind(sessionId, instanceId, userId)
					.first<{ status: string }>()
					.catch(() => null),
			]);
			const { usage, ...pane } = snap;
			await recordEngineUsage(env, { userId, sessionId, instanceId }, sanitizeEngineUsage(usage));
			// A Pilot capturing is the session being USED (#275). The claim heartbeat already says
			// so on every action, but a single round can sit in `waitIdle` for minutes with no
			// action at all — so the invariant "anything driving the engine keeps it alive" is
			// stated here too rather than inferred from the loop's step budget. Throttled in the
			// store, so a 2-second poll writes a row once a minute.
			await touchSessionActivity(env, instanceId, userId, sessionId).catch(() => undefined);
			// ONLY a terminal status cancels. `suspended` is not one: `pags up --force` on another
			// machine suspends sessions owned by other nodes, and `resumeSessionsForNode` only
			// revives them for a MATCHING runner_node — while `reassignSessionNode` deliberately
			// leaves the status alone. So a session relocated to a live machine can legitimately
			// sit `suspended`, and treating that as cancellation would end a healthy run at step 0
			// with no explanation, replacing the relocation this workflow does a few lines above.
			// A read that FAILED (null) must not cancel either, or a D1 blip aborts a good run.
			// `pane`, not `snap`: the drained usage has been ledgered and must not be persisted into
			// the workflow's step state, where a replay would carry it around forever.
			return row && (row.status === "ended" || row.status === "error") ? { ...pane, cancelled: true } : pane;
		};

		const deps: CodingDeps = {
			snapshot: () => step.do(`s${n++}-snapshot`, retry, capture) as Promise<CodingPaneSnapshot>,
			act: (a: CodingActionKind) =>
				step.do(`s${n++}-act`, retry, () => callRunner<CodingPaneSnapshot>(conn, "/coding/act", { sessionId, action: a })) as Promise<CodingPaneSnapshot>,
			// The LLM call is the one place this loop spends money, so it is the one place the
			// budget has to sit. Delegated runs (#159) previously reached the Pilot with a pool id
			// and never drew on it — unbounded spend on exactly the path a supervisor can trigger
			// without a human watching. Wrapping `decide` keeps runCodingLoop untouched.
			decide: (p) =>
				step.do(`s${n++}-decide`, retry, async () => {
					const budgetId = event.payload.budgetId ?? null;
					if (!budgetId) return decideCodingAction(env, userId, p, { kind: "coding", instanceId });

					const draw = await reserve(env, userId, budgetId, {
						depth: event.payload.depth ?? 0,
						estimatedCostMicros: CODING_RESERVE_MICROS,
					});
					if (!draw.ok) {
						// `account_ceiling` is the ACCOUNT's rolling 24h backstop tripping, not this
						// tree's pool being spent. Closing the shared budget for it stops every
						// sibling drawing on the same pool and survives the window rolling off.
						if (draw.reason && draw.reason !== "not_found" && draw.reason !== "closed" && draw.reason !== "account_ceiling") {
							await markExhausted(env, userId, budgetId, draw.reason, event.payload.depth ?? 0).catch(() => undefined);
						}
						// A clean terminal decision rather than a throw: the loop stops with a reason
						// the human can read on the board, and the session is left intact to resume.
						return { finish: { status: "failed" as const, detail: draw.message ?? "This run hit its spend limit." } };
					}
					const before = await instanceSpendMicros(env, userId, instanceId);
					try {
						return await decideCodingAction(env, userId, p, { kind: "coding", instanceId });
					} finally {
						// Settled in `finally` so a throwing decide still charges what it burned —
						// otherwise a failing loop would run free.
						const after = await instanceSpendMicros(env, userId, instanceId);
						await settle(env, userId, budgetId, draw.reserved ?? CODING_RESERVE_MICROS, Math.max(0, after - before)).catch(() => undefined);
					}
				}) as Promise<CodingDecision>,
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
			onEvent: (type, message, data) => {
				// Incremented OUTSIDE step.do: a step that exhausts its retries re-runs its body,
				// and `++` inside would double-count every retry into the progress figure.
				// `runCodingLoop` emits exactly one "action" per step, so this counts steps.
				const at = type === "action" ? ++pilotSteps : pilotSteps;
				// Throttled: the first thought lands immediately (so a watcher sees SOMETHING right
				// away) and then every 4th. Counted outside step.do for the same retry reason as
				// pilotSteps — a re-run body would otherwise skew the cadence.
				const postProgress = type === "thought" && (++pilotThoughts === 1 || pilotThoughts % 4 === 0);
				return step.do(`s${n++}-event`, async () => {
					await callRunner(conn, "/coding/event", { sessionId, type, message, data }).catch(() => undefined);
					// The supervisor's progress signal. No extra durable step — it rides the event
					// hook the loop already calls.
					if (type === "action" && event.payload.loopRunId) {
						await recordIteration(env, event.payload.loopRunId, at).catch(() => undefined);
					}
					// Rides the same hook — no extra durable step for either write.
					if (postProgress && event.payload.boardTaskId) {
						await setWorkCardProgress(env, instanceId, userId, event.payload.boardTaskId, message);
					}
					// Only for a loop the OWNER started (or a supervisor delegated) — a session the
					// human is driving by hand already shows every keystroke in the terminal, and
					// echoing it into chat would be noise about work they are watching happen.
					if (type === "action" && event.payload.loopRunId) {
						await postToChat(`**Loop → engine** (step ${at}): ${message}`);
					}
					// Heartbeat the single-flight claim. Without it a run longer than
					// STALE_DRIVER_MS would expire its OWN claim and a second Pilot could take the
					// session out from under it — the exact collision the claim exists to prevent.
					if (type === "action" && event.payload.driverId) {
						await touchSessionDriver(env, instanceId, userId, sessionId, event.payload.driverId);
					}
					return null;
				}).then(() => undefined);
			},
		};

		let result: CodingResult = { outcome: "failed", detail: "did not start", steps: 0 };
		// Wrap the whole run so a thrown step (clone/runner/AI hiccup that exhausts its
		// retries) STILL ends the session + notifies — otherwise the D1 row sits "active"
		// forever, the runner tmux is never torn down, and the run silently vanishes.
		try {
			// Ensure the tmux session is up and the CLI launched (clones the repo if the
			// runner doesn't already have this session, e.g. after a runner restart).
			await step.do("start", { retries: { limit: 1, delay: "3 seconds" as const, backoff: "constant" as const }, timeout: "5 minutes" as const }, async () => {
				// Resolve the session's exact CLI command, its workDir, and its engine env
				// (API key / OAuth token) FRESH here — the same fields startSessionOnRunner
				// passes. Without them, a runner that must re-create the session after a restart
				// would relaunch the DEFAULT cli with NO auth (wrong binary / auth failure). Env
				// is resolved inside the step (not journaled) so the key never lands in workflow
				// state — matching how the runner token is kept out of state elsewhere.
				const [sess, repo] = await Promise.all([
					getSession(env, instanceId, userId, sessionId),
					getRepo(env, instanceId, userId, repoId),
				]);
				const engineEnv = sess ? await resolveEngineEnv(env, instanceId, userId, sess) : undefined;
				return callRunner<{ sessionId?: string }>(conn, "/coding/start", {
					sessionId, repoId,
					workDir: repo?.workdir || undefined,
					cloneUrl, branch, token,
					clientType: goal.clientType,
					command: sess?.launchCommand || undefined,
					env: engineEnv,
				});
			});
			// What state did the last run leave this checkout in? (#276)
			//
			// Delegated runs park repos wherever they stopped — one live Lead had a subordinate
			// sitting on `fix/36-assistant-bubble-order` after a run opened a PR, and another
			// holding an uncommitted fix a run had been told to leave behind. The next goal then
			// runs on that branch, over that diff, and nothing said so.
			//
			// The Pilot is TOLD, not corrected. An automatic `checkout main` / `reset --hard` would
			// destroy work that git cannot distinguish from litter, which is worse and irreversible;
			// being on an unexpected branch is visible and cheap to fix. So the run gets the fact
			// and an explicit instruction not to discard anything, and the human gets a board card
			// at the end (below) — nothing here changes the tree.
			const repoState = (await step.do("repo-state-start", async () => {
				const repo = await getRepo(env, instanceId, userId, repoId).catch(() => null);
				if (!repo) return null;
				return (await readRepoWorkingState(conn, { repo, sessionId })) ?? null;
			})) as RepoWorkingState | null;
			// `branch` is the repo's CONFIGURED branch, carried on the payload by whoever started
			// the run — so the comparison is against what this repo is supposed to be on, not
			// against a hardcoded "main".
			const stateNote = repoState ? describeRepoState(repoState, { configuredBranch: branch ?? null }) : null;
			if (stateNote) {
				goal.specialInstructions = [
					goal.specialInstructions,
					`REPOSITORY STATE (read before you start): ${stateNote} You did not create this state. Do NOT revert, stash, reset or discard anything you did not write yourself. If your objective needs a clean tree or a different branch, say so and stop rather than clearing it.`,
				]
					.filter(Boolean)
					.join("\n\n");
			}
			await step.do("tl-start", async () => {
				await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: `AI run started — objective: ${goal.objective}` });
				if (stateNote) await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: stateNote });
				return null;
			});

			for (let round = 0; round < 12; round++) {
				result = await runCodingLoop(deps, goal, { maxSteps: 40 });
				// userHint is consumed by the round above — clear it so stale handoff input
				// isn't re-injected into later rounds that don't get a fresh value.
				goal.userHint = undefined;
				if (result.outcome !== "stuck" && result.outcome !== "needs_input") break;

				const reason = result.outcome === "needs_input" ? "needs_input" : "stuck";
				const label = result.outcome === "needs_input" ? result.fieldNeeded ?? "a value" : result.detail ?? "this step";
				await step.do(`handoff-${round}`, () => callRunner<{ ok?: boolean }>(conn, "/coding/takeover", { sessionId, label, reason }));
				// Ping the user — the agent is paused waiting on them.
				await step.do(`notify-handoff-${round}`, async () => {
					await notifyUser(env, userId, "coding", "🙋 Coder needs you", `${goal.repo}: ${label}`, codingDeepLink(instanceId, repoId)).catch(() => undefined);
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
					result = { outcome: "failed", detail: `${reason} not resolved in time`, steps: result.steps, transcript: result.transcript };
					break;
				}
				if (result.outcome === "needs_input" && providedValue && result.fieldNeeded) {
					goal.userHint = `${result.fieldNeeded}: ${providedValue}`;
				}
				await step.do(`resume-${round}`, () => callRunner<{ ok?: boolean }>(conn, `/coding/takeover/${encodeURIComponent(sessionId)}/end`, {}));
			}
		} catch (e) {
			// A step exhausted its retries and threw — record it so the finally still
			// syncs the session + notifies, instead of letting the run vanish.
			result = { outcome: "failed", detail: `run error: ${e instanceof Error ? e.message : String(e)}`, steps: result.steps, transcript: result.transcript };
		} finally {
			// Uncommitted work is a PENDING HUMAN DECISION, so it goes on the board (#276).
			//
			// Before this, a run told "leave the change in the working tree" left it there and
			// nothing recorded it; every later `git status` rediscovered the same diff as a novelty,
			// 50 hours on. A stable card id per repo makes this idempotent — one card that updates,
			// and closes itself the moment a later run finds the tree clean, rather than a pile.
			//
			// Read BEFORE the session is closed below, so the runner can resolve the workdir from
			// the live session (the only way to see a managed clone dir).
			await step.do("repo-state-end", async () => {
				const repo = await getRepo(env, instanceId, userId, repoId).catch(() => null);
				if (!repo) return null;
				const state = await readRepoWorkingState(conn, { repo, sessionId }).catch(() => null);
				if (!state) return null; // Unknown ≠ clean: leave whatever card exists alone.
				const cardId = `repo-dirty-${repoId}`;
				if (!state.dirty) {
					await closeWorkCards(env, instanceId, userId, [cardId], "completed");
					return null;
				}
				const now = new Date().toISOString();
				await upsertWorkCard(env, {
					instanceId,
					userId,
					id: cardId,
					task: {
						id: cardId,
						type: "coding.uncommitted",
						status: "needs_human",
						title: `Uncommitted work in ${goal.repo}`.slice(0, 200),
						subtitle: state.branch ? `on ${state.branch}` : undefined,
						description: (describeRepoState(state, { configuredBranch: branch ?? null }) ?? "").slice(0, 300),
						createdAt: now,
						updatedAt: now,
					},
				});
				return null;
			});
			await step.do("end", async () => {
				// A run closes only the session it OPENED (#271). Ending one a human opened made
				// delegation single-use and took away a thing the user had created.
				if (shouldEndSessionAfterRun({ openedByRun: event.payload.sessionOpenedByRun === true })) {
					await callRunner<{ ok?: boolean }>(conn, "/coding/end", { sessionId }).catch(() => undefined);
					// The runner session is now gone — sync the D1 row so it doesn't sit
					// "active" forever (the row was created active by the /sessions route).
					const status = result.outcome === "failed" || result.outcome === "max_steps" ? "error" : "ended";
					// Through `endSession`, not raw SQL: it is the ONE place a session leaves `active`,
					// so it is the one place the board card can reliably follow (#206). It also covers
					// `suspended`, which the raw `status = 'active'` predicate here silently skipped —
					// a Pilot finishing after a `--force` takeover elsewhere left the row suspended
					// forever with nothing to close it.
					await endSession(env, instanceId, userId, sessionId, status);
				} else if (event.payload.driverId) {
					// The session survives, so `endSession` — which is what normally frees the
					// single-flight claim — never runs. Release it here or the repo is locked out
					// of every further run for STALE_DRIVER_MS (15 minutes), which would turn
					// "delegation is single-use" into "delegation is once every quarter hour".
					await releaseSessionDriver(env, instanceId, userId, sessionId, event.payload.driverId);
				}
				await appendTimeline(env, { sessionId, instanceId, userId, type: "outcome", content: `${result.outcome}${result.detail ? ` — ${result.detail}` : ""}` });
				return null;
			});
			// Tell the user the run is over so they can check the results + summary.
			await step.do("notify-end", async () => {
				const ok = result.outcome !== "failed" && result.outcome !== "max_steps";
				const title = ok ? "✅ Coder finished" : "⚠️ Coder stopped";
				const body = `${goal.repo}: ${result.detail || result.outcome}`;
				await notifyUser(env, userId, "coding", title, body, codingDeepLink(instanceId, repoId)).catch(() => undefined);
				return null;
			});
			// #155: close out the observable delegation task on the board (if this was a
			// delegated goal) so its status reflects the real outcome, not a stuck "running".
			// Inline upsert into instance_runtime_tasks (the board's source) — same shape as
			// mirrorRuntimeTask, kept here so the workflow doesn't import a routes module.
			// Close the loop-run row a delegation opened, so ONE surface answers "how did it go"
			// for both delegation kinds. Written here, in the same terminal step that closes the
			// board card, so the two cannot disagree.
			await closeDelegation(result);
		}
		return result;
	}

	/**
	 * Watch a manually-driven session: the user typed an instruction into the CLI
	 * (➤ Agent). Wait for the pane to settle to idle, then summarize what happened,
	 * persist it to the chat thread, and notify the user — so "the agent comes back
	 * to you" the same way the autonomous run does, even with the console closed.
	 */
	private async runWatch(event: WorkflowEvent<CodingSessionParams>, step: WorkflowStep): Promise<CodingResult> {
		const { instanceId, userId, sessionId, repoId, runnerNode, goal } = event.payload;
		const env = this.env;
		const conn = await getRunnerConn(env, instanceId, userId, runnerNode ?? null);
		if (!conn) return { outcome: "failed", detail: "No coding runner connected.", steps: 0 };

		// Wait for the just-sent instruction to run to completion (pane goes idle).
		const finalPane = (await step.do(
			"watch-idle",
			{ retries: { limit: 1, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "15 minutes" as const },
			async () => {
				const capture = () => callRunner<CodingPaneSnapshot & { sessionId: string }>(conn, "/coding/capture", { sessionId }, { timeoutMs: READ_TIMEOUT_MS });
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
			const reply = await copilotSummary(env, userId, { finished: true, memory, pane: finalPane.pane || "", instanceId }).catch(() => "");
			if (reply) await appendTimeline(env, { sessionId, instanceId, userId, type: "chat_assistant", content: reply });
			// Save the actual terminal transcript too (deduped) — the audit trail of what
			// Claude really did, not just the summary. Otherwise the manual chat flow only
			// keeps your message + the gist, and the real work isn't recorded anywhere.
			const pane = (finalPane.pane || "").trim();
			if (pane) {
				const prev = await lastTerminal(env, sessionId).catch(() => null);
				if (pane !== (prev ?? "").trim()) {
					await appendTimeline(env, { sessionId, instanceId, userId, type: "terminal", content: pane.slice(-12000) }).catch(() => undefined);
				}
			}
			await notifyUser(
				env,
				userId,
				"coding",
				"✅ Coder finished",
				`${goal.repo}: ${reply ? reply.slice(0, 140) : "done — open to see what it did"}`,
				codingDeepLink(instanceId, repoId),
			).catch(() => undefined);
			return null;
		});
		return { outcome: "done", detail: "watched to idle", steps: 0 };
	}
}

/**
 * Deep-link a notification straight to the repo's Agent chat (the summary view
 * that holds the message which triggered it), not the generic Coding tab — so a
 * push tap lands exactly on the conversation it's about.
 */
function codingDeepLink(instanceId: string, repoId?: string): string {
	return repoId
		? `/console/instances/${instanceId}/coding/repos/${repoId}/summary`
		: `/console/instances/${instanceId}/coding`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
