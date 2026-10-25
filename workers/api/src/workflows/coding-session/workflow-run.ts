import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
	runCodingLoop,
	type CodingActionKind,
	type CodingDeps,
	type CodingPaneSnapshot,
	type CodingResult,
	type TurnCarry,
} from "../../lib/coding-loop.js";
import { callRunner, getRunnerConnIgnoringLiveness, getBoundRunnerConn, relayConnected, READ_TIMEOUT_MS, type RunnerConn } from "../../lib/runner-client.js";
import { runtimeConnectivity } from "../../lib/instance-connectivity.js";
import type { CodingSessionParams } from "../coding-session-params.js";
import { noRunnerDetail, } from "../../lib/runner-availability.js";
import { DECIDE_RETRY, START_RETRY, stepRunners } from "./step-retry-presets.js";
import { makeCodingRunnerGuard } from "./runner-guard.js";
import { makeCapture } from "./coding-capture.js";
import { makePauseEffects } from "./pause-effects.js";
import { CompletionEvidence } from "../../lib/coding-completion-evidence.js";
import { ObjectiveDelivery, type ObjectiveDeliveryState } from "../../lib/coding-objective-delivery.js";
import { sendAct } from "../../lib/coding-act-send.js";
import { decideTurnRecovery, describeTurnRecovery, recoveryInstruction, turnRecoveryRecord, type InflightTurn } from "../../lib/coding-turn-recovery.js";
import { activeConstraints, constraintLines, constraintSources, type ScopeConstraint } from "../../lib/coding-scope-constraints.js";
import { refreshGoalConstraints } from "../../lib/coding-standing-constraints.js";
import { postReleaseNotes } from "../../lib/release-notes.js";
import { endSession, getRepo, reassignSessionNode, releaseSessionDriver, touchSessionDriver } from "../../lib/coding-store.js";
import { shouldEndSessionAfterRun } from "../../lib/coding-session-lifecycle.js";
import { setCodingSessionCardStatus } from "../../lib/coding-board.js";
import { startSessionOnRunnerConn } from "../../lib/coding-session-relaunch.js";
import { resolvePause, runSucceeded, stopReasonFor, } from "../../lib/coding-pause.js";
import { awaitEngineIdle, durableIdleDeps, idleWaitIsDurable, } from "../../lib/coding-idle-poll.js";
import { pendingCodingResumeNote } from "../../lib/coding-resume-note.js";
import { accountTimeZone } from "../../lib/account-timezone.js";
import type { EngineWaitState } from "../../lib/coding-wait.js";
import { describeRepoState, readRepoWorkingState, type RepoWorkingState } from "../../lib/repo-state.js";
import { describeRepoSync, readRepoSync, type RepoSyncVerdict } from "../../lib/repo-sync.js";
import { attemptSyncSelfHealWithStash, autoStashApproved, readAutoStashPolicy } from "../../lib/checkout-actions.js";
import { describeSyncHeal, gateRunOnSync, readWorkingStateWithRetry, REPAIR_RUN_OBJECTIVE, repairCheckoutObjective, skippedSyncHeal, syncSelfHealEligible, type SyncGateOutcome, type SyncHealOutcome } from "../../lib/repo-sync-gate.js";
import { enforceRepoPolicies } from "../../lib/repo-policy-act.js";
import { setWorkCardProgress, upsertWorkCard } from "../../lib/work-card.js";
import { normalizeRunnerNode } from "../../lib/runtime-nodes.js";
import { appendEngineUsageTimeline, appendTimeline } from "../../lib/coding-timeline.js";
import { delegationTaskRecord } from "../../lib/delegation.js";
import { deepLinkFor } from "../../lib/console-links.js";
import { notifyUser } from "../../routes/push.js";
import { recordEngineUsage } from "../../lib/usage.js";
import type { EngineAuthResolved } from "../../lib/usage-payer.js";
import { sanitizeEngineUsage } from "../../lib/engine-usage.js";
import { recordEngineActs, sanitizeEngineActs, summarizeActs } from "../../lib/engine-acts.js";
import {
	describeAuthority,
	describeViolation,
	readMergePolicyForRun,
	recordAuthorityViolations,
	unauthorizedActs,
	type MergePolicy,
} from "../../lib/coding-authority.js";
import { describeRepoScopeViolation, recordRepoScopeViolations, registeredRepoSlugs, unscopedWrites } from "../../lib/repo-write-scope.js";
import { recordWriteRefusal, type WriteRefusal } from "../../lib/write-scope-refusals.js";
import { actsInWindow } from "../../lib/instance-work.js";
import { annotateOwnerAttribution } from "../../lib/run-attribution.js";
import { finishLoopRun, settledRunStatus, grantRunIterations, recordIteration, type RunWaitReason, } from "../../lib/agent-loop-store.js";
import { tryDequeueAndStart } from "../../lib/objective-queue-start.js";
import { wakeIdleCoder } from "../../lib/auto-pickup.js";
import { type PilotDecideOutcome, pilotDecide, unwrapPilotDecide } from "../../lib/pilot-decide.js";
import { traceCodingRun } from "../../lib/coding-run-trace.js";
import { codingCrashReport, outcomeWord, runOutcomeNote } from "../../lib/coding-run-report.js";
import { statusFor, type LoopRunStatus, type LoopStopReason } from "../../lib/agent-loop.js";
import { PILOT_DEFAULT_MAX_STEPS } from "../../lib/loop-limits.js";
import { resolveAccountCeilings } from "../../lib/delegation-budget-store.js";
import { CodingRunProbe, recordCodingFailure } from "../../lib/coding-failure.js";
import { planInterruptionResume, roundThroughInterruptions, type InterruptionResume } from "../../lib/coding-interrupt.js";
import { postSystemMessage } from "../../lib/instance-system-message.js";
import { withTurnReplay } from "../../lib/coding-turn-replay.js";
import type { Env } from "../../types.js";

export { RUN_OWNERSHIP_LEASE_MS } from "./coding-capture.js";

/**
 * The coding orchestrator's remote brain: a durable Cloudflare Workflow that
 * drives the user's local coding CLI (a child process, not tmux) toward an objective — read the
 * pane, ask Claude (BYOK) for the next instruction, send it, wait for idle,
 * repeat. On a stuck/needs-input it hands off to the human via the same console
 * takeover, polls until resolved, then resumes. Durable steps → survives the 30s
 * request limit, same machinery as {@link JobApplyWorkflow} for the browser.
 *
 * The `CodingSessionWorkflow` entrypoint in `./index.ts` hands every non-watch run here.
 */
