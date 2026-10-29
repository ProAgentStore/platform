/**
 * The pause machine's side effects for the coding Workflow (#1359): what `resolvePause` (`lib/coding-pause.ts`) is handed to take
 * over, ask a question, park at zero compute, resume, notify and heartbeat.
 *
 * Moved out of `workflow-run.ts` unchanged. It keeps the three pieces of park state only it reads and writes — the question being
 * waited on, the row its answer comes from, and the count of resume attempts — and takes the workflow's machine connection, step
 * counter and objective delivery as accessors, because the workflow reassigns them. Every step name it emits is frozen by
 * `workflow-step-names.test.ts`.
 */
import type { WorkflowStep } from "cloudflare:workers";
import { captureAndAnnounceQuestion, HUMAN_ONLY_WAIT_MS } from "../../lib/coder-question-sweep.js";
import { markAnswerApplied } from "../../lib/coder-question-store.js";
import { codingPauseStatus } from "../../lib/coding-answer.js";
import { answerEventType, recordParkedWorkflow, recordParkMachine, releaseCheckout, resumeFromPark } from "../../lib/coding-park.js";
import { askAnnouncement, whyBeyond } from "../../lib/coding-ask.js";
import { clipMarked } from "../../lib/clip-marked.js";
import { traceCodingRun, type CodingRunEvent } from "../../lib/coding-run-trace.js";
import { readLoopLimits } from "../../lib/loop-limits-store.js";
import { commandEngineParts } from "../../lib/coding-command.js";
import { modelFlagEngine, readEngineModel, writeEngineModel } from "../../lib/coding-engine-model.js";
import { type ProviderRetryPolicy, resolveProviderRetry } from "../../lib/provider-retry.js";
import { codingQuestionSource } from "../../lib/coding-question-source.js";
import { postIssueComment } from "../../lib/github-issues.js";
import { applyQuestionsPolicy, runQuestionsPolicy } from "../../lib/question-policy.js";
import type { CodingGoal } from "../../lib/coding-loop.js";
import { callRunner, getRunnerConnIgnoringLiveness, type RunnerConn } from "../../lib/runner-client.js";
import type { RunStep } from "../../lib/runner-availability.js";
import type { ObjectiveDelivery } from "../../lib/coding-objective-delivery.js";
import { getSession, setSessionLaunchCommand, touchSessionActivity, touchSessionDriver } from "../../lib/coding-store.js";
import type { PauseDeps } from "../../lib/coding-pause.js";
import { setCodingSessionCardStatus } from "../../lib/coding-board.js";
import { normalizeRunnerNode } from "../../lib/runtime-nodes.js";
import { deepLinkFor } from "../../lib/console-links.js";
import { notifyUser } from "../../routes/push.js";
import { recordEngineActs, sanitizeEngineActs } from "../../lib/engine-acts.js";
import { isCancelRequested, recordLiveness, type RunWaitReason, type WaitingAsk } from "../../lib/agent-loop-store.js";
import { mirrorRuntimeEvent } from "../../routes/instances-runtime.js";
import { reauthCompletedSince } from "../../lib/engine-reauth-store.js";
import { tryDequeueAndStart } from "../../lib/objective-queue-start.js";
import type { Env } from "../../types.js";

export interface PauseEffectsCtx {
	env: Env;
	step: WorkflowStep;
	goal: CodingGoal;
	instanceId: string;
	userId: string;
	sessionId: string;
	repoId: string;
	boardTaskId: string | undefined;
	loopRunId: string | null | undefined;
	driverId: string | null | undefined;
	/** This Workflow instance's id, recorded on a park so the registration route can wake it. */
	workflowInstanceId: string | undefined;
	cloneUrl: string | undefined;
	branch: string | undefined;
	token: string | undefined;
	tokenUsername: string | undefined;
	/** The board card the run reports on, for the acts' trace. */
	cardId: string | null;
	runRetry: RunStep;
	postToChat: (content: string) => Promise<void>;
	/** The machine this run is talking to — read at call time, because the runner guard and a resume re-point it. */
	getConn: () => RunnerConn;
	setConn: (conn: RunnerConn) => void;
	/** The workflow's step counter: `s${n}-…` names must stay unique across the whole run. */
	nextN: () => number;
	startOnRunner: () => Promise<unknown>;
	getObjective: () => ObjectiveDelivery | null;
}

