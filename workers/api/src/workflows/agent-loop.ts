// The platform's durable agent loop (#158).
//
// Before this, the autonomous loop was half in the wrong place: the platform owned the THINKING
// (`/loop-decide`, agent-generic, in routes/instances.ts) while the BROWSER owned the persistence
// — the console polled and sent the next instruction, so closing a tab killed an in-flight
// objective. Meanwhile the Pilot (CodingSessionWorkflow) was durable but Coder-bound.
//
// This is the missing piece: a durable, generic loop runner any agent can use, with the Pilot as
// one configuration of the same idea. It is also the precondition for #184 — you cannot budget a
// loop you do not drive, because every enforcement point sits on the server side of it.
//
// Each iteration: cancel? → reserve budget → act (instance chat) → settle actual → decide → apply
// the pure policy in lib/agent-loop.ts.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { nextStep, instructionKey, needsHuman, readAgentReply, replyErrorClass, type LoopState, type LoopStopReason } from "../lib/agent-loop.js";
import { finishLoopRun, isCancelRequested, recordIteration, recordLiveness } from "../lib/agent-loop-store.js";
import { classifyCodingFailure, driverResumePlan, MAX_PLATFORM_RESUMES } from "../lib/coding-failure.js";
import { interruptedBy } from "../lib/coding-run-report.js";
import { isCredentialsError, runLoopDecide, type LoopTurn } from "../lib/loop-orchestrator.js";
import { markExhausted, reserve, settle } from "../lib/delegation-budget-store.js";
import { instanceSpendMicros } from "../lib/usage.js";
import { instanceLink } from "../lib/console-links.js";
import { logEvent } from "../lib/events.js";
import { logError } from "../lib/error-log.js";
import { escalationNote, escalationTarget } from "../lib/escalation.js";
import { loadGraph } from "../lib/supervision.js";
import { notifyUser } from "../routes/push.js";
import type { Env } from "../types.js";

export interface AgentLoopParams {
	runId: string;
	instanceId: string;
	userId: string;
	objective: string;
	maxIterations: number;
	/** Delegation budget to draw against (#184). Absent ⇒ unbudgeted (legacy callers). */
	budgetId?: string | null;
	/** Depth in the supervision tree (#183); the budget refuses past its cap. */
	depth?: number;
	/** Reserved per iteration — a bounded MAXIMUM, not a prediction. Settle refunds the rest. */
	reserveMicros?: number;
	/** Supervisor that asked for this run (#185). AUDIT ONLY — the subordinate executes with its
	 *  own consent and tools; this never widens what it may do. */
	onBehalfOf?: string | null;
}

/** Bounded worst case for one iteration (agent turn + orchestrator turn), in USD micros. */
const DEFAULT_RESERVE_MICROS = 200_000; // $0.20

