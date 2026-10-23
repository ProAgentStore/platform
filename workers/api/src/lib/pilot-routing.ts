/** A bounded, opt-in cheaper Pilot route; it never executes tools itself (#1316). */
import type { Env } from "../types.js";
import type { UsageContext } from "./usage.js";
import { DEFAULT_PILOT_MODEL, type PilotModelId } from "./pilot-model.js";
import { runUserWorkersAi, UserAiProviderError, type StreamDeadlines } from "./user-ai.js";
import { hitOutputCap } from "./reply-truncation.js";
import { screenInstruction } from "./coding-authority.js";
import { activeConstraints, constraintSources, screenScopedInstruction } from "./coding-scope-constraints.js";
import type { CodingGoal } from "./coding-loop.js";
import { AI_FIRST_TOKEN_TIMEOUT_MS, AI_STALL_TIMEOUT_MS, AI_TOTAL_TIMEOUT_MS } from "./ai-deadlines.js";

export interface PilotInferenceReply {
	response?: string;
	tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
	malformed_tool_calls?: Array<{ name: string; error: string }>;
	usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number };
	stopReason?: string;
	inference?: { provider: string; model: string };
	pilotRouting?: { requestedModel: PilotModelId; model: string; provider?: string; fallbackReason?: string };
}

export interface PilotInferenceBody {
	messages: Array<{ role: string; content: unknown }>;
	tools: readonly unknown[];
	maxTokens: number;
	streamDeadlines?: StreamDeadlines;
}

/** Endings and owner interactions always get a Sonnet decision. Existing loop guards run again. */
export function routinePilotReply(reply: PilotInferenceReply, goal: CodingGoal): boolean {
	if (hitOutputCap(reply.stopReason) || reply.malformed_tool_calls?.length || reply.tool_calls?.length !== 1) return false;
	const call = reply.tool_calls[0];
	const text = call.arguments?.text;
	if (call.name !== "send_message" || typeof text !== "string" || !text.trim()) return false;
	if (call.arguments.learned !== undefined && (typeof call.arguments.learned !== "string" || call.arguments.learned.length > 300)) return false;
	return !screenInstruction(goal.mergePolicy ?? "merge", text)
		&& !screenScopedInstruction(goal.scopeConstraints ?? activeConstraints(constraintSources(goal)), text);
}

export async function runPilotInference(
	env: Env,
	userId: string,
	model: PilotModelId,
	body: PilotInferenceBody,
	ctx: UsageContext | undefined,
	acceptCanary: (reply: PilotInferenceReply) => boolean,
	opts?: { anthropicOnly?: boolean },
): Promise<PilotInferenceReply> {
	const startedAt = Date.now();
	const ceiling = Math.min(AI_TOTAL_TIMEOUT_MS, body.streamDeadlines?.totalMs ?? AI_TOTAL_TIMEOUT_MS);
	const call = (selected: PilotModelId, fallback = false) => {
		const remaining = ceiling - (Date.now() - startedAt);
		if (remaining <= 0) throw new UserAiProviderError("The Pilot decision's total deadline expired before fallback.", 504, undefined, undefined, true);
		const boundedBody = { ...body, streamDeadlines: { ...body.streamDeadlines,
			totalMs: remaining,
			preContentMs: Math.min(body.streamDeadlines?.preContentMs ?? AI_FIRST_TOKEN_TIMEOUT_MS, remaining),
			silenceMs: Math.min(body.streamDeadlines?.silenceMs ?? AI_STALL_TIMEOUT_MS, remaining) } };
		return runUserWorkersAi(env, userId, selected, boundedBody,
			ctx && fallback ? { ...ctx, promptPhase: `${ctx.promptPhase ?? "pilot_decide"}_fallback` } : ctx,
			model !== DEFAULT_PILOT_MODEL || opts?.anthropicOnly ? { provider: "anthropic", anthropicModel: selected } : undefined) as Promise<PilotInferenceReply>;
	};
	if (model === DEFAULT_PILOT_MODEL) {
		const reply = await call(model);
		return { ...reply, pilotRouting: { requestedModel: model, model: reply.inference?.model ?? model, ...(reply.inference ? { provider: reply.inference.provider } : {}) } };
	}
	// A transport stall already spent the cheap attempt. Recovery does not repeat canary/fallback pairs.
	if ((body.streamDeadlines?.attempt ?? 1) > 1) {
		const reply = await call(DEFAULT_PILOT_MODEL, true);
		return { ...reply, pilotRouting: { requestedModel: model, model: DEFAULT_PILOT_MODEL, fallbackReason: "Recovery attempts use Sonnet." } };
	}
	let first: PilotInferenceReply | undefined;
	let fallbackReason: string;
	try {
		first = await call(model);
		if (acceptCanary(first)) return { ...first, pilotRouting: { requestedModel: model, model } };
		fallbackReason = "Canary reply requires a Sonnet decision (non-routine, invalid, constrained or truncated).";
	} catch (e) {
		// Credit, authentication, overload and stream stalls belong to the existing recovery policy.
		// Only an unavailable canary model is a reason to try a different model here.
		if (!(e instanceof UserAiProviderError) || e.upstreamStatus !== 404) throw e;
		fallbackReason = "Canary model unavailable to this API key (404).";
	}
	const reply = await call(DEFAULT_PILOT_MODEL, true);
	const usage = first?.usage && reply.usage ? {
		input: first.usage.input + reply.usage.input,
		output: first.usage.output + reply.usage.output,
		cacheRead: (first.usage.cacheRead ?? 0) + (reply.usage.cacheRead ?? 0),
		cacheWrite: (first.usage.cacheWrite ?? 0) + (reply.usage.cacheWrite ?? 0),
		cacheWrite1h: (first.usage.cacheWrite1h ?? 0) + (reply.usage.cacheWrite1h ?? 0),
	} : reply.usage;
	return { ...reply, usage, pilotRouting: { requestedModel: model, model: DEFAULT_PILOT_MODEL, fallbackReason } };
}
