import type { WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import {
	decideCodingAction,
	runCodingLoop,
	type CodingActionKind,
	type CodingDecision,
	type CodingDeps,
	type CodingPaneSnapshot,
	type CodingResult,
} from "../../lib/coding-loop.js";
import { callRunner, getRunnerConnIgnoringLiveness, getBoundRunnerConn, relayConnected, READ_TIMEOUT_MS, type RunnerConn } from "../../lib/runner-client.js";
import { runtimeConnectivity } from "../../lib/instance-connectivity.js";
import type { CodingSessionParams } from "../coding-session-params.js";
import { makeRunnerGuard, noRunnerDetail, RUNNER_PROBE_INTERVAL, type RunStep } from "../../lib/runner-availability.js";
import { getRepo, releaseSessionDriver, touchSessionActivity, touchSessionDriver } from "../../lib/coding-store.js";
import { setCodingSessionCardStatus } from "../../lib/coding-board.js";
import { startSessionOnRunnerConn } from "../../lib/coding-session-relaunch.js";
import { resolvePause, stopReasonFor, type PauseDeps } from "../../lib/coding-pause.js";
import { awaitEngineIdle, durableIdleDeps, idleWaitIsDurable, shouldTouchActivity } from "../../lib/coding-idle-poll.js";
import { accountTimeZone } from "../../lib/account-timezone.js";
import type { EngineWaitState } from "../../lib/coding-wait.js";
import { normalizeRunnerNode } from "../../lib/runtime-nodes.js";
import { appendTimeline } from "../../lib/coding-timeline.js";
import { delegationTaskRecord } from "../../lib/delegation.js";
import { codingSessionLink } from "../../lib/console-links.js";
import { notifyUser } from "../../routes/push.js";
import { recordEngineUsage } from "../../lib/usage.js";
import { decideWithinBudget } from "../../lib/coding-decide-budget.js";
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
import { actsInWindow } from "../../lib/instance-work.js";
import { annotateOwnerAttribution } from "../../lib/run-attribution.js";
import { finishLoopRun, isCancelRequested, recordIteration, recordLiveness, type RunWaitReason } from "../../lib/agent-loop-store.js";
import { reauthCompletedSince } from "../../lib/engine-reauth-store.js";
import { tryDequeueAndStart } from "../../lib/objective-queue-start.js";
import { traceCodingRun } from "../../lib/coding-run-trace.js";
import { codingCrashReport, outcomeWord, runOutcomeNote } from "../../lib/coding-run-report.js";
import { pendingCodingResumeNote } from "../../lib/coding-resume-note.js";
import { describeRepoState, readRepoWorkingState, type RepoWorkingState } from "../../lib/repo-state.js";
import { describeRepoSync, readRepoSync, type RepoSyncVerdict } from "../../lib/repo-sync.js";
import { attemptSyncSelfHeal, describeSyncHeal, gateRunOnSync, repairCheckoutObjective, skippedSyncHeal, syncSelfHealEligible, type SyncGateOutcome, type SyncHealOutcome } from "../../lib/repo-sync-gate.js";
import { statusFor, type LoopStopReason } from "../../lib/agent-loop.js";
import { PILOT_DEFAULT_MAX_STEPS } from "../../lib/loop-limits.js";
import { CodingRunProbe, recordCodingFailure } from "../../lib/coding-failure.js";
import { planInterruptionResume, roundThroughInterruptions, type InterruptionResume } from "../../lib/coding-interrupt.js";
import { postSystemMessage } from "../../lib/instance-system-message.js";
import { withTurnReplay } from "../../lib/coding-turn-replay.js";
import { upsertWorkCard } from "../../lib/work-card.js";
import { setWorkCardProgress } from "../../lib/work-card.js";
import type { Env } from "../../types.js";

export async function runCodingSessionWorkflow(env: Env, event: WorkflowEvent<CodingSessionParams>, step: WorkflowStep): Promise<CodingResult> {
	const { instanceId, userId, sessionId, repoId, runnerNode, cloneUrl, branch, token, tokenUsername, goal } = event.payload;
	const runStartedAt = (await step.do("run-started-at", async () => Date.now())) as number;
	const mergePolicy = (await step.do("merge-authority", () => readMergePolicyForRun(env, { instanceId, userId, repoId }))) as MergePolicy;
	goal.mergePolicy = mergePolicy;
	const writeScope = (await step.do("repo-write-scope", () => registeredRepoSlugs(env, instanceId, userId))) as string[];
	goal.timeZone = ((await step.do("owner-timezone", async () => (await accountTimeZone(env, userId)) ?? null)) as string | null) ?? undefined;
	const authorityNote = describeAuthority(mergePolicy, goal.clientType);
	let startConn = await getRunnerConnIgnoringLiveness(env, instanceId, userId, runnerNode ?? null);
	const live = await relayConnected(env, instanceId, runnerNode ?? null).catch(() => false);
	if (!live) {
		const fallback = await getBoundRunnerConn(env, instanceId, userId);
		if (fallback && normalizeRunnerNode(fallback.runnerNode) !== normalizeRunnerNode(runnerNode)) {
			await (await import("../../lib/coding-store.js")).reassignSessionNode(env, instanceId, userId, sessionId, fallback.runnerNode ?? null).catch(() => undefined);
			startConn = fallback;
		}
	}
	let pilotSteps = 0;
	let pilotThoughts = 0;
	let ownerTurns = 0;
	const probe = new CodingRunProbe();
	const traceCtx = { userId, instanceId, sessionId, runId: event.payload.loopRunId ?? null, repo: goal.repo };
	let crashReason: LoopStopReason | null = null;
	let lastActivityTouchAt = 0;
	const postToChat = (content: string) => postSystemMessage(env, instanceId, content).catch(() => undefined);
	const closeDelegation = async (outcome: CodingResult, suffix = "") => {
		const acts = event.payload.loopRunId || event.payload.boardTaskId
			? await actsInWindow(env, userId, instanceId, sessionId, runStartedAt, Date.now()).catch(() => [])
			: [];
		const actLine = summarizeActs(acts);
		const detail = annotateOwnerAttribution(outcome.detail ?? "", ownerTurns);
		const reason = crashReason ?? stopReasonFor(outcome.outcome);
		const note = runOutcomeNote({
			outcome: outcomeWord(outcome.outcome, reason),
			detail,
			breach: [
				...unauthorizedActs(mergePolicy, acts).map((a) => describeViolation(mergePolicy, a)),
				...unscopedWrites(writeScope, acts).map(({ act, refused }) => describeRepoScopeViolation(refused, writeScope, act)),
			].join(" "),
			authorityNote,
			actLine,
		});
		if (event.payload.loopRunId) {
			await step.do(`delegation-run-done${suffix}`, async () => {
				await recordIteration(env, event.payload.loopRunId as string, Math.max(pilotSteps, outcome.steps ?? 0)).catch(() => undefined);
				await finishLoopRun(env, event.payload.loopRunId as string, reason, note, Date.now());
				const ok = reason === "done";
				await postToChat(`${ok ? "**Loop complete**" : `**Loop stopped** (${reason})`}${detail ? `\n\n${detail}` : ""}${actLine ? `\n\n${actLine}` : ""}`);
			});
		}
		if (event.payload.boardTaskId) {
			await step.do(`delegation-task-done${suffix}`, async () => {
				const task = delegationTaskRecord({
					id: event.payload.boardTaskId as string,
					targetLabel: goal.repo,
					objective: goal.objective,
					status: statusFor(crashReason ?? stopReasonFor(outcome.outcome)),
					now: new Date().toISOString(),
					note,
					acts,
				});
				await upsertWorkCard(env, { instanceId, userId, id: event.payload.boardTaskId as string, task });
				return null;
			});
		}
	};
	if (!startConn) {
		const detail = noRunnerDetail(await runtimeConnectivity(env, instanceId, userId).catch(() => null));
		const noRunner: CodingResult = { outcome: "failed", detail, steps: 0 };
		await closeDelegation(noRunner, "-no-runner");
		if (event.payload.driverId) {
			await releaseSessionDriver(env, instanceId, userId, sessionId, event.payload.driverId);
		}
		return noRunner;
	}
	let conn: RunnerConn = startConn;
	const retry = { retries: { limit: 2, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "3 minutes" as const };
	const idleRetry = { retries: { limit: 1, delay: "2 seconds" as const, backoff: "constant" as const }, timeout: "10 minutes" as const };
	const startRetry = { retries: { limit: 1, delay: "3 seconds" as const, backoff: "constant" as const }, timeout: "5 minutes" as const };
	type LooseDo = (name: string, opts: unknown, cb: () => Promise<unknown>) => Promise<unknown>;
	const runWith = (opts: unknown): RunStep => (name, fn) => (step.do as unknown as LooseDo)(probe.at(name), opts, fn);
	const runRetry = runWith(retry);
	const runIdle = runWith(idleRetry);
	let n = 0;
	const startOnRunner = () =>
		startSessionOnRunnerConn(env, conn, { instanceId, userId, sessionId, repoId, clientType: goal.clientType, cloneUrl, branch, token, tokenUsername });
	const guard = makeRunnerGuard({
		wait: {
			probe: () => runtimeConnectivity(env, instanceId, userId),
			sleep: (label: string) => step.sleep(label, RUNNER_PROBE_INTERVAL),
			announce: postToChat,
			tick: async () => {
				if (event.payload.driverId) await touchSessionDriver(env, instanceId, userId, sessionId, event.payload.driverId).catch(() => undefined);
				await touchSessionActivity(env, instanceId, userId, sessionId).catch(() => undefined);
			},
		},
		reconnect: async (label: string) => {
			const back = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
			if (back) {
				if (normalizeRunnerNode(back.runnerNode) !== normalizeRunnerNode(conn.runnerNode)) {
					await (await import("../../lib/coding-store.js")).reassignSessionNode(env, instanceId, userId, sessionId, back.runnerNode ?? null).catch(() => undefined);
				}
				conn = back;
			}
			await runWith(startRetry)(`restart-${label}`, startOnRunner);
		},
	});
	const capture = async (): Promise<CodingPaneSnapshot & { sessionId: string }> => {
		const [snap, row, cancelRequested] = await Promise.all([
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
			event.payload.loopRunId
				? isCancelRequested(env, event.payload.loopRunId).catch(() => false)
				: Promise.resolve(false),
		]);
		const { usage, acts, ...pane } = snap;
		const pilotUsageRecords = sanitizeEngineUsage(usage);
		await recordEngineUsage(
			env,
			{ userId, sessionId, instanceId, authResolved: (snap as { authResolved?: EngineAuthResolved | null }).authResolved ?? null },
			pilotUsageRecords,
		);
		const { appendEngineUsageTimeline } = await import("../../lib/coding-timeline.js");
		await appendEngineUsageTimeline(env, { sessionId, instanceId, userId }, pilotUsageRecords);
		const reported = sanitizeEngineActs(acts);
		await recordEngineActs(
			env,
			{ userId, sessionId, instanceId, traceId: event.payload.loopRunId ?? null },
			reported,
		).catch(() => undefined);
		const stopReason = await recordAuthorityViolations(
			env,
			{ userId, instanceId, sessionId, repoLabel: goal.repo, traceId: event.payload.loopRunId ?? null },
			mergePolicy,
			reported,
		).catch(() => null);
		if (stopReason) return { ...pane, cancelled: true, stopReason };
		const scopeStop = await recordRepoScopeViolations(
			env,
			{ userId, instanceId, sessionId, repoLabel: goal.repo, traceId: event.payload.loopRunId ?? null },
			writeScope,
			reported,
		).catch(() => null);
		if (scopeStop) return { ...pane, cancelled: true, stopReason: scopeStop };
		if (shouldTouchActivity(lastActivityTouchAt, Date.now())) {
			lastActivityTouchAt = Date.now();
			await touchSessionActivity(env, instanceId, userId, sessionId).catch(() => undefined);
			if (event.payload.loopRunId) await recordLiveness(env, event.payload.loopRunId, Date.now(), null).catch(() => undefined);
		}
		const { pilotStopSignal } = await import("../../lib/coding-session-lifecycle.js");
		const stop = pilotStopSignal({ sessionStatus: row?.status, cancelRequested });
		return stop.stop ? { ...pane, cancelled: true, stopReason: stop.reason } : pane;
	};
	const measured = async (p: Promise<unknown>): Promise<CodingPaneSnapshot> => {
		const pane = (await p) as CodingPaneSnapshot;
		probe.saw(pane?.pane);
		return pane;
	};
	const deps: CodingDeps = {
		snapshot: () => measured(guard(runRetry, `s${n++}-snapshot`, capture)),
		act: (a: CodingActionKind) =>
			measured(guard(runRetry, `s${n++}-act`, async () => callRunner<CodingPaneSnapshot>(conn, "/coding/act", { sessionId, action: await withTurnReplay(env, { instanceId, userId, repoId, repoName: goal.repo, clientType: goal.clientType }, a) }))),
		decide: (p) =>
			step.do(probe.at(`s${n++}-decide`), retry, () =>
				decideWithinBudget(env, { userId, instanceId, budgetId: event.payload.budgetId, depth: event.payload.depth }, () =>
					decideCodingAction(env, userId, p, { kind: "coding", instanceId, traceId: event.payload.loopRunId ?? sessionId }),
				),
			) as Promise<CodingDecision>,
		waitIdle: () => {
			const label = `s${n++}-waitidle`;
			const sleepFn = (ms: number) => step.sleep(`${label}-sleep`, ms);
			return measured(
				idleWaitIsDurable(env)
					? awaitEngineIdle(durableIdleDeps({ label, capture: (name) => guard(runRetry, name, capture), sleep: (name, ms) => step.sleep(name, ms) }))
					: guard(runIdle, label, () => awaitEngineIdle({ capture, sleep: sleepFn })),
			);
		},
		onEvent: (type, message, data) => {
			const at = type === "action" ? ++pilotSteps : pilotSteps;
			const driven = type === "action" && (data as CodingActionKind | undefined)?.kind === "message" ? (data as { text: string }).text : "";
			probe.drove(driven);
			const postProgress = type === "thought" && (++pilotThoughts === 1 || pilotThoughts % 4 === 0);
			return step.do(`s${n++}-event`, async () => {
				await callRunner(conn, "/coding/event", { sessionId, type, message, data }).catch(() => undefined);
				if (type === "action" && event.payload.loopRunId) {
					await recordIteration(env, event.payload.loopRunId, at).catch(() => undefined);
				}
				if (postProgress && event.payload.boardTaskId) {
					await setWorkCardProgress(env, instanceId, userId, event.payload.boardTaskId, message);
				}
				if (type === "refused") await postToChat(`**Merge authority** — instruction not sent to the engine: ${message}`);
				if (type === "empty" || type === "repeated") await postToChat(`**Loop** — ${message}`);
				if (type === "action" && event.payload.loopRunId) {
					await postToChat(`**Loop → engine** (step ${at}): ${message}`);
				}
				if (driven || type === "learned") await appendTimeline(env, { sessionId, instanceId, userId, type: driven ? "command" : "brain", content: driven || message }).catch(() => undefined);
				if (type === "action" && event.payload.driverId) {
					await touchSessionDriver(env, instanceId, userId, sessionId, event.payload.driverId);
				}
				return null;
			}).then(() => undefined);
		},
	};
	const waitState: EngineWaitState = { waits: 0, spentMs: 0 };
	const pauseDeps = (round: number, wait: RunWaitReason): PauseDeps => ({
		repo: goal.repo,
		timeZone: goal.timeZone,
		instanceId,
		taskId: event.payload.boardTaskId,
		now: () => Date.now(),
		takeover: (label, reason) => runRetry(`handoff-${round}`, () => callRunner(conn, "/coding/takeover", { sessionId, label, reason })).then(() => undefined),
		takeoverStatus: () =>
			runRetry(`hstatus-${round}-${n++}`, () => callRunner(conn, "/coding/takeover-status", { sessionId })) as Promise<{ resolved: boolean; value?: string }>,
		endTakeover: () => runRetry(`resume-${round}`, () => callRunner(conn, `/coding/takeover/${encodeURIComponent(sessionId)}/end`, {})).then(() => undefined),
		reauthCompletedSince: (since) => reauthCompletedSince(env, instanceId, userId, since),
		restartEngine: () => runRetry(`reauth-end-${round}`, () => callRunner(conn, "/coding/end", { sessionId })).then(() => runRetry(`reauth-start-${round}`, () => startOnRunner())).then(() => undefined),
		sleep: (label: string | number, ms?: number) => {
			const actualMs = typeof label === "number" ? label : (ms ?? 0);
			const actualLabel = typeof label === "string" ? label : `pause-${round}`;
			return step.sleep(actualLabel, actualMs);
		},
		notify: (title, body, key, alert, url) =>
			runRetry(`notify-${key}-${round}`, async () => {
				const opts = { key: `${key}:${sessionId}`, kind: alert ? ("alert" as const) : undefined, instanceId };
				return await notifyUser(env, userId, "coding", title, body, url ?? codingSessionLink(instanceId, sessionId), opts).then(() => null, () => null);
			}).then(() => undefined),
		announce: postToChat,
		card: (status) => setCodingSessionCardStatus(env, instanceId, userId, sessionId, status).catch(() => undefined),
		tick: async (park) => {
			const { driverId, loopRunId } = event.payload;
			if (driverId) await touchSessionDriver(env, instanceId, userId, sessionId, driverId).catch(() => undefined);
			await touchSessionActivity(env, instanceId, userId, sessionId).catch(() => undefined);
			if (!loopRunId) return true;
			await recordLiveness(env, loopRunId, Date.now(), { reason: wait, until: park?.until ?? null }).catch(() => undefined);
			return !(await isCancelRequested(env, loopRunId).catch(() => false));
		},
	});
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
	try {
		await guard(runWith(startRetry), "start", startOnRunner);
		const repoStart = (await step.do("repo-state-start", async () => {
			const repo = await getRepo(env, instanceId, userId, repoId).catch(() => null);
			if (!repo) return { state: null, sync: null };
			const [state, sync] = await Promise.all([
				readRepoWorkingState(conn, { repo, sessionId }).catch(() => null),
				readRepoSync(conn, { workDir: repo.workdir, sessionId, branch: repo.branch, forceFetch: true }).catch(() => null),
			]);
			return { state: state ?? null, sync: sync ?? null };
		})) as { state: RepoWorkingState | null; sync: RepoSyncVerdict | null };
		const repoState = repoStart.state;
		const heal = (await step.do("repo-self-heal", async () => {
			const eligible = syncSelfHealEligible(repoStart.sync, repoStart.state, branch ?? null);
			if (!eligible.eligible || !eligible.branch) return skippedSyncHeal(eligible);
			const repo = await getRepo(env, instanceId, userId, repoId).catch(() => null);
			if (!repo) return null;
			return attemptSyncSelfHeal(conn, { repo, sessionId, branch: eligible.branch });
		})) as SyncHealOutcome | null;
		const syncAtStart = heal?.sync ?? repoStart.sync;
		const stateNote = repoState ? describeRepoState(repoState, { configuredBranch: branch ?? null }) : null;
		const syncNote = syncAtStart ? describeRepoSync(syncAtStart) : null;
		const repair = goal.repairCheckout === true;
		if (repair) {
			goal.objective = repairCheckoutObjective({ repoLabel: goal.repo, branch: branch ?? null, sync: syncAtStart, state: repoState, heal, ownerNote: goal.objective });
		}
		if (!repair && (stateNote || syncNote)) {
			goal.specialInstructions = [
				goal.specialInstructions,
				stateNote
					? `REPOSITORY STATE (read before you start): ${stateNote} You did not create this state. Do NOT revert, stash, reset or discard anything you did not write yourself. If your objective needs a clean tree or a different branch, say so and stop rather than clearing it.`
					: "",
				syncNote
					? `UPSTREAM SYNC (checked just now, nothing was pulled): ${syncNote} If the checkout is BEHIND and the tree is clean and on its configured branch, make your FIRST instruction a fast-forward (\`git pull --ff-only\`) so you never plan against a stale base, and say in your report what it brought in. If it is dirty or has diverged, do not merge or rebase on your own initiative — report it and ask.`
					: "",
			]
				.filter(Boolean)
				.join("\n\n");
		}
		const syncGate = (await step.do("repo-sync-gate", async () =>
			gateRunOnSync(env, { instanceId, userId, sessionId, node: conn.runnerNode ?? null, repo: goal.repo, heal, repair }, syncAtStart),
		)) as SyncGateOutcome;
		if (syncGate.blocked) result = { outcome: "failed", detail: syncGate.message, steps: 0 };
		const resumeNote = (await step.do("resume-note", async () => (await pendingCodingResumeNote(env, { userId, instanceId, sessionId, uncommittedFiles: repair ? 0 : (repoState?.changedFiles ?? 0), lookbackMs: event.payload.resumeLookbackMs })) ?? null)) as string | null;
		if (resumeNote) goal.resumeNote = resumeNote;
		await step.do("tl-start", async () => {
			if (resumeNote) await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: resumeNote });
			if (heal && heal.status !== "skipped") {
				await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: describeSyncHeal(heal) });
				await traceCodingRun(env, traceCtx, "coding.run.self_heal", describeSyncHeal(heal), { status: heal.status, commits: heal.commits, from: heal.from, to: heal.to });
				if (heal.status === "healed") await postToChat(`**Repository fast-forwarded** — ${describeSyncHeal(heal)}`);
			}
			if (syncNote) {
				await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: `Upstream sync at start: ${syncNote}` });
				if (syncAtStart?.state === "behind" || syncAtStart?.state === "diverged") await postToChat(`**Repository sync at start** — ${syncNote}`);
			}
			if (syncGate.blocked) {
				await appendTimeline(env, { sessionId, instanceId, userId, type: "brain", content: syncGate.message });
				await traceCodingRun(env, traceCtx, "coding.run.blocked", syncGate.message);
				await postToChat(`**Cannot start run** — ${syncGate.message}`);
			}
			return null;
		});
		for (let round = 0; round < 12; round++) {
			result = await roundThroughInterruptions(
				() => runCodingLoop(deps, goal, { maxSteps: event.payload.maxSteps ?? PILOT_DEFAULT_MAX_STEPS }),
				roundDeps,
				{ next: () => ++interruptions },
			);
			goal.userHint = undefined;
			goal.resumeNote = undefined;
			const parkReason: RunWaitReason = result.outcome === "waiting" ? "engine_limit" : result.outcome === "needs_reauth" ? "engine_auth" : "human";
			const pause = await resolvePause(pauseDeps(round, parkReason), { round, result, state: waitState });
			if (!pause.resume) {
				result = pause.result;
				break;
			}
			if (pause.ownerTurn) ownerTurns++;
			goal.userHint = pause.userHint;
			goal.ownerTurns = ownerTurns;
			goal.resumeNote = pause.resumeNote;
		}
	} catch (e) {
		const crash = codingCrashReport(e);
		crashReason = crash.stopReason;
		result = { outcome: "failed", detail: crash.detail, steps: result.steps, transcript: result.transcript };
		await recordCodingFailure(env, {
			err: e, userId, instanceId, sessionId, probe, steps: pilotSteps, startedAt: runStartedAt, repo: goal.repo,
			node: conn.runnerNode ?? null, runId: event.payload.loopRunId ?? null, taskId: event.payload.boardTaskId ?? null, disposition: "ended",
		}).catch(() => undefined);
	} finally {
		await closeDelegation(result);
		await step.do("objective-queue-drain", async () => {
			await tryDequeueAndStart(env, instanceId, repoId, userId);
			return null;
		});
	}
	return result;
}