export class AgentLoopWorkflow extends WorkflowEntrypoint<Env, AgentLoopParams> {
	async run(event: WorkflowEvent<AgentLoopParams>, step: WorkflowStep): Promise<{ stopReason: LoopStopReason; iterations: number }> {
		const { runId, instanceId, userId, objective, maxIterations } = event.payload;
		const budgetId = event.payload.budgetId ?? null;
		const depth = Math.max(0, event.payload.depth ?? 0);
		const reserveMicros = Math.max(0, event.payload.reserveMicros ?? DEFAULT_RESERVE_MICROS);

		const transcript: LoopTurn[] = [];
		const recentInstructions: string[] = [];
		const recentErrorClasses: Array<string | null> = [];
		let instruction = objective;
		let iteration = 0;
		let stop: { reason: LoopStopReason; message: string } | null = null;
		// The reservation currently held, if any. A step that exhausts its retries aborts the
		// whole Workflow instance, skipping `settle` AND `finish` — CodingSessionWorkflow wraps
		// its loop for exactly this reason; this one did not. The result was a run row stuck
		// `running` with `finished_at` NULL FOREVER (the console and `check_delegation` report the
		// delegation as still in flight; `cancel` returns 200 and nothing reads the flag), while
		// the 200,000 micros stayed held against the SHARED tree pool — `remainingCost` subtracts
		// it, so every sibling permanently has $0.20 less headroom. There is no reconciling cron:
		// `scheduled()` runs only runDueTriggers and runDueDeliveries.
		let outstanding: { reserved: number; spendBefore: number } | null = null;
		/**
		 * Is this death an interruption we are about to be REPLAYED through? (#583 AC5)
		 *
		 * Gates the teardown, exactly as `coding-session.ts` gates its own. A resumed run still owns
		 * its reservation and its run row, and Cloudflare is about to replay it — so settling and
		 * closing on the way out would tear down the run that then carries on working.
		 *
		 * Skipping the settle is the LOAD-BEARING half here, and for a reason specific to money. The
		 * `finally`'s settle and the loop's own `settle-${iteration}` are different step ids, so if
		 * the finally settled and the replay then reached the loop's settle un-journalled, one
		 * iteration would be charged to the shared tree pool TWICE — the exact double-count the
		 * comment on `outstanding = null` above already warns is worse than a leak. Left alone, the
		 * replay settles it once, through the step that was always meant to.
		 */
		let resuming = false;

		try {
		while (!stop) {
			iteration++;

			// A human asked it to stop. Checked at the TOP so the previous iteration's spend has
			// already settled — cancelling mid-step would strand a reservation and leak headroom.
			if (await step.do(`cancel-check-${iteration}`, () => isCancelRequested(this.env, runId))) {
				stop = { reason: "cancelled", message: "Stopped at your request." };
				break;
			}

			// Reserve BEFORE the model runs: there is no point paying for a decision you cannot act
			// on, and the reservation is what stops concurrent siblings overbooking the pool.
			let reserved = 0;
			if (budgetId) {
				const draw = await step.do(`reserve-${iteration}`, () =>
					reserve(this.env, userId, budgetId, { depth, estimatedCostMicros: reserveMicros }),
				);
				if (!draw.ok) {
					await step.do(`budget-exhausted-${iteration}`, async () => {
						// `account_ceiling` must NOT close the pool. It is a TRANSIENT fact about
						// the account's rolling 24h spend, not about this tree — marking the shared
						// budget `exhausted` closed a pool with most of its allowance left, failed
						// every sibling loop drawing on it with "budget is already closed", and
						// survived the window rolling off with no route to reopen it.
						if (draw.reason && draw.reason !== "not_found" && draw.reason !== "closed" && draw.reason !== "account_ceiling") {
							await markExhausted(this.env, userId, budgetId, draw.reason, depth);
						}
					});
					stop = { reason: "budget", message: draw.message ?? "This run hit its budget." };
					break;
				}
				reserved = draw.reserved ?? reserveMicros;
			}
			// Spend reading taken BEFORE the work, so the window covers both the agent turn and
			// the orchestrator turn. ai_usage is append-only, so the delta is the iteration cost.
			const spendBefore = budgetId
				? await step.do(`spend-before-${iteration}`, () => instanceSpendMicros(this.env, userId, instanceId))
				: 0;
			if (budgetId && reserved) outstanding = { reserved, spendBefore };

			// ACT — hand the instruction to the instance's own brain, which runs with ITS tools,
			// memory and guardrails (#185: the executor is the authority).
			const reply = await step.do(`act-${iteration}`, async () => {
				try {
					const stub = this.env.AGENT.get(this.env.AGENT.idFromName(instanceId));
					const res = await stub.fetch(
						new Request("https://agent/chat", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								message: instruction,
								channel: "loop",
								userId,
								agentId: instanceId,
								// The delegation context this turn's tools need. `onBehalfOf` was
								// accepted as a workflow param and never read; `budgetId` never
								// reached `delegate_goal`, so a sub-delegation opened its OWN pool
								// instead of drawing on the tree's — the per-tree bound was inert.
								budgetId,
								onBehalfOf: event.payload.onBehalfOf ?? null,
								traceId: runId,
							}),
						}),
					);
					// Shape-handling lives in lib/agent-loop.ts so it is testable without a DO —
					// getting it wrong here is what produced "[object Object]" and failed a run.
					return readAgentReply(await res.json().catch(() => ({})));
				} catch (e) {
					return `(the agent could not be reached: ${e instanceof Error ? e.message : String(e)})`;
				}
			});

			transcript.push({ role: "user", content: instruction }, { role: "assistant", content: reply });
			recentInstructions.push(instructionKey(instruction));
			// Track the error class of each reply so we can detect a structurally-blocked
			// capability (same error class repeating) and escalate early (#473).
			recentErrorClasses.push(replyErrorClass(reply));
			await step.do(`progress-${iteration}`, () => recordIteration(this.env, runId, iteration));

			// DECIDE — the same orchestrator path the HTTP route uses, so the two can't disagree.
			const decision = await step.do(`decide-${iteration}`, async () => {
				try {
					return await runLoopDecide(this.env, userId, instanceId, { objective, messages: transcript, iteration, maxIterations, traceId: runId });
				} catch (e) {
					// A missing BYOK key fails the same way every time — escalate now rather than
					// letting the Workflow retry the step and charge for each attempt.
					if (isCredentialsError(e)) {
						return { decision: "escalate" as const, nextInstruction: "", reason: "No API key configured. Add one in Profile → API Keys." };
					}
					throw e;
				}
			});

