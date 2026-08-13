import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
	decideCodingAction,
	runCodingLoop,
	type CodingActionKind,
	type CodingDecision,
	type CodingDeps,
	type CodingPaneSnapshot,
	type CodingResult,
} from "../lib/coding-loop.js";
import { callRunner, getRunnerConnIgnoringLiveness, getBoundRunnerConn, relayConnected, READ_TIMEOUT_MS, type RunnerConn } from "../lib/runner-client.js";
import { runtimeConnectivity } from "../lib/instance-connectivity.js";
import { runWatchSession } from "./coding-watch.js";
import type { CodingSessionParams } from "./coding-session-params.js";
import { makeRunnerGuard, noRunnerDetail, RUNNER_PROBE_INTERVAL, type RunStep } from "../lib/runner-availability.js";
import { endSession, getSession, getRepo, reassignSessionNode, releaseSessionDriver, touchSessionActivity, touchSessionDriver } from "../lib/coding-store.js";
import { pilotStopSignal, shouldEndSessionAfterRun } from "../lib/coding-session-lifecycle.js";
import { resolvePause, runSucceeded, stopReasonFor, type PauseDeps } from "../lib/coding-pause.js";
import { accountTimeZone } from "../lib/account-timezone.js";
import type { EngineWaitState } from "../lib/coding-wait.js";
import { describeRepoState, readRepoWorkingState, type RepoWorkingState } from "../lib/repo-state.js";
import { enforceRepoPolicies } from "../lib/repo-policy-act.js";
import { setWorkCardProgress, upsertWorkCard } from "../lib/work-card.js";
import { normalizeRunnerNode } from "../lib/runtime-nodes.js";
import { resolveEngineEnv } from "../lib/coding-engines.js";
import { appendTimeline } from "../lib/coding-timeline.js";
import { delegationTaskRecord } from "../lib/delegation.js";
import { codingSessionLink } from "../lib/console-links.js";
import { notifyUser } from "../routes/push.js";
import { recordEngineUsage } from "../lib/usage.js";
import { decideWithinBudget } from "../lib/coding-decide-budget.js";
import type { EngineAuthResolved } from "../lib/usage-payer.js";
import { sanitizeEngineUsage } from "../lib/engine-usage.js";
import { recordEngineActs, sanitizeEngineActs, summarizeActs } from "../lib/engine-acts.js";
import {
	describeAuthority,
	describeViolation,
	readMergePolicyForRun,
	recordAuthorityViolations,
	unauthorizedActs,
	type MergePolicy,
} from "../lib/coding-authority.js";
import { actsInWindow } from "../lib/instance-work.js";
import { annotateOwnerAttribution } from "../lib/run-attribution.js";
import { finishLoopRun, isCancelRequested, recordIteration } from "../lib/agent-loop-store.js";
import { codingCrashReport, runOutcomeNote } from "../lib/coding-run-report.js";
import type { LoopStopReason } from "../lib/agent-loop.js";
import { CodingRunProbe, recordCodingFailure } from "../lib/coding-failure.js";
import { postSystemMessage } from "../lib/instance-system-message.js";
import type { Env } from "../types.js";

export type { CodingSessionParams } from "./coding-session-params.js";

/**
 * The coding orchestrator's remote brain: a durable Cloudflare Workflow that
 * drives the user's local coding CLI (a child process, not tmux) toward an objective — read the
 * pane, ask Claude (BYOK) for the next instruction, send it, wait for idle,
 * repeat. On a stuck/needs-input it hands off to the human via the same console
 * takeover, polls until resolved, then resumes. Durable steps → survives the 30s
 * request limit, same machinery as {@link JobApplyWorkflow} for the browser.
 */
