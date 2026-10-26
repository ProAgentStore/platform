/**
 * The Anthropic adapter (#1356): request building, the streamed send under its three deadlines, the refusal read once into a kind, the
 * assembled reply, and its usage — everything about Anthropic's wire that used to live in `user-ai.ts`.
 *
 * Moved out unchanged in behaviour. What is new is the shape: the pieces are the methods of a `ProviderAdapter`, so the shared driver can
 * do the account observation and bookkeeping once for both providers, and the `kind` of a refusal is decided here, by `parseError`,
 * and nowhere else.
 */
import {
	AI_FIRST_TOKEN_TIMEOUT_MS,
	AI_STALL_TIMEOUT_MS,
	AI_TOTAL_TIMEOUT_MS,
	type AiDeadlineKind,
	connectionLostMessage,
	deadlineMessage,
	isRetryableDeadline,
} from "./ai-deadlines.js";
import { AnthropicStreamAssembler, AnthropicStreamError, type AnthropicMessageBody, parseSseEvents } from "./anthropic-stream.js";
import { type CacheBudget, MAX_CACHE_BREAKPOINTS, anthropicSystemBlocks, anthropicUserBlocks, normalizeForAnthropic } from "./anthropic-prompt.js";
import { keyHint } from "./key-hint.js";
import { type ProviderAdapter, type ProviderErrorWire, providerFacts } from "./provider-adapter.js";
import { classifyAnthropicError, type ProviderErrorKind } from "./provider-error-kind.js";
import { type StreamDeadlines, type StreamPhase, streamPhaseSuffix } from "./stream-phase.js";
import { UserAiProviderError } from "./user-ai-errors.js";

/** The body a brain hands `runUserWorkersAi` when it runs on Anthropic. */
export interface AnthropicBody {
	messages: Array<{ role: string; content: unknown }>;
	tools?: unknown[];
	toolChoice?: "auto" | "none";
	maxTokens?: number;
	timeoutMs?: number;
	streamDeadlines?: StreamDeadlines;
}

/** A request prepared for sending: the wire payload and the deadlines it will be held to. */
export interface AnthropicRequest {
	model: string;
	payload: Record<string, unknown>;
	controller: AbortController;
	/** The provider and model THIS request ran on, for telemetry (#907). */
	meta: { provider: string; model: string };
	deadlines: { startedAt: number; firstTokenMs: number; silenceMs: number; totalMs: number; firstTokenDeadline: number; totalDeadline: number };
}

/** One deadline ran out. Carries WHICH, because the three mean different things to the user. */
class DeadlineExceeded extends Error {
	/** How many SSE events the assembler accepted before silence — annotated by readAnthropicStream. */
	eventsSeen?: number;
	/** The `type` of the last accepted event — annotated by readAnthropicStream. */
	lastEventType?: string;
	/** The measured phase (#907) — annotated by readAnthropicStream. */
	phase?: StreamPhase;

	constructor(
		readonly kind: AiDeadlineKind,
		readonly budgetMs: number,
	) {
		super(`${kind} deadline exceeded after ${budgetMs}ms`);
		this.name = "DeadlineExceeded";
	}
}

/**
 * Bound a promise, without touching the AbortController.
 *
 * A race rather than only `signal.abort()` because an abort is advisory — it unblocks the socket,
 * but whether the pending `read()` rejects, and how soon, is the runtime's business. The deadline
 * has to be OURS or the ceiling is a suggestion. The caller aborts as well, to free the connection.
 */