			// Settle with the ACTUAL cost, releasing the reservation. Settling `reserved` instead
			// would mean the refund never happens and the pool drains at the worst case every
			// iteration — the reserve-and-refund design exists precisely to avoid that.
			// Settled even when a step failed: the tokens were spent either way, and a pool that
			// only charges for successes lets a failing loop run free.
			if (budgetId && reserved) {
				// Cleared BEFORE the settle step, not after. `settle` is not idempotent — it both
				// releases the reservation and ADDS the spend — so if the settle step threw after
				// its body had run, the `finally` below would charge the same iteration to the
				// shared tree pool a second time. Real money double-counted is worse than a
				// reservation that leaks headroom in a pool the owner can reopen, and the settle
				// step has its own retries. The finally therefore only ever settles a reservation
				// whose settle was never ATTEMPTED.
				outstanding = null;
				await step.do(`settle-${iteration}`, async () => {
					const after = await instanceSpendMicros(this.env, userId, instanceId);
					await settle(this.env, userId, budgetId, reserved, Math.max(0, after - spendBefore));
				});
			}

			const state: LoopState = { iteration, maxIterations, recentInstructions, recentErrorClasses };
			const verdict = nextStep(state, decision, reply);
			if (!verdict.continue) {
				stop = { reason: verdict.stopReason ?? "failed", message: verdict.message ?? "" };
				break;
			}
			instruction = verdict.nextInstruction as string;
		}
		} catch (e) {
			/**
			 * Is this a PLATFORM interruption we are about to be replayed through? (#583 AC5)
			 *
			 * This catch used to turn every death into `failed`, which made this the one durable
			 * driver with NO consumer of the retryable verdict at all — the defect #583 reports for
			 * the Pilot, on a driver nobody had checked. Our own deploy resets the isolate (seven API
			 * deploys in 48 minutes, measured), and an agent-loop run caught by one was closed
			 * permanently while its four peers all re-threw and resumed.
			 *
			 * It reaches the SAME decision function the Pilot does rather than a fourth copy of the
			 * rule — that is why `driverResumePlan` is no longer named after one driver. And it is
			 * BOUNDED where job-apply, browser-task and pipeline-run are not, because this driver has
			 * an `agent_loop_runs` row and `countInterruption` can therefore hold a durable count: an
			 * in-memory bound would replay with the journal and reset on the very event it bounds.
			 *
			 * The replay is cheap for the reason it is cheap for the Pilot: `act`, `decide`, `reserve`
			 * and `settle` are all `step.do`, so a replay returns each journalled result without
			 * re-executing it and without re-charging the pool. Only the step that died runs again.
			 *
			 * The classification is HELD rather than re-derived (#758), because it now decides what the
			 * event SAYS: this driver's sentence hardcoded "a platform update", a specific and checkable
			 * claim about our own deploys, which is false for the provider transport drop the policy
			 * also resumes as of #758. The clause comes from `coding-run-report.ts`, the same table the
			 * Pilot's chat bubble and terminal sentence read, so one death cannot be blamed on three
			 * different culprits depending on which surface the owner opens.
			 */
			const failure = classifyCodingFailure(e);
			const plan = await driverResumePlan(this.env, failure, runId).catch(() => null);
			if (plan?.resume) {
				resuming = true;
				await logEvent(this.env, {
					source: "loop",
					event: "loop.interrupted",
					message: `Loop ${interruptedBy(failure.class) ?? "interrupted"}, resuming (${plan.attempts} of ${MAX_PLATFORM_RESUMES}): ${plan.why}`.slice(0, 500),
					userId,
					instanceId,
					traceId: runId,
					level: "warn",
				}).catch(() => undefined);
				// A replay in flight must read as WAITING, never as a stall: a resume has nothing
				// ticking by design, and `runHealth` would otherwise call it dead. No `until` — see
				// `coding-pause.ts` on why a platform interrupt has no instant to state (#591).
				await recordLiveness(this.env, runId, Date.now(), { reason: "platform_interrupt" }).catch(() => undefined);
				throw e;
			}
			// A step that exhausted its retries. The run still has to END — a `running` row nobody
			// will ever close is worse than a failed one, because the supervisor keeps waiting.
			stop = { reason: "failed", message: `The run stopped unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500) };
		} finally {
			// Release a reservation the loop was holding when it died, or the tree pool leaks that
			// headroom permanently. Settled with the ACTUAL spend, same as the happy path — the
			// tokens were spent either way. Skipped for a run being resumed — see `resuming`.
			if (budgetId && outstanding && !resuming) {
				const held = outstanding;
				await step.do(`settle-outstanding-${iteration}`, async () => {
					const after = await instanceSpendMicros(this.env, userId, instanceId).catch(() => held.spendBefore);
					await settle(this.env, userId, budgetId, held.reserved, Math.max(0, after - held.spendBefore));
					// The settle is what returns the reservation to the pool; `outstanding` is cleared
					// unconditionally below, so nothing retries it afterwards. Swallowing it therefore
					// caused the exact permanent leak the comment above says this block prevents, and
					// every sibling drawing on the same tree pool was silently starved of that
					// headroom. This is a `finally` — it must not throw, or it would replace the real
					// stop reason — so the failure is recorded durably instead of vanishing.
				}).catch((e) =>
					logError(this.env, {
						source: "loop",
						userId,
						message: `budget reservation of ${held.reserved} micros could not be settled and is now leaked from the pool: ${e instanceof Error ? e.message : String(e)}`,
						context: { instanceId, budgetId, runId, reserved: held.reserved },
					}).catch(() => undefined),
				);
				outstanding = null;
			}
		}

		await step.do("finish", async () => {
			const now = Date.now();
			await finishLoopRun(this.env, runId, stop.reason, stop.message, now);
			await logEvent(this.env, {
				source: "loop",
				event: stop.reason,
				message: `Loop ${stop.reason}: ${stop.message}`.slice(0, 500),
				userId,
				instanceId,
				traceId: runId,
				level: needsHuman(stop.reason) ? "warn" : "info",
			}).catch(() => undefined);
			// #157: climb the ladder before waking anyone. Three subordinates under one Lead means
			// three pings to the same person otherwise, each missing the context the Lead has —
			// a hierarchy that amplifies interrupts instead of absorbing them.
			if (needsHuman(stop.reason)) {
				const graph = await loadGraph(this.env, userId).catch(() => []);
				const target = escalationTarget(graph, instanceId, 0);
				if (target.kind === "supervisor") {
					const note = escalationNote({
						subordinateName: instanceId,
						objective,
						reason: stop.reason,
						detail: stop.message,
					});
					// Told, not triggered: a board card the supervisor can see plus a note in its
					// thread. Auto-resolution would start spending unprompted and is a bigger
					// decision than routing an interrupt.
					// The card IS the escalation. Swallowing this INSERT and returning anyway meant a
					// run that needed a human ended with NOBODY told — no supervisor card, and the
					// `notifyUser` fallback below skipped by the early return. Silence is the one
					// outcome #157 must never produce, so a failed card falls through to waking the
					// human instead of pretending the ladder was climbed.
					const escalated = await this.env.DB.prepare(
						`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at)
						 VALUES (?1, ?2, ?3, 'escalation', 'needs_human', ?4, datetime('now'), datetime('now'))`,
					)
						.bind(
							`esc-${runId}`,
							target.instanceId,
							userId,
							JSON.stringify({
								id: `esc-${runId}`,
								type: "escalation",
								status: "needs_human",
								title: `A supervised agent needs a decision`,
								reasoning: note,
								createdAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
							}),
						)
						.run()
						.then(
							() => true,
							async (e: unknown) => {
								await logError(this.env, {
									source: "loop",
									userId,
									message: `escalation card for ${instanceId} → ${target.instanceId} could not be written; waking the human instead: ${e instanceof Error ? e.message : String(e)}`,
									context: { instanceId, supervisorId: target.instanceId, runId },
								}).catch(() => undefined);
								return false;
							},
						);
					if (escalated) {
						await logEvent(this.env, {
							source: "loop",
							event: "escalated_to_supervisor",
							message: `${instanceId} → ${target.instanceId} (hop ${target.hops})`,
							userId,
							instanceId: target.instanceId,
							traceId: runId,
							level: "warn",
						}).catch(() => undefined);
						return; // the human is NOT interrupted at this level
					}
				}
			}
			if (needsHuman(stop.reason)) {
				// The Assistant, where the loop's own conversation is — and where a human answers it.
				// This used to be `/console/#/instances/<id>`, a hash path on a BrowserRouter: the
				// router never reads a fragment, so the tap opened the console and stopped at
				// whatever screen the user had last (#344).
				await notifyUser(
					this.env,
					userId,
					"loop",
					"Your agent needs you",
					stop.message.slice(0, 200),
					instanceLink(instanceId),
					// One run stops once. `alert` because the run has STOPPED and only a human
					// restarts it — never muted (#360).
					{ key: `loop:${runId}:${stop.reason}`, kind: "alert" },
				).catch(() => undefined);
			}
		});

		return { stopReason: stop.reason, iterations: iteration };
	}
}