export class CodingSessionWorkflow extends WorkflowEntrypoint<Env, CodingSessionParams> {
	async run(event: WorkflowEvent<CodingSessionParams>, step: WorkflowStep): Promise<CodingResult> {
		if (event.payload.mode === "watch") return runWatchSession(this.env, event, step);
		const { instanceId, userId, sessionId, repoId, runnerNode, cloneUrl, branch, token, tokenUsername, goal } = event.payload;
		const env = this.env;
		/**
		 * When this run began — the lower bound of the window its acts are read back from (#294).
		 *
		 * JOURNALLED in a step, not a bare `Date.now()`. Everything outside `step.do` re-runs on
		 * every workflow replay, so a plain assignment would creep forward each time and the close
		 * would then read a window that starts AFTER the acts it is meant to report — losing exactly
		 * the record for the long, resumed runs most likely to have merged something.
		 */
		const runStartedAt = (await step.do("run-started-at", async () => Date.now())) as number;

		/**
		 * May this run put code on the trunk? (#314)
		 *
		 * Resolved ONCE, here, rather than at each of the three route call sites that build a
		 * `CodingGoal` — the Pilot is the only thing that drives the Engine autonomously, so a single
		 * resolution point cannot drift and no caller can forget to pass it. Journalled for the same
		 * reason `runStartedAt` is: a gate that means different things at different moments of one
		 * run is not a gate. `merge` — today's behaviour — is what an unconfigured repo resolves to.
		 */
		const mergePolicy = (await step.do("merge-authority", () => readMergePolicyForRun(env, { instanceId, userId, repoId }))) as MergePolicy;
		goal.mergePolicy = mergePolicy;
		// The Pilot must convert "resets at 10:30pm" into an absolute instant, and "10:30pm" is 10:30pm
		// SOMEWHERE (#541). Resolved once, like mergePolicy; unset stays unset and renders as UTC.
		goal.timeZone = ((await step.do("owner-timezone", async () => (await accountTimeZone(env, userId)) ?? null)) as string | null) ?? undefined;
		// What the owner is told about this run's authority — including, on an engine that reports no
		// acts, that its commands could not be checked. Null under the default policy, so an
		// unconfigured run claims no protection it does not have.
		const authorityNote = describeAuthority(mergePolicy, goal.clientType);

		let startConn = await getRunnerConnIgnoringLiveness(env, instanceId, userId, runnerNode ?? null);
		// Machine-switch reclaim (matches the interactive /message path). A durable /run can be
		// queued/resumed long after it was created, by which point the session's owning machine
		// may be offline while the user is running `pags up` elsewhere. The loader is the DELIBERATE
		// resolve (#532): this is the code that ACTS on a dead stamped node, so it must be able to
		// see one, and it asks the relay itself below rather than twice. Not live → relocate the
		// session to whatever machine the agent runs on now (live + pin-aware) instead of failing.
		const live = await relayConnected(env, instanceId, runnerNode ?? null).catch(() => false);
		if (!live) {
			const fallback = await getBoundRunnerConn(env, instanceId, userId);
			if (fallback && normalizeRunnerNode(fallback.runnerNode) !== normalizeRunnerNode(runnerNode)) {
				await reassignSessionNode(env, instanceId, userId, sessionId, fallback.runnerNode ?? null).catch(() => undefined);
				startConn = fallback;
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
		 * Times the HUMAN actually intervened in this run (#505): a resolved takeover, a value
		 * supplied to a needs-input handoff. Nothing else counts — see lib/run-attribution.ts for
		 * why the objective and the Pilot's own instructions do not, and what is done with this.
		 */
		let ownerTurns = 0;

		const probe = new CodingRunProbe(); // Where this run was, and how big its payload, if it dies (#529).
		/**
		 * The reason a PLATFORM interruption is reported under, overriding the outcome's own (#546).
		 *
		 * A `let` in the run's scope rather than a field on `CodingResult`: the outcome is what the
		 * loop reported about the objective, and an interruption is a statement about the invocation.
		 * Folding them would let a future edit "improve" the outcome and silently change the reason.
		 */
		let crashReason: LoopStopReason | null = null;

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
		 * and the thread simply never mentioned it. The thread is a RECORD, never the work, so the
		 * swallow lives here rather than inside the shared `postSystemMessage`.
		 */
		const postToChat = (content: string) => postSystemMessage(env, instanceId, content).catch(() => undefined);

		/**
		 * Close the rows a DELEGATED run opened — the loop-run row `check_delegation` reads and the
		 * board card the supervisor watches. One writer for both, so they cannot disagree.
		 *
		 * `suffix` distinguishes the step names on the two call paths; a Workflow step name must be
		 * unique within an instance.
		 */
		const closeDelegation = async (outcome: CodingResult, suffix = "") => {
			// What did this run actually DO? (#294)
			//
			// The trace holds every act, but a supervisor's default read is `check_delegation` and
			// the board card — and the issue's acceptance is that a merge be visible there, without
			// opening the repo. Folded into the SAME strings both surfaces already carry, so nothing
			// new has to be taught to read it.
			//
			// Read by time window rather than by trace id: a console terminal poll can drain a run's
			// acts before the Pilot does, and stamps the session id when it does — see
			// `actsInWindow`.
			const acts = event.payload.loopRunId || event.payload.boardTaskId
				? await actsInWindow(env, userId, instanceId, runStartedAt, Date.now()).catch(() => [])
				: [];
			const actLine = summarizeActs(acts);
			// #505: the report is the Pilot's own account of the run, and it reaches the owner
			// unmodified. When it says the human decided something and the platform knows the human
			// said nothing, that fact is stamped on. Annotated, never rewritten — the owner has to
			// see the claim in order to distrust it. The composition around it is `runOutcomeNote`.
			const detail = annotateOwnerAttribution(outcome.detail ?? "", ownerTurns);
			const note = runOutcomeNote({
				outcome: outcome.outcome,
				detail,
				breach: unauthorizedActs(mergePolicy, acts).map((a) => describeViolation(mergePolicy, a)).join(" "),
				authorityNote,
				actLine,
			});
			if (event.payload.loopRunId) {
				await step.do(`delegation-run-done${suffix}`, async () => {
					// A pure table (#541) — `stopReasonFor`. The chain this replaces mapped every
					// non-failed, non-cancelled, non-max_steps outcome to `done`, which was true only
					// while `stuck` could never survive to here. `crashReason` overrides it for the
					// deaths that are not the objective failing at all (#546) — see `coding-run-report`.
					const reason = crashReason ?? stopReasonFor(outcome.outcome);
					// The Pilot drives its own loop and never called `recordIteration`, so
					// `check_delegation` reported "iteration: 0 of 10" for a run that took a dozen
					// steps — the supervisor's only progress signal, permanently reading zero.
					// Recorded at the terminal state, which is when the real count is known.
					// max(): `outcome.steps` is only the last round's count (see pilotSteps above).
					await recordIteration(env, event.payload.loopRunId as string, Math.max(pilotSteps, outcome.steps ?? 0)).catch(() => undefined);
					// NOT best-effort. `finishLoopRun` is the only terminal write to `agent_loop_runs`,
					// so swallowing it left the row `running` forever — `check_delegation` then told
					// the supervisor the subordinate was still working, which is the "looks delegated
					// and never moves" failure this file's own comment forbids — while the next line
					// posted "**Loop complete**" into the chat. Let the durable step retry, and never
					// announce a completion that was not recorded.
					await finishLoopRun(env, event.payload.loopRunId as string, reason, note, Date.now());
					// The result, in the thread the loop was started from. Written HERE rather than by
					// the console's poll: the browser version only existed if the tab happened to be
					// open, so a run finished while you were elsewhere was never recorded at all.
					const ok = reason === "done";
					await postToChat(
						`${ok ? "**Loop complete**" : `**Loop stopped** (${reason})`}${detail ? `\n\n${detail}` : ""}${actLine ? `\n\n${actLine}` : ""}`,
					);
				});
			}
			if (event.payload.boardTaskId) {
				await step.do(`delegation-task-done${suffix}`, async () => {
					const ok = runSucceeded(outcome.outcome);
					// Same shared record shape as the route that opened the card (#155) — only the
					// status + outcome note change. Inline upsert keeps the workflow off a routes import.
					const task = delegationTaskRecord({
						id: event.payload.boardTaskId as string,
						targetLabel: goal.repo,
						objective: goal.objective,
						status: ok ? "completed" : "failed",
						now: new Date().toISOString(),
						note,
					});
					await upsertWorkCard(env, { instanceId, userId, id: event.payload.boardTaskId as string, task });
					return null;
				});
			}
		};

		if (!startConn) {
			// This return is BEFORE the try/finally, so the delegation rows have to be closed
			// here explicitly. They weren't: `delegateToPilot` inserts agent_loop_runs (running)
			// and a board card (running) before creating the workflow, so a Lead delegating to a
			// Repo Coder whose machine had gone offline left both rows `running` PERMANENTLY —
			// `check_delegation` told the supervisor the run was still going and the card never
			// moved. Exactly the "looks delegated and never moves" failure the design forbids.
			// The remedy is DIAGNOSED, not assumed (#341). "Start it with: pags up" is wrong for the
			// case the console needed its own state for — machine online, this agent detached, answer
			// `pags up --force` — and being told to run a command already running is what teaches
			// people to stop reading these messages.
			const detail = noRunnerDetail(await runtimeConnectivity(env, instanceId, userId).catch(() => null));
			const noRunner: CodingResult = { outcome: "failed", detail, steps: 0 };
			await closeDelegation(noRunner, "-no-runner");
			// The only exit that leaves the session ACTIVE, so it is the only one that has to free
			// the claim itself — everywhere else `endSession` does it. Miss this and one offline
			// moment locks the session out of every future run.
			if (event.payload.driverId) {
				await releaseSessionDriver(env, instanceId, userId, sessionId, event.payload.driverId);
			}
			return noRunner;
		}

		// The machine this run is talking to. A `let`, because the runner guard below re-points it
		// when a disconnect heals on a DIFFERENT machine. Re-declared rather than narrowed: a
		// closure that ASSIGNS to a variable discards its narrowing at every other call site.
		let conn: RunnerConn = startConn;

		const retry = { retries: { limit: 2, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "3 minutes" as const };
		// waitIdle polls internally for minutes, so it needs a longer step budget than `retry`.
		const idleRetry = { retries: { limit: 1, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "10 minutes" as const };
		const startRetry = { retries: { limit: 1, delay: "3 seconds" as const, backoff: "constant" as const }, timeout: "5 minutes" as const };
		/**
		 * `step.do` with its options pre-bound, as a plain callable the runner guard can drive.
		 *
		 * The cast is over Cloudflare's `Rpc.Serializable` constraint, which a generic wrapper cannot
		 * carry through — the same reason every `step.do` result below already casts.
		 */
		type LooseDo = (name: string, opts: unknown, cb: () => Promise<unknown>) => Promise<unknown>;
		const runWith = (opts: unknown): RunStep => (name, fn) => (step.do as unknown as LooseDo)(probe.at(name), opts, fn);
		const runRetry = runWith(retry);
		const runIdle = runWith(idleRetry);
		let n = 0;

		/**
		 * Make sure the session exists on whatever machine we are talking to.
		 *
		 * Hoisted out of the "start" step because a RECONNECT needs the same thing: a runner that
		 * dropped may have restarted, or the agent may be live on a different machine, and either way
		 * the engine must be (re)launched before the loop can carry on. `/coding/start` is idempotent.
		 */
		const startOnRunner = async () => {
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
				cloneUrl, branch, token, tokenUsername,
				clientType: goal.clientType,
				command: sess?.launchCommand || undefined,
				env: engineEnv,
			});
		};

		/**
		 * A DISCONNECT IS A PAUSE, NOT AN ENDING (#341).
		 *
		 * Heartfull's run died at iteration 2 of 50 because a ~4s step-retry budget expired while the
		 * runner was still inside its own 30s-capped reconnect backoff. A bigger number with the same
		 * terminal behaviour only moves the cliff; what a run with 48 iterations left has is TIME. So
		 * the guard waits for the relay, says so in the thread (#252), re-points at whichever machine
		 * is live now, relaunches the engine, and resumes at the same step. Bounded per loss AND per
		 * run — see lib/runner-availability.ts for the sizing and the whole argument.
		 */
		const guard = makeRunnerGuard({
			wait: {
				probe: () => runtimeConnectivity(env, instanceId, userId),
				// step.sleep, so a ten-minute pause survives the workflow being evicted.
				sleep: (label) => step.sleep(label, RUNNER_PROBE_INTERVAL),
				announce: postToChat,
				// The run still owns this session while it waits. Without the heartbeat a long pause
				// would let its OWN single-flight claim go stale and a second Pilot could take the
				// session out from under it — the collision the claim exists to prevent.
				tick: async () => {
					if (event.payload.driverId) await touchSessionDriver(env, instanceId, userId, sessionId, event.payload.driverId).catch(() => undefined);
					await touchSessionActivity(env, instanceId, userId, sessionId).catch(() => undefined);
				},
			},
			reconnect: async (label) => {
				// The machine that comes back may not be the machine that went away — a user closing
				// one laptop and opening another is the ordinary case. Re-resolve live (pin-aware),
				// relocate the session's owning node, then relaunch the engine there.
				const back = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
				if (back) {
					if (normalizeRunnerNode(back.runnerNode) !== normalizeRunnerNode(conn.runnerNode)) {
						await reassignSessionNode(env, instanceId, userId, sessionId, back.runnerNode ?? null).catch(() => undefined);
					}
					conn = back;
				}
				await runWith(startRetry)(`restart-${label}`, startOnRunner);
			},
		});
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
		 *
		 * The SECOND signal is the loop run's own cancel flag (#374). `POST /loop/:runId/cancel`
		 * has always written it and `AgentLoopWorkflow` has always read it; this workflow did not,
		 * which was survivable only while the Coding tab's Loop ran in the browser and Stop meant
		 * "stop scheduling the next setTimeout". Now that Stop reaches the Pilot, it has to be read
		 * here or the button would be recorded and ignored. Which of the two wins, and what is
		 * deliberately NOT a stop, is `pilotStopSignal`.
		 */
		const capture = async (): Promise<CodingPaneSnapshot & { sessionId: string }> => {
			const [snap, row, cancelRequested] = await Promise.all([
				// `drainUsage` — an autonomous Pilot run is exactly the case where no console is
				// open, so this is the only path collecting the Engine's own spend (#267) for the
				// longest and most expensive sessions the platform has.
				callRunner<CodingPaneSnapshot & { sessionId: string; usage?: unknown; acts?: unknown }>(
					conn,
					"/coding/capture",
					{ sessionId, drainUsage: true },
					{ timeoutMs: READ_TIMEOUT_MS },
				),
				env.DB.prepare("SELECT status FROM coding_sessions WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
					.bind(sessionId, instanceId, userId)
					.first<{ status: string }>()
					.catch(() => null),
				// Degrades to "not cancelled" on a read failure, for the same reason an unreadable
				// session status does: a D1 blip must not abort a run that is working.
				event.payload.loopRunId
					? isCancelRequested(env, event.payload.loopRunId).catch(() => false)
					: Promise.resolve(false),
			]);
			const { usage, acts, ...pane } = snap;
			// The SAME snapshot carries how the engine authenticated (runtime.ts sets it on every
			// capture), so the payer is in hand here exactly as it is on the route drain. Dropping
			// it made the Pilot-driven sessions — the longest and most expensive the platform runs —
			// the only ones recording an unknown payer (#356).
			await recordEngineUsage(
				env,
				{ userId, sessionId, instanceId, authResolved: (snap as { authResolved?: EngineAuthResolved | null }).authResolved ?? null },
				sanitizeEngineUsage(usage),
			);
			const reported = sanitizeEngineActs(acts);
			// What this run actually DID (#294). Stamped with the loop-run id when there is one, so
			// `/trace?trace_id=<runId>` reconstructs exactly what a delegation did — the record whose
			// absence let run 73ffc073 merge its own PRs to `main` and report only "done".
			await recordEngineActs(
				env,
				{ userId, sessionId, instanceId, traceId: event.payload.loopRunId ?? null },
				reported,
			).catch(() => undefined);
			// MERGE AUTHORITY, the enforcing half (#314). The instruction screen keeps the Pilot from
			// ASKING for a merge; this catches one that happened anyway — the Engine's own initiative,
			// or an engine that ignored the prompt. Protocol fact, not prose: the act came from a
			// `tool_use` event carrying the literal command. The run HALTS on a hit, which is the whole
			// difference from #294: 73ffc073 merged three times because nothing stopped it after the
			// first. It cannot undo that first merge — it bounds the blast radius and asks the owner.
			const stopReason = await recordAuthorityViolations(
				env,
				{ userId, instanceId, sessionId, repoLabel: goal.repo, traceId: event.payload.loopRunId ?? null },
				mergePolicy,
				reported,
			).catch(() => null);
			if (stopReason) return { ...pane, cancelled: true, stopReason };
			// A Pilot capturing is the session being USED (#275). The claim heartbeat already says
			// so on every action, but a single round can sit in `waitIdle` for minutes with no
			// action at all — so the invariant "anything driving the engine keeps it alive" is
			// stated here too rather than inferred from the loop's step budget. Throttled in the
			// store, so a 2-second poll writes a row once a minute.
			await touchSessionActivity(env, instanceId, userId, sessionId).catch(() => undefined);
			// Which signals stop a run, which deliberately do not (`suspended`, an unreadable
			// status), and which reason the human is given when both fire — all of it is the pure
			// `pilotStopSignal`, so it can be stated as a table rather than as a comment defending
			// an inline ternary nothing could execute.
			//
			// `pane`, not `snap`: the drained usage AND acts have been persisted and must not be
			// carried into the workflow's step state, where a replay would drag them around forever.
			const stop = pilotStopSignal({ sessionStatus: row?.status, cancelRequested });
			return stop.stop ? { ...pane, cancelled: true, stopReason: stop.reason } : pane;
		};

		/**
		 * Measure the pane on the way OUT of the durable step (#546).
		 *
		 * `probe.saw` used to sit inside `capture`, i.e. inside the step callback — which a replay
		 * never runs, so a resumed attempt filed `paneChars: 0` and read as "it died on an empty
		 * pane". Here it sees the JOURNALLED result, which a replay does return, so the size is
		 * re-measured on every attempt exactly as {@link CodingRunProbe}'s docblock promises.
		 */
		const measured = async (p: Promise<unknown>): Promise<CodingPaneSnapshot> => {
			const pane = (await p) as CodingPaneSnapshot;
			probe.saw(pane?.pane);
			return pane;
		};

		const deps: CodingDeps = {
			snapshot: () => measured(guard(runRetry, `s${n++}-snapshot`, capture)),
			act: (a: CodingActionKind) =>
				measured(guard(runRetry, `s${n++}-act`, () => callRunner<CodingPaneSnapshot>(conn, "/coding/act", { sessionId, action: a }))),
			// The spend gate lives in `coding-decide-budget.ts` — the LLM call is the only place this
			// loop spends money, so it is the only place a budget has to sit (#159).
			decide: (p) =>
				step.do(probe.at(`s${n++}-decide`), retry, () =>
					decideWithinBudget(env, { userId, instanceId, budgetId: event.payload.budgetId, depth: event.payload.depth }, () =>
						decideCodingAction(env, userId, p, { kind: "coding", instanceId }),
					),
				) as Promise<CodingDecision>,
			// Poll capture until the CLI goes idle (the pane stops "thinking"/"responding").
			// Bounded so the loop can't outrun idleRetry's 10-minute step timeout.
			waitIdle: () =>
				measured(guard(runIdle, `s${n++}-waitidle`, async () => {
					// Settle first: a just-sent instruction may not have flipped the pane
					// to "thinking" yet, so an immediate capture could read a stale idle.
					await sleep(1500);
					let snap = await capture();
					for (let poll = 0; poll < 240 && snap.runState !== "idle" && snap.alive && !snap.cancelled; poll++) {
						await sleep(2000);
						snap = await capture();
					}
					return snap;
				})),
			onEvent: (type, message, data) => {
				// Incremented OUTSIDE step.do: a step that exhausts its retries re-runs its body,
				// and `++` inside would double-count every retry into the progress figure.
				// `runCodingLoop` emits exactly one "action" per step, so this counts steps.
				const at = type === "action" ? ++pilotSteps : pilotSteps;
				// Which instruction was driven — read here, OUTSIDE the step, for the probe's replay
				// property (#546) and because the step body below needs the same value anyway.
				const driven = type === "action" && (data as CodingActionKind | undefined)?.kind === "message" ? (data as { text: string }).text : "";
				probe.drove(driven);
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
					// A refused instruction is ANNOUNCED. "Silently refusing" is one of the two failure
					// modes #314 names, and it is the one a compliant agent would otherwise produce:
					// the brain adapts after one refusal and the owner never learns a merge is waiting
					// on them. Ungated by loopRunId — it is a policy decision, however the run started.
					if (type === "refused") await postToChat(`**Merge authority** — instruction not sent to the engine: ${message}`);
				// Same rule for the other two reasons the loop talks to itself about an instruction: it
				// was withheld for being empty (#504), or it is a repeat (#522). Without this the fix
				// is invisible where the defect was visible — the owner watched one instruction go out
				// nine times and read a success report eleven minutes later.
				if (type === "empty" || type === "repeated") await postToChat(`**Loop** — ${message}`);
					// Only for a loop the OWNER started (or a supervisor delegated) — a session the
					// human is driving by hand already shows every keystroke in the terminal, and
					// echoing it into chat would be noise about work they are watching happen.
					if (type === "action" && event.payload.loopRunId) {
						await postToChat(`**Loop → engine** (step ${at}): ${message}`);
					}
					// …and in the SESSION's own transcript, as a `command` row (#374).
					//
					// Not a duplicate of the line above: that one is the Assistant thread, this one
					// is `coding_timeline`, which is what the Co-pilot thread renders and what the
					// repo history (#257) keeps forever. Until the Coding tab's Loop moved onto the
					// Pilot, every instruction it sent went through the `/message` route and landed
					// here; driving the engine directly would have made the repo's own record of an
					// autonomous run silently empty. Ungated by `loopRunId` for the same reason the
					// refusal above is: it records what was driven, not who asked.
					if (driven) await appendTimeline(env, { sessionId, instanceId, userId, type: "command", content: driven }).catch(() => undefined);
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

		/** This RUN's wait budget, held across rounds — a park is a property of the run, not a round. */
		const waitState: EngineWaitState = { waits: 0, spentMs: 0 };
		/** The pause machine's effects (#541). `conn` is read at call time: the guard re-points it. */
		const pauseDeps = (round: number): PauseDeps => ({
			repo: goal.repo,
			timeZone: goal.timeZone,
			now: () => Date.now(),
			takeover: (label, reason) => runRetry(`handoff-${round}`, () => callRunner(conn, "/coding/takeover", { sessionId, label, reason })).then(() => undefined),
			takeoverStatus: () =>
				runRetry(`hstatus-${round}-${n++}`, () => callRunner(conn, "/coding/takeover-status", { sessionId })) as Promise<{ resolved: boolean; value?: string }>,
			endTakeover: () => runRetry(`resume-${round}`, () => callRunner(conn, `/coding/takeover/${encodeURIComponent(sessionId)}/end`, {})).then(() => undefined),
			sleep: (label, ms) => step.sleep(label, ms),
			notify: (title, body, key, alert) =>
				runRetry(`notify-${key}-${round}`, async () => {
					const opts = { key: `${key}:${sessionId}`, kind: alert ? ("alert" as const) : undefined };
					return await notifyUser(env, userId, "coding", title, body, codingSessionLink(instanceId, sessionId), opts).then(() => null, () => null);
				}).then(() => undefined),
			announce: postToChat,
			// Outside `step.do`, like the runner guard's own tick: idempotent writes whose only job is to be
			// recent. `recordIteration` writes `last_progress_at`, without which `sweepStaleRuns` closes a
			// parked run as dead at 3h.
			tick: async () => {
				const { driverId, loopRunId } = event.payload;
				if (driverId) await touchSessionDriver(env, instanceId, userId, sessionId, driverId).catch(() => undefined);
				await touchSessionActivity(env, instanceId, userId, sessionId).catch(() => undefined);
				if (!loopRunId) return true;
				await recordIteration(env, loopRunId, pilotSteps).catch(() => undefined);
				return !(await isCancelRequested(env, loopRunId).catch(() => false));
			},
		});

		let result: CodingResult = { outcome: "failed", detail: "did not start", steps: 0 };
		// Wrap the whole run so a thrown step (clone/runner/AI hiccup that exhausts its
		// retries) STILL ends the session + notifies — otherwise the D1 row sits "active"
		// forever, the runner tmux is never torn down, and the run silently vanishes.
		try {
			// Ensure the session is up and the CLI launched (clones the repo if the runner doesn't
			// already have this session, e.g. after a runner restart). Guarded like every other
			// runner call: a run queued while the machine was rebooting used to die here too.
			await guard(runWith(startRetry), "start", startOnRunner);
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
				// State the authority up front, in the record the owner reads back. Only when one is
				// actually in force — a line saying "may merge" on every run would be noise, and worse,
				// would read as a decision somebody made.
				if (authorityNote) await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: authorityNote });
				return null;
			});

			for (let round = 0; round < 12; round++) {
				// The caller's cap when it named one, the historical 40 when it did not (#374).
				result = await runCodingLoop(deps, goal, { maxSteps: event.payload.maxSteps ?? 40 });
				// Both are consumed by the round above — cleared so a stale handoff value or a stale platform note isn't re-injected into a later round.
				goal.userHint = undefined;
				goal.resumeNote = undefined;
				// WHICH pause this is, how long it may last and what the owner is told: `lib/coding-pause.ts`.
				// "How long may a run wait, and for what" is a rule, and a rule inside a Workflow can only be
				// tested by running one (#541).
				const pause = await resolvePause(pauseDeps(round), { round, result, state: waitState });
				if (!pause.resume) {
					result = pause.result;
					break;
				}
				// The human answered the handoff — this run has an owner turn in it, so a report that
				// says "the user chose" may well be true and is left alone (#505).
				if (pause.ownerTurn) ownerTurns++;
				goal.userHint = pause.userHint;
				goal.resumeNote = pause.resumeNote;
			}
		} catch (e) {
			// A step exhausted its retries and threw — record it so the finally still
			// syncs the session + notifies, instead of letting the run vanish.
			//
			// WHAT the owner is told, and under which reason, is `coding-run-report.ts`: a waited-out
			// runner reads as itself (#341), a platform interruption reads as an interruption and gets
			// its own stop reason (#546), and only a genuine crash keeps the "run error:" prefix.
			const crash = codingCrashReport(e);
			crashReason = crash.stopReason;
			result = { outcome: "failed", detail: crash.detail, steps: result.steps, transcript: result.transcript };
			// …and it is RECORDED (#529). Every peer workflow logs its own crash; this one logged
			// nothing, so three runs that died on one instruction existed only as chat bubbles, and
			// nobody could say whether that was a provider stall or an exhausted balance. The class,
			// the step it died at and the payload sizes are what the next occurrence is read from.
			await recordCodingFailure(env, {
				err: e, userId, instanceId, sessionId, probe, steps: pilotSteps, startedAt: runStartedAt, repo: goal.repo,
				node: conn.runnerNode ?? null, runId: event.payload.loopRunId ?? null, taskId: event.payload.boardTaskId ?? null,
			}).catch(() => undefined);
		} finally {
			// The repo's STANDING POLICIES are evaluated here (#322), because this is where its
			// state is already read — the moment it actually changed, and the only moment a live
			// runner is guaranteed. No scheduler was added: a policy that misses this evaluation
			// re-observes at the next run end and never replays a stale one.
			//
			// Uncommitted work is a PENDING HUMAN DECISION, so it goes on the board (#276). Before
			// that, a run told "leave the change in the working tree" left it there and nothing
			// recorded it; every later `git status` rediscovered the same diff as a novelty, 50
			// hours on. What #322 adds is that the invariant is DECLARED by the repo rather than
			// assumed by this function, and that the card says which policy raised it — the stable
			// card ids are unchanged, so cards already open in production still close.
			//
			// A policy the OWNER promoted to `act` is also restored here, by a fixed argv on the
			// runner — never by handing the Engine a goal, which would close the vocabulary at the
			// name of the policy and leave it open at the hands. One verb exists (switch a CLEAN
			// checkout back to its declared branch); the card says what was done and how to undo it,
			// and nothing here can commit, push or discard. `lib/repo-policy-act.ts`.
			//
			// Read BEFORE the session is closed below, so the runner can resolve the workdir from
			// the live session (the only way to see a managed clone dir).
			await step.do("repo-state-end", async () => {
				await enforceRepoPolicies(env, { conn, instanceId, userId, repoId, repoLabel: goal.repo, sessionId });
				return null;
			});
			// The CLOSING drain (#294), before anything can tear the session down.
			//
			// A coding run routinely ends with the consequential act — it pushes, opens the PR,
			// merges, and finishes — and since #271 a delegated run usually leaves its session LIVE,
			// so `/coding/end` is not reached and there is no later drain at all. Without this the
			// record would miss the merge on precisely the runs that end by merging.
			//
			// Unconditional rather than in the `else` branch: for a session that IS ended below, the
			// subsequent `/coding/end` drain then simply returns nothing, which is free.
			await step.do("acts-final-drain", async () => {
				const snap = await callRunner<{ usage?: unknown; acts?: unknown }>(
					conn,
					"/coding/capture",
					{ sessionId, drainUsage: true },
					{ timeoutMs: READ_TIMEOUT_MS },
				).catch(() => null);
				if (!snap) return null;
				// Usage is drained by the same flag, so it has to be banked here too or this call
				// would silently discard the closing turn's spend to record its acts (#267).
				await recordEngineUsage(
					env,
					{ userId, sessionId, instanceId, authResolved: (snap as { authResolved?: EngineAuthResolved | null }).authResolved ?? null },
					sanitizeEngineUsage(snap.usage),
				).catch(() => undefined);
				const closing = sanitizeEngineActs(snap.acts);
				await recordEngineActs(env, { userId, sessionId, instanceId, traceId: event.payload.loopRunId ?? null }, closing).catch(() => undefined);
				// A coding run routinely ends WITH the merge, so this drain is where the incident's own
				// shape lands. Nothing is left to halt, but the breach still has to be recorded (#314).
				await recordAuthorityViolations(
					env,
					{ userId, instanceId, sessionId, repoLabel: goal.repo, traceId: event.payload.loopRunId ?? null },
					mergePolicy,
					closing,
				).catch(() => null);
				return null;
			});
			await step.do("end", async () => {
				// A run closes only the session it OPENED (#271). Ending one a human opened made
				// delegation single-use and took away a thing the user had created.
				if (shouldEndSessionAfterRun({ openedByRun: event.payload.sessionOpenedByRun === true })) {
					const ended = await callRunner<{ ok?: boolean; acts?: unknown }>(conn, "/coding/end", { sessionId }).catch(() => null);
					// Whatever the final drain above could not reach — a turn that completed between
					// the two calls. Cheap, and idempotent on the deterministic row id.
					await recordEngineActs(
						env,
						{ userId, sessionId, instanceId, traceId: event.payload.loopRunId ?? null },
						sanitizeEngineActs(ended?.acts),
					).catch(() => undefined);
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
				const ok = runSucceeded(result.outcome);
				const title = ok ? "✅ Coder finished" : "⚠️ Coder stopped";
				const body = `${goal.repo}: ${result.detail || result.outcome}`;
				// A session ends once. `update` — nothing is waiting on the user, so this is what a
				// "Coder" mute is for.
				await notifyUser(env, userId, "coding", title, body, codingSessionLink(instanceId, sessionId), {
					key: `coding-end:${sessionId}`,
				}).catch(() => undefined);
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
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