function withDeadline<T>(promise: Promise<T>, remainingMs: number, kind: AiDeadlineKind, budgetMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new DeadlineExceeded(kind, budgetMs)), Math.max(0, remainingMs));
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/** Translate our two internal failures into the error the user reads. Anything else is a real bug. */
function asProviderError(err: unknown, meta?: { provider: string; model: string }): UserAiProviderError | null {
	if (err instanceof DeadlineExceeded) {
		// Retryability comes from the SAME table the sentence does (#518), so what the platform does
		// automatically is what the platform told the user to do. The measured phase rides in the
		// message too (#907): it is the one part of an error a Workflow step boundary keeps.
		const provErr = new UserAiProviderError(`${deadlineMessage(err.kind, err.budgetMs)}${err.phase ? streamPhaseSuffix(err.phase) : ""}`, 504, undefined, undefined, isRetryableDeadline(err.kind));
		if (err.phase) provErr.streamPhase = err.phase;
		if (meta) Object.assign(provErr, meta);
		// Thread the stream state so `recordCodingFailure` can write what the assembler had seen
		// before the silence — the fact that settles whether a stall is pre- or post-content (#734).
		if (err.eventsSeen !== undefined) provErr.eventsSeen = err.eventsSeen;
		if (err.lastEventType !== undefined) provErr.lastEventType = err.lastEventType;
		return provErr;
	}
	// A malformed or truncated stream is a transport fact — a lost frame, a mid-stream
	// `overloaded_error`, tool arguments that arrived half-written. A fresh generation is a fresh
	// stream, so this is worth exactly one retry.
	// The provider stopping mid-reply — a tool call whose arguments stopped arriving, or a dropped stream
	// with no output cap (#907) — is marked as such IN THE MESSAGE, the part that survives a step boundary.
	if (err instanceof AnthropicStreamError) {
		return new UserAiProviderError(`Anthropic: ${err.message}${err.marker ? ` ${err.marker}` : ""}`, 502, undefined, undefined, true);
	}
	// The runtime's own abort, raised by a socket we cancelled or one the provider dropped. It says
	// nothing about HOW LONG anything waited — see `connectionLostMessage`.
	if (err instanceof Error && err.name === "AbortError") {
		return new UserAiProviderError(connectionLostMessage(), 504, undefined, undefined, true);
	}
	return null;
}

/**
 * Read the SSE body to a whole message, under the three deadlines.
 *
 * The first read carries the FIRST-TOKEN budget; every read after it carries the STALL budget,
 * re-armed per chunk — that is the whole point of streaming here, because a long reply now looks
 * like steady progress rather than one long silence. The TOTAL ceiling clamps both, so a provider
 * that dribbles a token every 19 seconds forever still ends.
 */
