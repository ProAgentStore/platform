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
import { nextStep, instructionKey, needsHuman, type LoopState, type LoopStopReason } from "../lib/agent-loop.js";
import { finishLoopRun, isCancelRequested, recordIteration } from "../lib/agent-loop-store.js";
import { isCredentialsError, runLoopDecide, type LoopTurn } from "../lib/loop-orchestrator.js";
import { markExhausted, reserve, settle } from "../lib/delegation-budget-store.js";
import { instanceSpendMicros } from "../lib/usage.js";
import { logEvent } from "../lib/events.js";
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
		let instruction = objective;
		let iteration = 0;
		let stop: { reason: LoopStopReason; message: string } | null = null;

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
						if (draw.reason && draw.reason !== "not_found" && draw.reason !== "closed") {
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

			// ACT — hand the instruction to the instance's own brain, which runs with ITS tools,
			// memory and guardrails (#185: the executor is the authority).
			const reply = await step.do(`act-${iteration}`, async () => {
				try {
					const stub = this.env.AGENT.get(this.env.AGENT.idFromName(instanceId));
					const res = await stub.fetch(
						new Request("https://agent/chat", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ message: instruction, channel: "loop", userId, agentId: instanceId }),
						}),
					);
					const body = (await res.json().catch(() => ({}))) as { response?: string; message?: string };
					return String(body.response ?? body.message ?? "").slice(0, 8000);
				} catch (e) {
					return `(the agent could not be reached: ${e instanceof Error ? e.message : String(e)})`;
				}
			});

			transcript.push({ role: "user", content: instruction }, { role: "assistant", content: reply });
			recentInstructions.push(instructionKey(instruction));
			await step.do(`progress-${iteration}`, () => recordIteration(this.env, runId, iteration));

			// DECIDE — the same orchestrator path the HTTP route uses, so the two can't disagree.
			const decision = await step.do(`decide-${iteration}`, async () => {
				try {
					return await runLoopDecide(this.env, userId, instanceId, { objective, messages: transcript, iteration, maxIterations });
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
				await step.do(`settle-${iteration}`, async () => {
					const after = await instanceSpendMicros(this.env, userId, instanceId);
					await settle(this.env, userId, budgetId, reserved, Math.max(0, after - spendBefore));
				});
			}

			const state: LoopState = { iteration, maxIterations, recentInstructions };
			const verdict = nextStep(state, decision);
			if (!verdict.continue) {
				stop = { reason: verdict.stopReason ?? "failed", message: verdict.message ?? "" };
				break;
			}
			instruction = verdict.nextInstruction as string;
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
			// Only interrupt a human when the ending actually needs one — a clean finish or a
			// cancel they asked for should not buzz a phone.
			if (needsHuman(stop.reason)) {
				await notifyUser(
					this.env,
					userId,
					"loop",
					"Your agent needs you",
					stop.message.slice(0, 200),
					`/console/#/instances/${instanceId}`,
				).catch(() => undefined);
			}
		});

		return { stopReason: stop.reason, iterations: iteration };
	}
}