export interface PauseEffects {
	/** The effects for one pause round, parked for the given reason. */
	deps: (round: number, wait: RunWaitReason) => PauseDeps;
	/** The park ended: forget the question it was waiting on. */
	clearAsk: () => void;
	/**
	 * Put the session's own model back after a fallback (#1392), at the end of the run. A no-op when the run never switched. With `endEngine` the runner's
	 * engine is ended too, so the next use of a session that outlives the run relaunches on the configured model instead of inheriting the fallback.
	 */
	restoreFallback: (opts: { endEngine: boolean }) => Promise<void>;
}

export function makePauseEffects(ctx: PauseEffectsCtx): PauseEffects {
	const { env, step, goal, instanceId, userId, sessionId, repoId, boardTaskId, loopRunId, driverId, workflowInstanceId, cloneUrl, branch, token, tokenUsername, cardId, runRetry, postToChat, getConn, setConn, nextN, startOnRunner, getObjective } = ctx;
	/** The question a `decision` park is waiting on (#960), set by `ask` and carried by every tick of that park. */
	let parkedAsk: WaitingAsk | null = null;
	/** The instance's provider-retry policy, read once per run and only when a transient park needs it (#1391). */
	let retryPolicy: { policy: ProviderRetryPolicy; seed?: string } | null = null;
	/** The session's launch command before the run switched its model (#1392), or null when it never did. Set from a JOURNALLED read, so a replay agrees. */
	let originalCommand: string | null = null;
	let switchedTo: string | null = null;
	/** The `coder_questions` row that park's answer is read from (#1075); null for a takeover with no question. */
	let parkedQuestionId: string | null = null;
	/** Resume attempts on a park (#1077): each its own step, since a busy checkout is a retry, not a journalled answer. */
	let unparks = 0;
	const deps = (round: number, wait: RunWaitReason): PauseDeps => ({
		repo: goal.repo,
		sourceIssue: () => codingQuestionSource(env, { instanceId, userId, sessionId, runId: loopRunId ?? null }, { askedAt: Date.now() }),
		timeZone: goal.timeZone,
		// Read lazily and JOURNALLED, and only on a transient park (#1391): a run that never meets a provider outage takes no extra step, and a replay of a
		// park that did reads the policy the first pass chose even if the owner changed it meanwhile (the number of sleeps depends on it).
		providerRetry: async () => {
			if (!retryPolicy) {
				const stored = (await runRetry("provider-retry-policy", async () => ((await readLoopLimits(env, instanceId, userId).catch(() => ({}))) as { providerRetry?: unknown }).providerRetry ?? null)) as Record<string, number> | null;
				retryPolicy = { policy: resolveProviderRetry(stored), seed: loopRunId ?? sessionId };
			}
			return retryPolicy;
		},
		// The configured fallback (#1392): the model rewritten in the session's stored launch command, the engine ended and started on it. Every step is
		// journalled, the command it replaces is read through a journalled step (so a replay still knows the ORIGINAL), and a failed restart puts the old
		// command back so nothing is left half-switched.
		switchModel: async (model) => {
			const cmd = (await runRetry(`fallback-read-${round}`, async () => (await getSession(env, instanceId, userId, sessionId))?.launchCommand ?? null)) as string | null;
			if (!cmd) return { ok: false, why: "the session has no recorded launch command to change" };
			if (!modelFlagEngine(cmd)) return { ok: false, why: `the engine's command (${commandEngineParts(cmd).bin || "unknown"}) takes no --model flag` };
			const from = readEngineModel(cmd);
			if (from === model) return { ok: false, why: `the session already runs ${model}` };
			const next = writeEngineModel(cmd, model);
			if (next === cmd) return { ok: false, why: "the model could not be written into the launch command" };
			try {
				await runRetry(`fallback-set-${round}`, async () => {
					await setSessionLaunchCommand(env, instanceId, userId, sessionId, next);
					return null;
				});
				originalCommand ??= cmd;
				await runRetry(`fallback-end-${round}`, () => callRunner(getConn(), "/coding/end", { sessionId }));
				getObjective()?.replaced();
				await runRetry(`fallback-start-${round}`, () => startOnRunner());
			} catch (e) {
				await setSessionLaunchCommand(env, instanceId, userId, sessionId, cmd).catch(() => undefined);
				return { ok: false, why: `the restart on ${model} failed: ${e instanceof Error ? clipMarked(e.message, 200, { within: true }) : String(e)}` };
			}
			switchedTo = model;
			return { ok: true, from };
		},
		// One structured fact on the run's durable trace, once however often the park replays (#1391).
		trace: async (name, message, data) => {
			await runRetry(`ptrace-${round}-${name.replace("provider_", "")}-${String(data.attempt ?? 0)}`, async () => {
				await traceCodingRun(env, { userId, instanceId, sessionId, runId: loopRunId ?? null, repo: goal.repo, cardId }, `coding.run.${name}` as CodingRunEvent, message, data);
				return null;
			});
		},
		instanceId,
		taskId: boardTaskId,
		sessionId,
		now: () => Date.now(),
		// Journalled (#1362): a park's plan must be the same plan on every replay — see `PauseDeps.stamp`.
		stamp: (label) => runRetry(label, async () => Date.now()) as Promise<number>,
		// `questions: decide` (#1385). The run's setting is immutable, so it is read plainly here — and ONLY a `decide` run takes the journalled step below,
		// so an `ask` run's step sequence is exactly what it was (the goldens in workflow-step-names.test.ts). The step records the decision and posts it on
		// the issue once: a replay returns the journalled verdict instead of deciding, recording and commenting a second time.
		questionPolicy: loopRunId
			? async (q) => {
					if ((await runQuestionsPolicy(env, loopRunId)) !== "decide") return { decided: false };
					return (await runRetry(`decide-${round}`, () =>
						applyQuestionsPolicy(env, { runId: loopRunId, instanceId, userId, round, issue: q.issue, postComment: (repo, number, body) => postIssueComment(env, userId, repo, number, body), constraintTexts: [goal.objective, goal.userHint, goal.standingInstructions, ...(goal.ownerDirectives ?? []).map((d) => d.text)] }, { question: q.question, options: q.options }),
					)) as { decided: true; note: string } | { decided: false };
				}
			: undefined,
		takeover: (label, reason) => {
			parkedQuestionId = null;
			return runRetry(`handoff-${round}`, () => callRunner(getConn(), "/coding/takeover", { sessionId, label, reason })).then(() => undefined);
		},
		// A QUESTION, published (#960): the `agent.needs_input` event on the card — the console's answer
		// box reads it, options as a `from:` list — and the `decision` park with the ask on the run, at
		// once rather than at the first tick, so coding_loop_status says what is being asked now.
		ask: (ask) => {
			// Set OUTSIDE the step: a replay returns a journalled step without re-running its body,
			// and the ticks of this park read `parkedAsk` to keep the question on the run.
			parkedAsk = ask;
			return runRetry(`ask-${round}`, async () => {
				const from = ask.options.length ? `from: ${ask.options.join(", ")}` : "";
				const why = [ask.why, from].filter(Boolean).join(" — ");
				await mirrorRuntimeEvent(env, instanceId, userId, {
					id: `${ask.taskId}:needs_input:${round}`,
					taskId: ask.taskId,
					type: "agent.needs_input",
					message: `Needs your input — ${ask.field}${why ? ` (${why})` : ""}`,
					// The uncut question and a multi-part ask's decisions (#1129) ride beside the phone-sized
					// field, for the ticket page's "show the full question" and its button group per decision.
					data: { field: ask.field, why, options: ask.options, sessionId, ...(ask.fullQuestion ? { fullQuestion: ask.fullQuestion } : {}), ...(ask.parts?.length ? { parts: ask.parts } : {}), ...(ask.issue ? { issue: ask.issue } : {}), ...(ask.issueStatus ? { issueStatus: ask.issueStatus } : {}) },
					createdAt: new Date().toISOString(),
				});
				if (loopRunId) await recordLiveness(env, loopRunId, Date.now(), { reason: "decision", ask });
				// #1025: the question, durably — posted on the issue, timed by the minute sweep. Inside
				// the step, so a replay returns the journalled wait instead of capturing it twice.
				const captured = await captureAndAnnounceQuestion(env, { instanceId, userId, sessionId, runId: loopRunId ?? null, taskId: ask.taskId, question: askAnnouncement(ask), options: ask.options, why: whyBeyond(askAnnouncement(ask), ask.why) }).catch(() => null);
				return captured ? { waitMs: captured.waitMs, humanMs: captured.humanMs, brain: captured.waitMs > HUMAN_ONLY_WAIT_MS, questionId: captured.question.id } : null;
			}).then((w) => {
				parkedQuestionId = (w as { questionId?: string } | null)?.questionId ?? null; // journalled, so a replay knows the row too
				return w;
			});
		},
		// #1075: the answer is read from the question's ROW first, so it survives a runner restart.
		takeoverStatus: () => runRetry(`hstatus-${round}-${nextN()}`, () => codingPauseStatus(env, getConn(), sessionId, parkedQuestionId)) as Promise<{ resolved: boolean; value?: string }>,
		// #1076: a captured question parks at zero compute; only a run with a loop-run row can be woken.
		park: loopRunId
			? {
					begin: (_questionId, until, opts) =>
						runRetry(`park-${round}`, async () => {
							const runId = loopRunId as string;
							await recordParkedWorkflow(env, runId, workflowInstanceId ?? runId);
							await recordLiveness(env, runId, Date.now(), { reason: "decision", until, ask: parkedAsk });
							// The engine PROCESS stops; its session row and its resume key stay. Its last acts are drained like the terminal path's.
							const ended = await callRunner<{ acts?: unknown }>(getConn(), "/coding/end", { sessionId }).catch(() => null);
							await recordEngineActs(env, { userId, sessionId, instanceId, traceId: runId, cardId: cardId }, sanitizeEngineActs(ended?.acts)).catch(() => undefined);
							// #1242: where this park's work is — it resumes on that machine and nowhere else.
							await recordParkMachine(env, { runId, instanceId, userId, sessionId, repoId }, getConn());
							if (opts?.keepCheckout) return { announce: "Its checkout and working tree stay exactly as they are while it waits for you.", released: false }; // #1236
							// #1077: let go of the checkout (its work set aside first), so queued work runs while this waits.
							const r = await releaseCheckout(env, getConn(), { runId, instanceId, userId, sessionId, repoId });
							return { announce: r.line, onStop: r.onStop, released: r.released };
						}).then(async (r) => {
							const p = r as { announce?: string; onStop?: string; released?: boolean };
							if (p.released) await runRetry(`park-drain-${round}`, async () => {
								await tryDequeueAndStart(env, instanceId, repoId, userId);
								return null;
							});
							return p;
						}),
					wait: (questionId, k, timeoutMs) => step.waitForEvent(`answer-${round}-${k}`, { type: answerEventType(questionId), timeout: timeoutMs }).then(() => true, () => false),
					resumeEngine: async (parkedForMs) => {
						// #1076–#1078, in order: take the checkout back, relaunch, re-sync onto upstream, put the work back (`resumeFromPark`).
						const r = (await runRetry(`unpark-${round}-${unparks++}`, () =>
							resumeFromPark(env, getConn(), { runId: loopRunId as string, instanceId, userId, sessionId, repoId, clientType: goal.clientType, cloneUrl, branch, token, tokenUsername, repoName: goal.repo, driverId: driverId ?? undefined, parkedForMs }),
						)) as { resumed: boolean; line: string; moved: string | null; node?: string | null } | { busy: string } | { blocked: string };
						if (!("line" in r)) return r;
						// #1242: it resumed on the machine it parked on, which may not be the one this Workflow re-resolved on waking.
						if (r.node && normalizeRunnerNode(r.node) !== normalizeRunnerNode(getConn().runnerNode)) setConn((await getRunnerConnIgnoringLiveness(env, instanceId, userId, r.node).catch(() => null)) ?? getConn());
						await recordLiveness(env, loopRunId as string, Date.now(), null).catch(() => undefined); // no longer parked, from this instant
						if (!r.resumed) getObjective()?.replaced(); // a fresh engine has read nothing: the objective is owed to it again (#1019)
						return { line: r.line, moved: r.moved };
					},
				}
			: undefined,
		applied: async () => void (parkedQuestionId && (await runRetry(`applied-${round}`, () => markAnswerApplied(env, parkedQuestionId as string, loopRunId ?? null)))),
		endTakeover: () => runRetry(`resume-${round}`, () => callRunner(getConn(), `/coding/takeover/${encodeURIComponent(sessionId)}/end`, {})).then(() => undefined),
		reauthCompletedSince: (since) => reauthCompletedSince(env, instanceId, userId, since),
		// An ended-and-started engine has read nothing its predecessor read: the objective is owed to it again (#1019).
		restartEngine: () => runRetry(`reauth-end-${round}`, () => callRunner(getConn(), "/coding/end", { sessionId })).then(() => {
				getObjective()?.replaced();
				return runRetry(`reauth-start-${round}`, () => startOnRunner());
			}).then(() => undefined),
		sleep: (label, ms) => step.sleep(label, ms),
		notify: (title, body, key, alert, url, type) =>
			runRetry(`notify-${key}-${round}`, async () => {
				const opts = { key: `${key}:${sessionId}`, kind: alert ? ("alert" as const) : undefined, instanceId };
				return await notifyUser(env, userId, type ?? "coding", title, body, url ?? deepLinkFor({ kind: "coding-session", instanceId, sessionId }), opts).then(() => null, () => null);
			}).then(() => undefined),
		announce: postToChat,
		// The board, which is where the owner would look for "does anything want me?" (#553).
		// Best-effort like every other card write: losing a card is a visibility bug, failing the
		// handoff is a work bug. Not a `step.do` — an idempotent patch is cheaper to repeat than
		// to journal, and a replay re-running it lands the same row.
		card: (status) => setCodingSessionCardStatus(env, instanceId, userId, sessionId, status).catch(() => undefined),
		// Outside `step.do`, like the runner guard's own tick: idempotent writes whose only job is to be
		// recent. This called `recordIteration`, whose one statement wrote `last_progress_at` too —
		// so a parked run's PROGRESS timestamp advanced every five minutes while the run sat on
		// iteration 1 for hours (#580). The heartbeat was never wrong to exist: `sweepStaleRuns`
		// closes a run at 3h and a usage-limit park may legitimately last six. It was writing the
		// wrong column, and 0127 gives it its own — plus the reason, so the record can finally say
		// "parked until X" instead of leaving a reader to infer work from a fresh number.
		tick: async (park) => {
			if (driverId) await touchSessionDriver(env, instanceId, userId, sessionId, driverId).catch(() => undefined);
			await touchSessionActivity(env, instanceId, userId, sessionId).catch(() => undefined);
			if (!loopRunId) return true;
			await recordLiveness(env, loopRunId, Date.now(), { reason: wait, until: park?.until ?? null, ask: wait === "decision" ? parkedAsk : null }).catch(() => undefined);
			return !(await isCancelRequested(env, loopRunId).catch(() => false));
		},
	});
	return {
		deps,
		clearAsk: () => {
			parkedAsk = null;
		},
		restoreFallback: async ({ endEngine }) => {
			if (!originalCommand) return;
			const original = originalCommand;
			const model = switchedTo;
			await runRetry("fallback-restore", async () => {
				await setSessionLaunchCommand(env, instanceId, userId, sessionId, original);
				if (endEngine) await callRunner(getConn(), "/coding/end", { sessionId }).catch(() => undefined);
				await traceCodingRun(env, { userId, instanceId, sessionId, runId: loopRunId ?? null, repo: goal.repo, cardId }, "coding.run.provider_fallback_restored", `The session's model was put back to ${readEngineModel(original) ?? "the default"} after the fallback ${model ?? ""}.`, {
					attempt: 0, fallbackModel: model, restoredTo: readEngineModel(original), endedEngine: endEngine,
				});
				return null;
			});
		},
	};
}