async function readAnthropicStream(
	res: Response,
	deadlines: { firstTokenDeadline: number; totalDeadline: number; firstTokenMs: number; silenceMs?: number; totalMs?: number; startedAt?: number },
): Promise<AnthropicMessageBody> {
	const silenceMs = deadlines.silenceMs ?? AI_STALL_TIMEOUT_MS;
	const totalMs = deadlines.totalMs ?? AI_TOTAL_TIMEOUT_MS;
	const startedAt = deadlines.startedAt ?? Date.now();
	let lastChunkAt = Date.now();
	if (!res.body) throw new UserAiProviderError("Anthropic: the response carried no body to stream", 502);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const assembler = new AnthropicStreamAssembler();
	let buffer = "";
	try {
		for (;;) {
			const now = Date.now();
			// PRE-CONTENT until the model produces a content block (#907). Framing frames (`message_start`,
			// `ping`) keep the stream alive exactly as before — the deadline never gets STRICTER — but they
			// no longer end the pre-content budget: the first byte is not the first answer.
			const pre = !assembler.contentStarted;
			const silenceDeadline = pre ? Math.max(deadlines.firstTokenDeadline, lastChunkAt + silenceMs) : now + silenceMs;
			const kind: AiDeadlineKind = deadlines.totalDeadline < silenceDeadline ? "total" : pre ? "first-token" : "stall";
			const budgetMs = kind === "total" ? totalMs : kind === "first-token" ? deadlines.firstTokenMs : silenceMs;
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await withDeadline(
					reader.read(),
					Math.min(silenceDeadline, deadlines.totalDeadline) - now,
					kind,
					budgetMs,
				);
			} catch (e) {
				// Annotate a stall/first-token deadline with the stream state at the moment of silence
				// so the caller can record what the assembler had accepted and what it last saw.
				if (e instanceof DeadlineExceeded) {
					e.eventsSeen = assembler.eventsSeen;
					e.lastEventType = assembler.lastEventType;
					const at = Date.now();
					e.phase = { contentStarted: assembler.contentStarted, eventsSeen: assembler.eventsSeen, lastEventType: assembler.lastEventType ?? null, silentForMs: at - lastChunkAt, elapsedMs: at - startedAt };
				}
				throw e;
			}
			lastChunkAt = Date.now();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			const { events, rest } = parseSseEvents(buffer);
			buffer = rest;
			for (const event of events) assembler.push(event);
			// Stop at `message_stop` rather than waiting for the socket to close: the message is whole,
			// and a provider that keeps the connection open would otherwise cost a full stall timeout.
			if (assembler.done) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return assembler.finish();
}

/** The sentence that tells the owner which page fixes a refusal of this kind (#773, #1326). */
function anthropicRemedy(kind: ProviderErrorKind, facts: { status: number; keyHint: string | null }): string {
	const ending = facts.keyHint ?? "an unavailable hint";
	switch (kind) {
		case "model_access":
			return " — Your API key may not have access to this model. Get a key from console.anthropic.com/settings/keys";
		case "credentials":
			// A 401 is a dead key. A 403 `permission_error` "Request not allowed" has been measured to come and go on a key that works
			// minutes either side of it (#1326), so it is reported as a refusal the platform re-checks, not as a dead key.
			if (facts.status === 401) return " — Invalid API key. Update it in Profile → API Keys → Anthropic";
			if (facts.status === 403) {
				return ` — Anthropic API key ending in ${ending} was refused. PAGS re-checks this key automatically and continues stopped runs once it works; if it stays refused, check the key and organization at console.anthropic.com or replace it in Profile → API Keys → Anthropic`;
			}
			return "";
		case "credit":
			// `keyHint` is exactly four non-secret trailing characters (#780). The adapter holds the precise key that made this request, so
			// this identifies THAT key even if the owner replaces it before reading the error; a later vault lookup could lie.
			return ` — Anthropic API key ending in ${ending} has insufficient balance. This is the Anthropic API key balance, never a machine or Claude CLI subscription. Top up at console.anthropic.com/settings/billing`;
		default:
			return "";
	}
}

export const anthropicAdapter: ProviderAdapter<string, AnthropicRequest, AnthropicMessageBody> = {
	id: "anthropic",

	buildRequest(rawBody, model) {
		const body = rawBody as AnthropicBody;
	const systemMsg = (body.messages || []).find((m) => m.role === "system");
	// The system prompt's breakpoints first, then the messages' — one budget, in request order (#914).
	const budget: CacheBudget = { left: MAX_CACHE_BREAKPOINTS, shortSeen: false };
	const system = systemMsg ? anthropicSystemBlocks(systemMsg.content, budget) : undefined;
	const messages = normalizeForAnthropic(anthropicUserBlocks((body.messages || []).filter((m) => m.role !== "system"), budget));

	const anthropicBody: Record<string, unknown> = {
		model,
		// The fallback is what a caller inherits by NOT choosing, and #397 is the bill for that:
		// chat was the one caller that never chose, so every reply a human read end to end was cut
		// at ~4,000 characters. Every surface now names its own ceiling; this number is left where
		// it is only so a new call site fails cheaply rather than unboundedly.
		max_tokens: body.maxTokens ?? 1024,
		messages,
	};
	// Prompt-cache the (large, stable) system prompt so repeated calls within a run
	// — the apply loop fires one per step — reprocess it from cache instead of
	// re-paying for it each time. Makes the per-step cost flat instead of growing.
	// A caller whose prompt mixes stable text with per-turn facts sends BLOCKS instead (#768).
	if (system) anthropicBody.system = system;

	// Convert tools to Anthropic format (deduplicate by name)
	if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
		const seen = new Set<string>();
		anthropicBody.tools = [];
		for (const t of body.tools as Array<{ type: string; function?: { name: string; description: string; parameters: unknown }; name?: string; description?: string; parameters?: unknown }>) {
			const name = t.function?.name || t.name;
			if (!name || seen.has(name)) continue;
			seen.add(name);
			(anthropicBody.tools as unknown[]).push({
				name,
				description: t.function?.description || t.description || "",
				input_schema: t.function?.parameters || t.parameters || { type: "object", properties: {} },
			});
		}
		// `none` declares the tools without permitting a call (#398). The caller that needs it is
		// the one producing a FINAL answer after a structured tool round: the provider requires
		// `tools` to be defined whenever the messages contain `tool_use`/`tool_result`, and simply
		// omitting them — which is how the final call used to discourage another round — turns the
		// whole request into a 400 the moment the transcript is in the structured protocol.
		if (body.toolChoice === "none") anthropicBody.tool_choice = { type: "none" };
	}

	// STREAMED (#427). Not for the client — the caller still gets one whole message — but so the
	// deadline can measure SILENCE instead of LENGTH. Non-streamed, the 25s ceiling had to cover the
	// entire generation, which a 4,096-token reply cannot fit at any observed throughput: the tool
	// loop's second round failed by construction, twice on the same message, after the tool call had
	// already committed its side effects. See lib/ai-deadlines.ts for the three deadlines.
	anthropicBody.stream = true;

		const startedAt = Date.now();
		const firstTokenMs = body.streamDeadlines?.preContentMs ?? body.timeoutMs ?? AI_FIRST_TOKEN_TIMEOUT_MS;
		const silenceMs = body.streamDeadlines?.silenceMs ?? AI_STALL_TIMEOUT_MS;
		const totalMs = Math.min(AI_TOTAL_TIMEOUT_MS, body.streamDeadlines?.totalMs ?? AI_TOTAL_TIMEOUT_MS);
		return {
			model: String(anthropicBody.model),
			payload: anthropicBody,
			controller: new AbortController(),
			meta: { provider: "anthropic", model: String(anthropicBody.model) },
			deadlines: { startedAt, firstTokenMs, silenceMs, totalMs, firstTokenDeadline: startedAt + firstTokenMs, totalDeadline: startedAt + totalMs },
		};
	},

	async send(req, apiKey) {
		const { controller, meta, deadlines } = req;
		try {
			return await withDeadline(
				fetch("https://api.anthropic.com/v1/messages", {
					method: "POST",
					headers: {
						"x-api-key": apiKey,
						"anthropic-version": "2023-06-01",
						"Content-Type": "application/json",
					},
					body: JSON.stringify(req.payload),
					signal: controller.signal,
				}),
				deadlines.firstTokenDeadline - Date.now(),
				"first-token",
				deadlines.firstTokenMs,
			);
		} catch (err) {
			controller.abort();
			throw asProviderError(err, meta) ?? err;
		}
	},

	async parseError(res, _req, apiKey): Promise<ProviderErrorWire> {
		// An error is still a plain JSON body even with `stream: true` — the provider only opens the
		// event stream once the request is accepted.
		const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		const errObj = (errBody as { error?: { message?: string; type?: string } }).error;
		const errMsg = errObj?.message || JSON.stringify(errBody);
		// Decided ONCE (#1356, `provider-error-kind.ts`); the hold, the hint and the error all read it. An exhausted balance arrives as a 400
		// `invalid_request_error` — the same status and type as a malformed request — with the sentence as its only signature (#773). The
		// vendor's text is kept verbatim (it is what `coding-failure.ts` falls back to classifying on) and the remedy follows it.
		const kind = classifyAnthropicError({ status: res.status, message: errMsg });
		return {
			kind,
			message: `Anthropic (${res.status}): ${errMsg}${providerFacts(errObj?.type, res.headers.get("request-id"))}${anthropicRemedy(kind, { status: res.status, keyHint: keyHint(apiKey) })}`,
			status: res.status === 401 || res.status === 403 ? 400 : 502,
			upstreamStatus: res.status,
			details: errBody,
			// A 5xx (including 529 `overloaded_error`) is the provider saying "not me, not now" — worth one immediate retry (#518). A 4xx is
			// not: a bad key, a model the key cannot reach, or a rate limit are all still true a second later, and 429 in particular wants a
			// backoff this path does not have.
			retryable: res.status >= 500,
		};
	},

	async readSuccess(res, req) {
		const { controller, meta, deadlines } = req;
		let data: AnthropicMessageBody;
		try {
			data = await readAnthropicStream(res, deadlines);
		} catch (err) {
			controller.abort();
			throw asProviderError(err, meta) ?? err;
		}
		if (!data.content.length) {
			throw new UserAiProviderError("Anthropic: the reply arrived empty — no content blocks", 502);
		}
		return data;
	},

	usage(data) {
	const u = data.usage;
	// Kept SEPARATE, not summed (#212). Anthropic bills a cache read at 0.1x input and a cache
	// write at 1.25x; folding all three into `input` priced every read at the full rate and made
	// the cache invisible — you could not tell a hit from a miss, so you could not tell whether
	// caching was working before changing a prompt to make it work better.
	return {
		input: u.input_tokens || 0,
		output: u.output_tokens || 0,
		cacheRead: u.cache_read_input_tokens || 0,
		cacheWrite: u.cache_creation_input_tokens || 0,
		cacheWrite1h: u["cache_creation.ephemeral_1h_input_tokens"] || 0,
		toolCalls: data.content.filter((c) => c.type === "tool_use").length,
	};
	},

	toResult(data, req) {
		const meta = req.meta;
		// Convert Anthropic response to Workers AI format for compatibility
		const content = data.content;
		const textParts = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
		const toolUse = content.filter((c) => c.type === "tool_use");
		const { toolCalls: _calls, ...usage } = anthropicAdapter.usage(data);
	// WHY the response carries the provider's verdict (#397): `stop_reason: "max_tokens"` sits in
	// this same body, one key away from the `content` and `usage` already read, and dropping it made
	// a reply cut off at the cap indistinguishable from one that finished. A caller cannot recover
	// the fact later — the truncated text looks like prose that simply ended. Surfaced on BOTH
	// returns, because a round that stops mid-`tool_use` is the same loss with worse consequences.
	const stopReason = typeof data.stop_reason === "string" ? data.stop_reason : undefined;

	if (toolUse.length > 0) {
		return {
			response: textParts,
			tool_calls: toolUse.map((t) => ({
				name: t.name,
				arguments: t.input || {},
				// The id is what makes a result ATTRIBUTABLE (#398). Dropping it is why the follow-up
				// context read `[repo_read_file]: <contents>` with no path: call one tool twice in a
				// round with different arguments and the model had to infer which result was which.
				id: t.id,
			})),
			// The assistant turn EXACTLY as the provider produced it, so the caller can append it and
			// answer its `tool_use` blocks with real `tool_result`s instead of narrating them back as
			// the model's own prose. Named `contentBlocks` rather than `content` so it cannot be
			// mistaken for a message's content field. Absent on every non-Anthropic provider, which
			// is how the caller branches without a provider enum to keep in sync.
			contentBlocks: content,
			inference: meta,
			usage,
			stopReason,
		};
	}
	return { response: textParts, usage, stopReason, inference: meta };
	},

	remedy: anthropicRemedy,
	credentialRef: (apiKey) => apiKey,
};
