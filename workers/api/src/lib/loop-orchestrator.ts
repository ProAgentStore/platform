// The loop orchestrator's model call (#158).
//
// Extracted from the `/loop-decide` route so the durable workflow and the HTTP endpoint share ONE
// decide path. They were about to diverge — the route inlined the prompt — and two orchestrators
// disagreeing about when a run is "done" is the kind of bug nobody finds for a month.
//
// The parse lives in the pure `loop-decide.ts`; this adds the prompt and the BYOK call.

import { parseLoopDecision, type LoopDecisionResult } from "./loop-decide.js";
import { runUserWorkersAi } from "./user-ai.js";
import type { Env } from "../types.js";

export interface LoopTurn {
	role: string;
	content: string;
}

export interface LoopDecideInput {
	objective: string;
	messages: LoopTurn[];
	iteration: number;
	maxIterations: number;
}

/** Clamp the inputs the model sees. Pure, so the prompt shape is testable without a model. */
export function sanitizeDecideInput(raw: Partial<LoopDecideInput>): LoopDecideInput {
	return {
		objective: String(raw.objective ?? "").slice(0, 2000),
		messages: Array.isArray(raw.messages) ? raw.messages.slice(-20) : [],
		iteration: Math.max(0, Math.min(1_000, Number(raw.iteration) || 0)),
		maxIterations: Math.max(1, Math.min(1_000, Number(raw.maxIterations) || 10)),
	};
}

export function buildLoopSystemPrompt(iteration: number, maxIterations: number): string {
	return `You are a loop orchestrator. You are on iteration ${iteration}/${maxIterations}.

Read the user's objective and the conversation so far, then decide ONE of:
- CONTINUE: the objective is not yet met. Write the next instruction to give the agent.
- DONE: the objective is fully met. No more work needed.
- ESCALATE: the agent is stuck, pushing back, asking questions, or needs human help.
- FAILED: something went wrong or the agent keeps repeating itself.

Reply ONLY with JSON: { "decision": "continue"|"done"|"escalate"|"failed", "nextInstruction": "...", "reason": "..." }`;
}

/** The objective + transcript go in the USER turn, never interpolated into the system prompt. */
export function buildLoopUserContent(input: LoopDecideInput): string {
	const conversationText = input.messages
		.slice(-6)
		.map((m) => `${m.role}: ${(m.content || "").slice(0, 2000)}`)
		.join("\n\n");
	return `OBJECTIVE: ${input.objective.slice(0, 500)}\n\nCONVERSATION:\n${conversationText || "(no messages yet)"}`;
}

/**
 * A missing/invalid BYOK key is not a model outage — it is a thing the USER must fix, and it will
 * fail identically on every retry. Callers surface it directly (402 on the route, an immediate
 * escalation in the workflow) rather than burning iterations on it.
 */
export function isCredentialsError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes("API key") || msg.includes("credentials");
}

/**
 * Ask the orchestrator what to do next.
 *
 * Swallows transient model failures into an escalation a human can see, rather than throwing
 * inside a Workflow step that would then retry the whole iteration and pay twice. Credential
 * errors are the exception and are rethrown — see `isCredentialsError`.
 */
export async function runLoopDecide(
	env: Env,
	userId: string,
	instanceId: string,
	raw: Partial<LoopDecideInput>,
): Promise<LoopDecisionResult> {
	const input = sanitizeDecideInput(raw);
	try {
		const res = (await runUserWorkersAi(
			env,
			userId,
			"claude-sonnet-4-6",
			{
				messages: [
					{ role: "system", content: buildLoopSystemPrompt(input.iteration, input.maxIterations) },
					{ role: "user", content: buildLoopUserContent(input) },
				],
				maxTokens: 300,
			},
			{ kind: "chat", instanceId },
		)) as { response?: string };
		return parseLoopDecision(res.response || "");
	} catch (e) {
		if (isCredentialsError(e)) throw e;
		const msg = e instanceof Error ? e.message : String(e);
		return {
			decision: "escalate",
			nextInstruction: "",
			reason: `The loop orchestrator could not reach the model: ${msg.slice(0, 200)}`,
		};
	}
}