export async function runCodingSessionWorkflow(env: Env, event: WorkflowEvent<CodingSessionParams>, step: WorkflowStep): Promise<CodingResult> {
	const { instanceId, userId, sessionId, repoId, runnerNode, cloneUrl, branch, token, tokenUsername, goal } = event.payload;
	/**
	 * When this run began — the lower bound of the window its acts are read back from (#294).
	 *
	 * JOURNALLED in a step, not a bare `Date.now()`. Everything outside `step.do` re-runs on
	 * every workflow replay, so a plain assignment would creep forward each time and the close
	 * would then read a window that starts AFTER the acts it is meant to report — losing exactly
	 * the record for the long, resumed runs most likely to have merged something.
	 */
	const runStartedAt = (await step.do("run-started-at", async () => Date.now())) as number;
	/** The run's stable key — what its objective and every act id are named by (#1019). */
	const runKey = event.payload.loopRunId ?? `${sessionId}@${runStartedAt}`;

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
	/**
	 * WHICH repositories may this run write to? (#676)
	 *
	 * Resolved once, here, for the reason `mergePolicy` is: a gate that means different things
	 * at different moments of one run is not a gate. Distinct from `mergePolicy`, which bounds
	 * WHAT a run may make irreversible — this bounds WHERE. Run `csess_f686f1ff` was inside its
	 * merge policy the whole time; it was in the wrong organisation.
	 */
	const writeScope = (await step.do("repo-write-scope", () => registeredRepoSlugs(env, instanceId, userId))) as string[];
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
	/** Who this run is, for the trace. Same `traceId` rule as `recordCodingFailure` (#580 AC4). */
	const traceCtx = { userId, instanceId, sessionId, runId: event.payload.loopRunId ?? null, repo: goal.repo, cardId: (event.payload.boardTaskId as string | undefined) ?? null };
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
		// Read by THIS session over the run's window, not by trace id: a console terminal poll can
		// drain a run's acts before the Pilot does, and another repo's run on this instance can
		// overlap the window (#809) — see `actsInWindow`.
		const acts = event.payload.loopRunId || event.payload.boardTaskId
			? await actsInWindow(env, userId, instanceId, sessionId, runStartedAt, Date.now()).catch(() => [])
			: [];
		const actLine = summarizeActs(acts);
		// #505: the report is the Pilot's own account of the run, and it reaches the owner
		// unmodified. When it says the human decided something and the platform knows the human
		// said nothing, that fact is stamped on. Annotated, never rewritten — the owner has to
		// see the claim in order to distrust it. The composition around it is `runOutcomeNote`.
		const detail = annotateOwnerAttribution(outcome.detail ?? "", ownerTurns);
		// ONE value: the word the note leads with and the reason the row records are the same
		// reading of this run, so a card cannot say `outcome: failed` beside a row saying
		// `interrupted` (#523). `stopReasonFor` is the pure table (#541); `crashReason` overrides
		// it for the deaths that are not the objective failing at all (#546).
		const reason = crashReason ?? stopReasonFor(outcome.outcome);
		const note = runOutcomeNote({
			outcome: outcomeWord(outcome.outcome, reason),
			detail,
			// Both gates, one line. A run that wrote to the wrong repository must say so in the
			// report the owner actually reads — #676's whole complaint is that the closing
			// summary described the target as "the PAGS platform repo" and nothing contradicted it.
			breach: [
				...unauthorizedActs(mergePolicy, acts).map((a) => describeViolation(mergePolicy, a)),
				...unscopedWrites(writeScope, acts).map(({ act, refused }) => describeRepoScopeViolation(refused, writeScope, act)),
			].join(" "),
			authorityNote,
			actLine,
		});
		// What the run row ends up saying (#1015): this run's verdict, or a cancellation that settled
		// first — in which case neither the chat nor the card may announce this run's own ending.
		let settledStatus = statusFor(reason);
		if (event.payload.loopRunId) {
			settledStatus = await step.do(`delegation-run-done${suffix}`, async () => {
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
				const finished = await finishLoopRun(env, event.payload.loopRunId as string, reason, note, Date.now());
				if (finished === "superseded") return ((await settledRunStatus(env, event.payload.loopRunId as string)) ?? statusFor(reason)) as LoopRunStatus;
				// The result, in the thread the loop was started from. Written HERE rather than by
				// the console's poll: the browser version only existed if the tab happened to be
				// open, so a run finished while you were elsewhere was never recorded at all.
				const ok = reason === "done";
				await postToChat(
					`${ok ? "**Loop complete**" : `**Loop stopped** (${reason})`}${detail ? `\n\n${detail}` : ""}${actLine ? `\n\n${actLine}` : ""}`,
				);
				return statusFor(reason);
			});
		}
		if (event.payload.boardTaskId) {
			await step.do(`delegation-task-done${suffix}`, async () => {
				// Same shared record shape as the route that opened the card (#155) — only the
				// status + outcome note change. Inline upsert keeps the workflow off a routes import.
				const task = delegationTaskRecord({
					id: event.payload.boardTaskId as string,
					targetLabel: goal.repo,
					objective: goal.objective,
					// `statusFor`, not a local ok/fail test (#553): the supervisor's card and the
					// loop-run row describe ONE run, and this is what stops them landing in
					// different columns for it.
					status: settledStatus,
					now: new Date().toISOString(),
					note,
					// The SAME acts `actLine` was built from, as RECORDS (#568): the card's 300-char
					// detail must state the COUNT, never a prefix of the sentence about it.
					acts,
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

	const { runWith, runRetry, runIdle } = stepRunners(step, probe);
	let n = 0;

	// (Re)launch the engine on the machine `conn` points at. `lib/coding-session-relaunch.ts` —
	// called once at the start and again by the runner guard on every heal, which is why it is not
	// inline in the "start" step.
	const startOnRunner = () =>
		startSessionOnRunnerConn(env, conn, { instanceId, userId, sessionId, repoId, clientType: goal.clientType, cloneUrl, branch, token, tokenUsername });

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
	const guard = makeCodingRunnerGuard({
		env,
		step,
		instanceId,
		userId,
		sessionId,
		loopRunId: event.payload.loopRunId,
		driverId: event.payload.driverId,
		workflowInstanceId: event.instanceId,
		runRetry,
		runWith,
		postToChat,
		getConn: () => conn,
		setConn: (c) => {
			conn = c;
		},
		startOnRunner,
		getLastEngine: () => lastEngine,
		setLastEngine: (e) => {
			lastEngine = e;
		},
		getObjective: () => objective,
		// A lambda, not the function: `reportObjective` is declared further down and read only when the guard reconnects.
		reportObjective: (state) => reportObjective(state),
	});
	/** Read the pane AND whether the run should stop (see `coding-capture.ts`). */
	const capture = makeCapture({
		env,
		instanceId,
		userId,
		sessionId,
		loopRunId: event.payload.loopRunId,
		driverId: event.payload.driverId,
		repo: goal.repo,
		mergePolicy,
		writeScope,
		cardId: traceCtx.cardId,
		getConn: () => conn,
		// The record cursor of the latest JOURNALLED capture (#1358): what the protocol resumes from after a replay. `lastPane` is declared
		// further down and set by `measured`, which every capture's result passes through.
		getAck: () => lastPane.recordAck,
	});

	/**
	 * Measure the pane on the way OUT of the durable step (#546).
	 *
	 * `probe.saw` used to sit inside `capture`, i.e. inside the step callback — which a replay
	 * never runs, so a resumed attempt filed `paneChars: 0` and read as "it died on an empty
	 * pane". Here it sees the JOURNALLED result, which a replay does return, so the size is
	 * re-measured on every attempt exactly as {@link CodingRunProbe}'s docblock promises.
	 */
	// The run's objective, delivered verbatim with its first turn (#1019) — set once the goal is final, below.
	let objective: ObjectiveDelivery | null = null;
	let lastEngine: CodingPaneSnapshot["engine"] | null = null; // the input ledger the latest journalled snapshot named (#1019)
	// One step per (state, runner generation): the receipt names the digest, byte length, consumed input
	// and runner — never the objective's text (#1019).
	const reportObjective = (state: ObjectiveDeliveryState) =>
		step.do(`objective-${state}-g${objective?.generation ?? 0}`, async () => {
			if (!objective) return;
			const line = objective.describe(state);
			await traceCodingRun(env, traceCtx, "coding.run.objective", line, { ...objective.receipt(state) });
			if (state !== "delivered") await postToChat(`**Loop** — ${line}`);
		});
	// Set when the required envelope was refused (#1019): nothing more reaches the engine, and the next snapshot ends the run.
	let refusedStop: string | null = null;
	// #1053: the turn the run waits on (its checkpoint), whether the act in flight is that turn's one recovery,
	// and — when a lost turn cannot be resumed — the run's ending.
	let inflight: InflightTurn | null = null;
	let sendingRecovery = false;
	let lostTurnStop: string | null = null;
	let lastPane = {} as CodingPaneSnapshot;
	const measured = async (p: Promise<unknown>): Promise<CodingPaneSnapshot> => {
		const pane = (await p) as CodingPaneSnapshot;
		lastPane = pane;
		probe.saw(pane?.pane);
		lastEngine = pane?.engine ?? lastEngine;
		// Read off the JOURNALLED snapshot, so a replay settles delivery exactly as the first pass did.
		objective?.engine(pane?.engine);
		const settled = objective?.observe(pane?.engine);
		if (settled) await reportObjective(settled);
		return pane;
	};

	/**
	 * Did the turn the run just waited on survive (#1053)? A relaunched engine is idle, so the wait returns
	 * either way — this is where a lost turn is told apart from a finished one. Decided from journalled values
	 * (`lib/coding-turn-recovery.ts`), recorded once as an owner-scoped diagnostic, then: resumed ONCE under a
	 * deterministic id, or the run ends `turn_lost` so its queue lock is released. Never silently skipped.
	 */
	async function settleTurn(pane: CodingPaneSnapshot): Promise<CodingPaneSnapshot> {
		const turn = inflight;
		inflight = null;
		if (!turn) return pane;
		const d = decideTurnRecovery(turn, pane, conn.runnerNode ?? null);
		if (d.decision === "intact") return pane;
		const label = `s${n++}-turn-recovery`;
		const line = (await step.do(label, async () => {
			const record = turnRecoveryRecord(turn, pane, d, { runId: event.payload.loopRunId ?? null, sessionId, node: conn.runnerNode ?? null, detectedAt: Date.now() });
			const text = describeTurnRecovery(record);
			await traceCodingRun(env, traceCtx, "coding.run.turn_recovery", text, record);
			await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: text }).catch(() => undefined);
			await postToChat(text);
			return text;
		})) as string;
		if (d.decision === "block") {
			lostTurnStop = line;
			return { ...pane, cancelled: true, stopReason: line };
		}
		sendingRecovery = true;
		const acted = await deps.act({ kind: "message", author: "pilot", text: recoveryInstruction(turn), inputId: d.resumeInputId }).finally(() => {
			sendingRecovery = false;
		});
		return acted?.cancelled ? acted : deps.waitIdle();
	}
	const deps: CodingDeps = {
		snapshot: () => {
			const stop = refusedStop ?? lostTurnStop;
			return stop ? Promise.resolve({ ...lastPane, cancelled: true, stopReason: stop }) : measured(guard(runRetry, `s${n++}-snapshot`, capture));
		},
		act: async (a: CodingActionKind) => {
			const label = `s${n++}-act`;
			// Every instruction carries its own id (#1019): deterministic per step, so a step retry or a
			// guard re-attempt sends the SAME id, and a runner that already accepted it does not run it twice.
			const withId: CodingActionKind = a.kind === "message" ? { ...a, inputId: a.inputId ?? `act:${runKey}:${label}` } : a;
			// The constraints in force AT THE SEND (#1364), journalled like the decision's refresh (re-applied on replay): they were
			// refreshed only when the run decided, so a send that followed a newer owner restriction — the one recovery turn above
			// all, which goes to a replacement engine with the objective — stated "CONSTRAINTS IN FORCE NOW" without it.
			const fresh = (await runRetry(`${label}-constraints`, async () => {
				await refreshGoalConstraints(env, goal, { instanceId, userId, repoId, sessionId, runStartedAt });
				return goal.scopeConstraints ?? null;
			})) as ScopeConstraint[] | null;
			if (fresh) goal.scopeConstraints = fresh;
			// The constraints in force ride the objective WHOLE or nothing is sent; recomputed on replay, so it refuses again (#1019).
			const lines = constraintLines(goal.scopeConstraints ?? activeConstraints(constraintSources(goal)));
			const block = objective?.blocks(lines);
			if (block?.blocked && objective) {
				if (block.settled) await reportObjective(block.settled);
				refusedStop = objective.stopReason();
				return { ...lastPane, cancelled: true, stopReason: refusedStop }; // the loop ends HERE, even on its last step
			}
			await objective?.attempt(withId, lines);
			// Composed inside every attempt (coding-act-send.ts) against the runner now there; the #693 replay is composed in the step too.
			const compose = () => (objective ? objective.attach(withId) : withId);
			const prepare = (x: CodingActionKind) => withTurnReplay(env, { instanceId, userId, repoId, repoName: goal.repo, clientType: goal.clientType }, x);
			const node = () => conn.runnerNode ?? null;
			const before = { engine: lastEngine, node: node() }; // where this act is dispatched — the checkpoint when its reply is lost
			const { pane, receipt } = await sendAct({ sessionId, run: runRetry, guard, call: (path, body) => callRunner(conn, path, body), node, engine: () => lastEngine, prepare }, label, compose);
			objective?.sent(); // counted before its pane can settle a delivery receipt; settlement itself waits for the generation check
			await measured(Promise.resolve(pane));
			if (receipt.outcome === "unknown" || receipt.outcome === "conflict") {
				const why = receipt.outcome === "conflict" ? "the runner holds different content under this id" : "the reply was lost and no runner that could speak for it said whether it ran";
				await step.do(`${label}-unknown`, () => traceCodingRun(env, traceCtx, "coding.run.input_unknown", `${receipt.inputId ?? label}: ${why} — not re-sent.`, { inputId: receipt.inputId, outcome: receipt.outcome }));
			}
			objective?.settle(receipt); // from the journalled receipt: a predecessor's acceptance never counts for its replacement
			// The turn's checkpoint (#1053): the process that ACCEPTED it, or — reply lost — the one it was sent to.
			if (withId.kind === "message" && withId.inputId) {
				const owner =
					receipt.outcome === "accepted" || receipt.outcome === "predecessor"
						? { ledger: receipt.ledger, epoch: receipt.epoch, node: node() }
						: { ledger: before.engine?.ledger ?? null, epoch: before.engine?.epoch ?? null, node: before.node };
				inflight = { inputId: withId.inputId, ...owner, receipt: receipt.outcome, sentAt: Date.now(), recovery: sendingRecovery };
			}
			return pane;
		},
		// The spend gate lives in `coding-decide-budget.ts` — the LLM call is the only place this
		// loop spends money, so it is the only place a budget has to sit (#159).
		// The controller's provider calls run under ONE recovery policy (#907, lib/pilot-decide.ts): an exhausted
		// stall is returned across the step and raised here, so the step retry never multiplies it.
		decide: async (p) =>
			unwrapPilotDecide(
				(await step.do(probe.at(`s${n++}-decide`), DECIDE_RETRY, () =>
					pilotDecide(env, { userId, instanceId, repoId, sessionId, runStartedAt, loopRunId: event.payload.loopRunId ?? null, budgetId: event.payload.budgetId, depth: event.payload.depth, params: p }),
				)) as PilotDecideOutcome,
				p.goal,
			),
		// Poll capture until the CLI goes idle, BACKING OFF as the turn proves long (#523). A
		// flat 2-second poll spent 2 subrequests per second of Engine work against a ceiling
		// Cloudflare applies per WORKFLOW INSTANCE, so three runs exhausted it at ~2 hours and
		// reported their pushed work as `failed`. The schedule, the arithmetic and the boundary
		// it preserves are `lib/coding-idle-poll.ts` — that BACKOFF is what took the run under it.
		//
		// DURABLE BY DEFAULT since #814: each capture its own guarded step, each sleep a `step.sleep`,
		// so a turn survives an eviction rather than restarting its whole 480-second window. NOT known
		// to save subrequests (`idleWaitIsDurable`); `CODING_IDLE_DURABLE=0` restores the one-step wait.
		waitIdle: () => {
			if (refusedStop || lostTurnStop) return Promise.resolve(lastPane); // nothing was sent, so there is no turn to wait for
			// ONE increment, above the branch — the counter must not depend on which wait ran. Why: the wiring test.
			const label = `s${n++}-waitidle`;
			return measured(
				idleWaitIsDurable(env)
					? awaitEngineIdle(durableIdleDeps({ label, capture: (name) => guard(runRetry, name, capture), sleep: (name, ms) => step.sleep(name, ms) }))
					: guard(runIdle, label, () => awaitEngineIdle({ capture, sleep })),
			).then(settleTurn);
		},
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
			if (type === "empty" || type === "repeated" || type === "scope_refused" || type === "evidence" || type === "write_refused") await postToChat(`**Loop** — ${message}`);
				if (type === "write_refused") await recordWriteRefusal(env, { userId, instanceId, sessionId, traceId: event.payload.loopRunId ?? null }, data as WriteRefusal);
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
				// refusal above is: it records what was driven, not who asked. A `learned` note (#822) lands beside it as a `brain` row.
				if (driven || type === "learned") await appendTimeline(env, { sessionId, instanceId, userId, type: driven ? "command" : "brain", content: driven || message }).catch(() => undefined);
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
	const pauseEffects = makePauseEffects({
		env,
		step,
		goal,
		instanceId,
		userId,
		sessionId,
		repoId,
		boardTaskId: event.payload.boardTaskId,
		loopRunId: event.payload.loopRunId,
		driverId: event.payload.driverId,
		workflowInstanceId: event.instanceId,
		cloneUrl,
		branch,
		token,
		tokenUsername,
		cardId: traceCtx.cardId,
		runRetry,
		postToChat,
		getConn: () => conn,
		setConn: (c) => {
			conn = c;
		},
		nextN: () => n++,
		startOnRunner,
		getObjective: () => objective,
	});
	const pauseDeps = pauseEffects.deps;

	/**
	 * An interruption is resumed HERE, by the workflow (#855) — see `lib/coding-interrupt.ts` for why a
	 * rethrow out of `run()` never was. The bookkeeping is one journalled step per interruption, keyed
	 * by an ordinal a replay re-derives identically, so an eviction mid-backoff returns the recorded
	 * plan rather than counting the interruption, filing its row and posting the notice twice.
	 */
	let interruptions = 0;
	const roundDeps = {
		plan: async (e: unknown, k: number) =>
			(await step.do(`interrupt-${k}`, () =>
				planInterruptionResume(e, {
					env,
					runId: event.payload.loopRunId ?? null,
					record: (err) =>
						recordCodingFailure(env, {
							err, userId, instanceId, sessionId, probe, steps: pilotSteps, startedAt: runStartedAt, repo: goal.repo,
							node: conn.runnerNode ?? null, runId: event.payload.loopRunId ?? null, taskId: event.payload.boardTaskId ?? null, disposition: "resumed",
						}).then(() => undefined),
					trace: (why, meta) => traceCodingRun(env, traceCtx, "coding.run.interrupted", why, { ...meta, phase: probe.phase }).then(() => undefined),
					announce: postToChat,
					now: () => Date.now(),
				}),
			)) as InterruptionResume | null,
		sleep: (label: string, ms: number) => step.sleep(label, ms),
		resumed: (note: string) => {
			goal.resumeNote = note;
		},
	};

	let result: CodingResult = { outcome: "failed", detail: "did not start", steps: 0 };
	// Wrap the whole run so a thrown step (clone/runner/AI hiccup that exhausts its
	// retries) STILL ends the session + notifies — otherwise the D1 row sits "active"
	// forever, the runner tmux is never torn down, and the run silently vanishes.
	try {
		// Ensure the session is up and the CLI launched (clones the repo if the runner doesn't
		// already have this session, e.g. after a runner restart). Guarded like every other
		// runner call: a run queued while the machine was rebooting used to die here too.
		await guard(runWith(START_RETRY), "start", startOnRunner);
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
		//
		// …and where it stands against its UPSTREAM (#785). The tree's state says what is in the
		// working directory; the sync says whether the commits the run will build on are the
		// commits that exist. A checkout three commits behind `main` plans a diff against code that
		// has already changed, and nothing in the state note could say so. The runner fetches
		// (remote-tracking refs only — never the branch, never the tree) and counts; the platform
		// TELLS, in the same voice as the state note, and pulls nothing itself.
		const repoStart = (await step.do("repo-state-start", async () => {
			const repo = await getRepo(env, instanceId, userId, repoId).catch(() => null);
			if (!repo) return { state: null, sync: null, stateError: null };
			const [read, sync] = await Promise.all([
				// Retried once, and the error kept (#1319): an unreadable tree must not veto the fast-forward, and the owner is told why.
				readWorkingStateWithRetry((onError) => readRepoWorkingState(conn, { repo, sessionId, onError })),
				// `forceFetch`: a run's start is the one moment a fresh answer is worth a network
				// round trip, whatever the cache holds.
				readRepoSync(conn, { workDir: repo.workdir, sessionId, branch: repo.branch, forceFetch: true }).catch(() => null),
			]);
			return { state: read.state, sync: sync ?? null, stateError: read.error };
		})) as { state: RepoWorkingState | null; sync: RepoSyncVerdict | null; stateError?: string | null };
		const repoState = repoStart.state;
		// …and if it is merely BEHIND on a clean tree, the platform fast-forwards it itself (#802).
		// The gate below stopped this platform's own coder twice in a row, 19 commits behind, and
		// told a human to go and type the pull — an objective saying "pull first" never reaches a
		// run the gate has already stopped. The decision (only `behind`, only clean, only on its
		// branch — never `diverged`), the ask and the independent re-read live in
		// `lib/repo-sync-gate.ts`; the machine re-checks every precondition at the hands. A heal
		// that was not tried is recorded with its reason, so the refusal can say why.
		const heal = (await step.do("repo-self-heal", async () => {
			const eligible = syncSelfHealEligible(repoStart.sync, repoStart.state, branch ?? null);
			if (!eligible.eligible || !eligible.branch) return skippedSyncHeal(eligible);
			const repo = await getRepo(env, instanceId, userId, repoId).catch(() => null);
			if (!repo) return null;
			// #1324: a dirty tree that blocks the pull is stashed (backup kept) only when the owner approved it: per instance, or once on this run.
			const approved = autoStashApproved(null, (goal as { autoStash?: boolean }).autoStash) || (await readAutoStashPolicy(env, instanceId, userId));
			const attempted = await attemptSyncSelfHealWithStash(conn, { repo, sessionId, branch: eligible.branch, runLabel: `run ${event.payload.loopRunId ?? sessionId ?? ""}`, approved });
			return repoStart.stateError ? { ...attempted, stateReadError: repoStart.stateError } : attempted;
		})) as SyncHealOutcome | null;
		// The verdict the run is judged on is the checkout as it IS now — the re-read after a
		// heal, else the start-of-run read.
		const syncAtStart = heal?.sync ?? repoStart.sync;
		// `branch` is the repo's CONFIGURED branch, carried on the payload by whoever started
		// the run — so the comparison is against what this repo is supposed to be on, not
		// against a hardcoded "main".
		const stateNote = repoState ? describeRepoState(repoState, { configuredBranch: branch ?? null }) : null;
		const syncNote = syncAtStart ? describeRepoSync(syncAtStart) : null;
		// A REPAIR run (#804) gets the platform's brief INSTEAD of its objective, and not the two
		// advisory notes below: they rank as USER RULES in the Pilot's prompt and tell it to stop
		// rather than touch a dirty tree — the exact move a repair run exists to make (safely: it
		// parks, never discards). The brief carries the same facts in its own words.
		const repair = goal.repairCheckout === true;
		if (repair) {
			goal.objective = repairCheckoutObjective({ repoLabel: goal.repo, branch: branch ?? null, sync: syncAtStart, state: repoState, heal, ownerNote: goal.objective });
		}
		if (!repair && (stateNote || syncNote)) {
			goal.specialInstructions = [
				goal.specialInstructions,
				stateNote
					? `REPOSITORY STATE (read before you start): ${stateNote} You did not create this state. Do NOT revert, stash, reset or discard anything you did not write yourself, and never \`git stash pop\`/\`apply\`: the stash is repo-global, so its top entry may be someone else's work (#1021). To test old source against a new test, use an isolated \`git worktree add --detach\` checkout, never the stash. If your objective needs a clean tree or a different branch, say so and stop rather than clearing it.`
					: "",
				syncNote
					? `UPSTREAM SYNC (checked just now, nothing was pulled): ${syncNote} If the checkout is BEHIND and the tree is clean and on its configured branch, make your FIRST instruction a fast-forward (\`git pull --ff-only\`) so you never plan against a stale base, and say in your report what it brought in. If it is dirty or has diverged, do not merge or rebase on your own initiative — report it and ask.`
					: "",
			]
				.filter(Boolean)
				.join("\n\n");
		}
		// …and if it could NOT be confirmed, the run stops here (#801).
		//
		// #785 made the verdict audible and left it advisory: the instruction above asks the
		// Engine to fast-forward, and twice — #800, and this platform's own coder sitting six
		// commits behind — a run proceeded on a base nobody had checked. `repo-sync-gate.ts`
		// owns the decision, the sentence and the operator's record; this obeys it.
		//
		// `result` is SET rather than thrown. A thrown gate reaches `codingCrashReport` below and
		// reads as "run error:", which is the exact confusion #523 closed — and worse, it would
		// be classified for a platform resume and replayed against the same unconfirmed base.
		const syncGate = (await step.do("repo-sync-gate", async () =>
			gateRunOnSync(env, { instanceId, userId, sessionId, node: conn.runnerNode ?? null, repo: goal.repo, heal, repair }, syncAtStart),
		)) as SyncGateOutcome;
		if (syncGate.blocked) result = { outcome: "failed", detail: syncGate.message, steps: 0 };
		// A run the PLATFORM cut off leaves its work on the record and its PLAN nowhere (#523):
		// `runCodingLoop`'s action log is a function-local array, so it dies with the invocation
		// and the next run starts from the objective — re-implementing ten issues that are
		// already pushed. This composes the briefing from what IS durable. Null on every
		// ordinary start, and on any failed read: the briefing is an improvement to a run that
		// is otherwise fine, so it must never be the thing that stops one.
		const resumeNote = (await step.do("resume-note", async () => (await pendingCodingResumeNote(env, { userId, instanceId, sessionId, uncommittedFiles: repair ? 0 : (repoState?.changedFiles ?? 0), lookbackMs: event.payload.resumeLookbackMs })) ?? null)) as string | null;
		if (resumeNote) goal.resumeNote = resumeNote;
		await step.do("tl-start", async () => {
			// …and in the UNIFIED trace, which is the surface `agent_trace` and every MCP debug
			// path reads (#580 AC4). The timeline below is per-session and per-console; a run that
			// stopped without classifying a failure reached neither `agent_trace` nor `list_errors`.
			// A repair run's objective is the platform's multi-line brief; the record carries the
			// label and the brief's verdict line, not the whole brief (#804).
			const objectiveLabel = repair ? REPAIR_RUN_OBJECTIVE : goal.objective;
			await traceCodingRun(env, traceCtx, "coding.run.start", `objective: ${objectiveLabel}`, { maxSteps: event.payload.maxSteps ?? PILOT_DEFAULT_MAX_STEPS, repair: repair || undefined });
			await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: `AI run started — objective: ${objectiveLabel}` });
			if (repair && syncGate.message) await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: syncGate.message });
			if (stateNote) await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: stateNote });
			// Recorded, not just injected: a checkpoint the owner cannot see is indistinguishable
			// from one that never fired, and this is the run whose predecessor's report was lost.
			if (resumeNote) await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: resumeNote });
			// The sync line is a RECORD as much as a briefing (#785): when a run's report later
			// says "the file was not there", the timeline has to show whether the base was
			// current when the run began. Loud in chat only when it is actionable — a run
			// starting behind is the incident; a run starting in sync is not news.
			// A pointer moved on the owner's checkout unattended (#802): the record says what
			// arrived and how to put it back, in the trace as well, because "why is my checkout on
			// a different commit" has to be answerable from `agent_trace`.
			// An unreadable tree is recorded even when nothing was healed (#1319): the error the old code threw away.
			if (repoStart.stateError && !(heal && heal.status !== "skipped")) {
				await traceCodingRun(env, traceCtx, "coding.run.self_heal", `The working tree's state could not be read (${repoStart.stateError}).${heal ? ` ${describeSyncHeal(heal)}` : " No fast-forward was needed."}`, { stateReadError: repoStart.stateError, status: heal?.status ?? "none" });
			}
			if (heal && heal.status !== "skipped") {
				await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: describeSyncHeal(heal) });
				await traceCodingRun(env, traceCtx, "coding.run.self_heal", describeSyncHeal(heal), { status: heal.status, commits: heal.commits, from: heal.from, to: heal.to, ...(heal.stateReadError ? { stateReadError: heal.stateReadError } : {}) });
				if (heal.status === "healed") await postToChat(`**Repository fast-forwarded** — ${describeSyncHeal(heal)}`);
			}
			if (syncNote) {
				await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: `Upstream sync at start: ${syncNote}` });
				if (syncAtStart?.state === "behind" || syncAtStart?.state === "diverged") await postToChat(`**Repository sync at start** — ${syncNote}`);
			}
			// The refusal is LOUD (#801). A gate whose verdict lives only in the run's outcome
			// field repeats #800's failure one layer up: the owner has to go and read a raw log
			// to find out why nothing happened. Chat and trace both, because the remedy is a
			// thing a person has to go and do on a named machine.
			if (syncGate.blocked) {
				await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: syncGate.message });
				await traceCodingRun(env, traceCtx, "coding.run.blocked", syncGate.message, { reason: syncGate.decision.reason });
				await postToChat(`**Run stopped — unconfirmed base** — ${syncGate.message}`);
			}
			// State the authority up front, in the record the owner reads back. Only when one is
			// actually in force — a line saying "may merge" on every run would be noise, and worse,
			// would read as a decision somebody made.
			if (authorityNote) await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: authorityNote });
			// The card follows the RUN, and this is where a run claims it (#553). Needed because a
			// session outlives its run since #271: a second run on a session a previous run left
			// `failed` would otherwise start under a card still reading "Failed", and a card has to
			// be able to come back out of "Needs you". `createSession` only opens a card for a
			// session it CREATES, so nothing else does this.
			await setCodingSessionCardStatus(env, instanceId, userId, sessionId, "running").catch(() => undefined);
			return null;
		});

		// The run's observed tool calls (#1019), kept across rounds: a completion claim is judged on the whole run.
		const evidence = new CompletionEvidence();
		// The failed-turn streak, kept across rounds the same way (#1344): the turn a park or question stopped on is not new next round.
		const turnCarry: TurnCarry = { turns: { lastAt: null, consecutive: 0 }, transientStreak: 0 };
		// The objective goes to the engine only if this machine's runner can render it (#1019).
		objective = await ObjectiveDelivery.create(runKey, goal.objective, goal.objectiveOrigin);
		const caps = await guard(runRetry, "objective-capabilities", () => callRunner(conn, "/capabilities", {})).catch(() => null);
		const unsupported = objective.capabilities(caps, { runnerNode: conn.runnerNode ?? null });
		if (unsupported) await reportObjective(unsupported);
		const stepCap = event.payload.maxSteps ?? PILOT_DEFAULT_MAX_STEPS;
		const stepCeiling = (await step.do("iteration-ceiling", async () => (await resolveAccountCeilings(env, userId).catch(() => null))?.loopMaxIterations ?? stepCap)) as number;
		let grantedSteps: number | null = null; // #1236: the owner's approval at the cap sizes the NEXT round
		for (let round = 0; round < 12 && !syncGate.blocked; round++) {
			// The caller's cap when it named one, the historical 40 when it did not (#374).
			// An interruption is retried in place after a published backoff (#855); anything else — or
			// one past the bound — is rethrown to the terminal catch below.
			result = await roundThroughInterruptions(
				() => runCodingLoop(deps, goal, { maxSteps: grantedSteps ?? stepCap, evidence, turnCarry }),
				roundDeps,
				{ next: () => ++interruptions },
			);
			// A refused envelope is neither a failed objective nor an owner cancel: its own, continuable reason (#1019).
			if (refusedStop) {
				crashReason = "constraint_refused";
				result = { ...result, outcome: "failed", detail: refusedStop };
				break;
			}
			// A lost engine turn that could not be resumed exactly once (#1053): blocked on the owner, never re-sent.
			if (lostTurnStop) {
				crashReason = "turn_lost";
				result = { ...result, outcome: "failed", detail: lostTurnStop };
				break;
			}
			// Both are consumed by the round above — cleared so a stale handoff value or a stale platform note isn't re-injected into a later round.
			goal.userHint = undefined;
			goal.resumeNote = undefined;
			// WHICH pause this is, how long it may last and what the owner is told: `lib/coding-pause.ts`.
			// "How long may a run wait, and for what" is a rule, and a rule inside a Workflow can only be
			// tested by running one (#541).
			// WHICH park this is, decided here from the outcome `resolvePause` is about to branch
			// on — the only place both the reason and the run id are in hand before the wait
			// starts. `waiting` is the engine's own usage window; `stuck`/`needs_input` are a
			// person. A tick that could not tell them apart is why the record could not either.
			// A `needs_input` is a QUESTION — a value or a choice, answerable from a conversation — and
			// parks as `decision`, not `human` (#960): the record used to make it indistinguishable from
			// a hands-on takeover, which is why the fleet, the board and the status report all called it
			// hard-blocked.
			// A `stuck` asks a question too (#1234): a `human` park carried no ask — the blank question nobody could answer.
			// A provider failing transiently is not the CLI's usage limit (#1344): it is an interruption with a retry scheduled.
			const parkReason: RunWaitReason = result.outcome === "waiting" ? (result.waitKind === "transient" ? "platform_interrupt" : "engine_limit") : result.outcome === "needs_reauth" ? "engine_auth" : "decision";
			pauseEffects.clearAsk();
			// A new provider outage gets the whole short ladder again once the engine has worked since the last one (#1362).
			// Both facts come from journalled snapshots, so a replay resets it identically.
			if (result.outcome === "waiting" && result.waitKind === "transient") {
				if (turnCarry.okTurnSeen) waitState.transientWaits = 0;
				turnCarry.okTurnSeen = false;
			}
			const pause = await resolvePause({ ...pauseDeps(round, parkReason), iterations: { cap: grantedSteps ?? stepCap, ceiling: stepCeiling } }, { round, result, state: waitState });
			if (!pause.resume) {
				result = pause.result;
				if (pause.stopReason) crashReason = pause.stopReason; // `decision` (#1076): a park that ran out, continuable
				break;
			}
			// The human answered the handoff — this run has an owner turn in it, so a report that
			// says "the user chose" may well be true and is left alone (#505).
			if (pause.ownerTurn) ownerTurns++;
			grantedSteps = pause.grantSteps ?? null;
			if (grantedSteps && event.payload.loopRunId) await runRetry(`grant-${round}`, () => grantRunIterations(env, event.payload.loopRunId as string, grantedSteps as number));
			goal.userHint = pause.userHint;
			goal.ownerTurns = ownerTurns; // run-scoped; userHint is not — a resume clears it (#505, see CodingGoal)
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
		// Recorded (#529) as an ENDING. An interruption the run could be resumed through never reaches
		// here — the round loop retries it in the workflow (#855). What arrives is a death outside the
		// rounds, or one past the resume bound, and rethrowing it "for a journal replay" was not a
		// resume: an error escaping `run()` ends the Workflow instance, and the run sat parked on
		// `platform_interrupt`, reported as "being resumed", until the sweeper closed it. Ending it here
		// is the loud version of the same outcome — the owner is told at once, under the interruption's
		// own stop reason (#546), instead of fifteen minutes later by a sweeper that says nothing.
		await recordCodingFailure(env, {
			err: e, userId, instanceId, sessionId, probe, steps: pilotSteps, startedAt: runStartedAt, repo: goal.repo,
			node: conn.runnerNode ?? null, runId: event.payload.loopRunId ?? null, taskId: event.payload.boardTaskId ?? null, disposition: "ended",
		}).catch(() => undefined);
	} finally {
		// TEARDOWN. Everything below is terminal: it enforces the repo's end-of-run policies, drains
		// the closing acts, ends the session, notifies, and closes the delegation row and board card.
		// It used to be skipped for a run "being resumed" by a journal replay (#583); that resume is now
		// a retry inside the round loop (#855), so a run that reaches this `finally` has ENDED.
		//
		// The `finally` is kept rather than moved into the try's success path: a crash must still
		// reach every line of it, which is the #341 property this block exists for.
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
		// The LAST check against upstream (#785, ask 2). The one-active-session-per-repo rule
		// bounds but does not remove the race: a human, or another tool, can push to `main`
		// while a run works, and a run that ends BEHIND has finished on top of a base that
		// moved. Ahead is reported too — unpushed commits at the end of a run are a fact the
		// owner needs in the thread, not something to discover from a later `git status`.
		// Fetch only; the run is over and nothing here may merge into a tree it no longer
		// drives.
		await step.do("repo-sync-end", async () => {
			const repo = await getRepo(env, instanceId, userId, repoId).catch(() => null);
			if (!repo) return null;
			const v = await readRepoSync(conn, { workDir: repo.workdir, sessionId, branch: repo.branch, forceFetch: true }).catch(() => null);
			const line = v ? describeRepoSync(v) : null;
			if (!line) return null;
			await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: `Upstream sync at end of run: ${line}` }).catch(() => undefined);
			if (v && (v.state === "behind" || v.state === "diverged" || v.state === "ahead")) await postToChat(`**Repository sync at end of run** — ${line}`);
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
		const finalDrain = (await step.do("acts-final-drain", async () => {
			const snap = await callRunner<{ usage?: unknown; acts?: unknown; consumedInputs?: string[] }>(
				conn,
				"/coding/capture",
				// The run is over with this session: release the ownership lease with the closing drain (#1178).
				{ sessionId, drainUsage: true, platformRun: false },
				{ timeoutMs: READ_TIMEOUT_MS },
			).catch(() => null);
			if (!snap) return null;
			// Usage is drained by the same flag, so it has to be banked here too or this call
			// would silently discard the closing turn's spend to record its acts (#267).
			const closingUsageRecords = sanitizeEngineUsage(snap.usage);
			await recordEngineUsage(
				env,
				{ userId, sessionId, instanceId, authResolved: (snap as { authResolved?: EngineAuthResolved | null }).authResolved ?? null },
				closingUsageRecords,
			).catch(() => undefined);
			await appendEngineUsageTimeline(env, { sessionId, instanceId, userId }, closingUsageRecords);
			const closing = sanitizeEngineActs(snap.acts);
			await recordEngineActs(env, { userId, sessionId, instanceId, traceId: event.payload.loopRunId ?? null, cardId: traceCtx.cardId }, closing).catch(() => undefined);
			// A coding run routinely ends WITH the merge, so this drain is where the incident's own
			// shape lands. Nothing is left to halt, but the breach still has to be recorded (#314).
			await recordAuthorityViolations(
				env,
				{ userId, instanceId, sessionId, repoLabel: goal.repo, traceId: event.payload.loopRunId ?? null },
				mergePolicy,
				closing,
			).catch(() => null);
			// A run routinely ends WITH the pull request it opened, so the wrong-org write of
			// #676 lands in exactly this drain. Nothing is left to halt; the breach still has
			// to be recorded, or the run that reported success stays the only account of it.
			await recordRepoScopeViolations(
				env,
				{ userId, instanceId, sessionId, repoLabel: goal.repo, traceId: event.payload.loopRunId ?? null },
				writeScope,
				closing,
			).catch(() => null);
			// The last turn's read receipt often lands only here (#1019): returned, so it is journalled.
			return { consumedInputs: Array.isArray(snap.consumedInputs) ? snap.consumedInputs.filter((x) => typeof x === "string") : [], engine: (snap as CodingPaneSnapshot).engine };
		})) as { consumedInputs: string[]; engine?: CodingPaneSnapshot["engine"] } | null;
		objective?.engine(finalDrain?.engine);
		const lastRead = objective?.observe(finalDrain?.engine);
		if (lastRead) await reportObjective(lastRead);
		// Sent but never confirmed read is reported as such before the run ends (#1019) — never as delivered.
		const unconfirmed = objective?.finish();
		if (unconfirmed) await reportObjective(unconfirmed);
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
				const status = result.outcome === "failed" || result.outcome === "max_steps" || result.outcome === "engine_error" ? "error" : "ended";
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
			// THE RUN'S VERDICT, LAST AND UNCONDITIONAL (#553).
			//
			// The card used to reach a terminal status only as a side effect of `endSession`, i.e.
			// only inside the branch above and only when that call actually MOVED the row. Both
			// conditions failed routinely. A session the HUMAN opened skips the branch entirely, so
			// `csess_22d08431` sat "running" 16 hours after its run died; and where a cron reaper had
			// already closed the row, `endSession` changed nothing and the card kept the reaper's
			// `completed` — which is how two failed runs read as successes. Since #271 a session
			// outliving its run is NORMAL, so a card keyed to session lifetime is structurally wrong
			// rather than occasionally stale.
			//
			// Written from `statusFor`, the same table the loop-run row uses, so the two surfaces
			// describing one run cannot disagree. Unconditional, while every session-side writer is
			// `openOnly` — that asymmetry is what makes "the run outranks the session" a rule rather
			// than a race.
			// …unless the owner's cancellation settled the run first (#1015): that verdict is final.
			const cancelledFirst = event.payload.loopRunId ? (await settledRunStatus(env, event.payload.loopRunId)) === "cancelled" : false;
			await setCodingSessionCardStatus(env, instanceId, userId, sessionId, cancelledFirst ? "cancelled" : statusFor(crashReason ?? stopReasonFor(result.outcome))).catch(() => undefined);
			await appendTimeline(env, { sessionId, instanceId, userId, type: "outcome", content: `${result.outcome}${result.detail ? ` — ${result.detail}` : ""}` });
			// The end, in the trace. Paired with `coding.run.start`: an unmatched start is a run
			// that vanished, which is the shape of every incident in #580 and #546 and was not
			// queryable at all before this.
			await traceCodingRun(env, traceCtx, "coding.run.end", `${result.outcome}${result.detail ? ` — ${result.detail}` : ""}`, {
				outcome: result.outcome,
				stopReason: crashReason ?? stopReasonFor(result.outcome),
				steps: pilotSteps,
			});
			return null;
		});
		// Tell the user the run is over so they can check the results + summary.
		await step.do("notify-end", async () => {
			const cancelledFirst = event.payload.loopRunId ? (await settledRunStatus(env, event.payload.loopRunId)) === "cancelled" : false;
			const ok = runSucceeded(result.outcome) && !cancelledFirst;
			const title = ok ? "✅ Coder finished" : "⚠️ Coder stopped";
			const body = `${goal.repo}: ${result.detail || result.outcome}`;
			// A session ends once. `update` — nothing is waiting on the user, so this is what a
			// "Coder" mute is for.
			await notifyUser(env, userId, "coding", title, body, deepLinkFor({ kind: "coding-session", instanceId, sessionId }), {
				key: `coding-end:${sessionId}`, instanceId,
			}).catch(() => undefined);
			return null;
		});
		// One release note per run that shipped to the trunk, to each granted channel (#1216). Never throws.
		await postReleaseNotes({ env, userId, instanceId, sessionId, repoId, repoLabel: goal.repo, runId: event.payload.loopRunId ?? sessionId, runStartedAt }, undefined, runRetry);
		// #155: close out the observable delegation task on the board (if this was a
		// delegated goal) so its status reflects the real outcome, not a stuck "running".
		// Inline upsert into instance_runtime_tasks (the board's source) — same shape as
		// mirrorRuntimeTask, kept here so the workflow doesn't import a routes module.
		// Close the loop-run row a delegation opened, so ONE surface answers "how did it go"
		// for both delegation kinds. Written here, in the same terminal step that closes the
		// board card, so the two cannot disagree.
		await closeDelegation(result);
		// THE LOCK IS NOW FREE — start whatever was queued behind it (#788).
		//
		// LAST, and after `closeDelegation`, for two reasons that are the same reason: the run
		// that just ended must be fully closed before another can be admitted. The session was
		// ended (or its single-flight claim released) in the `end` step above, so the next
		// start's `claimSessionDriver` can actually succeed; and `finishLoopRun` has written
		// this run's terminal row, so nothing that reads `agent_loop_runs` sees two running runs
		// for one repo.
		//
		// `tryDequeueAndStart` never throws, so no `.catch` here: a queue that cannot be drained
		// is recorded in `error_log` and must not turn a finished run into a failed step.
		const drained = (await step.do("objective-queue-drain", () => tryDequeueAndStart(env, instanceId, repoId, userId))) as { drained?: boolean } | null;
		// #1232/#1233: nothing queued behind it → wake the coder's picker now (triage, else auto-pickup), not at the next hourly window.
		if (drained?.drained !== true) await step.do("idle-coder-wake", () => wakeIdleCoder(env, instanceId, userId));
	}
	return result;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
