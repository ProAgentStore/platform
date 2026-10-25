/** Coding uses Sonnet; obsolete canary selections cannot route a coding decision to Haiku (#1316). */
import type { Env } from "../types.js";
import type { UsageContext } from "./usage.js";
import { DEFAULT_PILOT_MODEL, type PilotModelId } from "./pilot-model.js";
import { runUserWorkersAi, UserAiProviderError, type StreamDeadlines } from "./user-ai.js";
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

/** Recheck at inference, including old in-memory goals and journalled requests. */
export async function runPilotInference(
	env: Env,
	userId: string,
	requestedModel: unknown,
	body: PilotInferenceBody,
	ctx: UsageContext | undefined,
): Promise<PilotInferenceReply> {
	const ceiling = Math.min(AI_TOTAL_TIMEOUT_MS, body.streamDeadlines?.totalMs ?? AI_TOTAL_TIMEOUT_MS);
	if (ceiling <= 0) throw new UserAiProviderError("The Pilot decision's total deadline expired before inference.", 504, undefined, undefined, true);
	const boundedBody = { ...body, streamDeadlines: { ...body.streamDeadlines,
		totalMs: ceiling,
		preContentMs: Math.min(body.streamDeadlines?.preContentMs ?? AI_FIRST_TOKEN_TIMEOUT_MS, ceiling),
		silenceMs: Math.min(body.streamDeadlines?.silenceMs ?? AI_STALL_TIMEOUT_MS, ceiling) } };
	// Preserve the existing BYOK provider route, including Cloudflare-only accounts. There is no
	// model fallback or second paid call here; the surrounding recovery policy owns retries.
	const reply = await runUserWorkersAi(env, userId, DEFAULT_PILOT_MODEL, boundedBody, ctx) as PilotInferenceReply;
	return { ...reply, pilotRouting: {
		requestedModel: DEFAULT_PILOT_MODEL,
		model: reply.inference?.model ?? DEFAULT_PILOT_MODEL,
		...(reply.inference ? { provider: reply.inference.provider } : {}),
		...(requestedModel !== DEFAULT_PILOT_MODEL ? { fallbackReason: "The saved Pilot selection is unsupported for coding; using the default coding policy." } : {}),
	} };
}
