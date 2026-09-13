import { decryptKey } from "./crypto.js";
import { backfillKeyHint } from "./key-hint-backfill.js";
import {
	AI_FIRST_TOKEN_TIMEOUT_MS,
	AI_STALL_TIMEOUT_MS,
	AI_TOTAL_TIMEOUT_MS,
	type AiDeadlineKind,
	connectionLostMessage,
	deadlineMessage,
	isRetryableDeadline,
} from "./ai-deadlines.js";
import {
	AnthropicStreamAssembler,
	AnthropicStreamError,
	type AnthropicMessageBody,
	parseSseEvents,
} from "./anthropic-stream.js";
import { endOnUserTurn, mergeContent, pairToolBlocks } from "./anthropic-tool-turns.js";
import { recordUsage, type UsageContext } from "./usage.js";
import { logPromptSectionEstimates } from "./prompt-section-estimates.js";
import type { Env } from "../types.js";

export class UserAiCredentialsError extends Error {
	constructor(
		message = "Add your Cloudflare Workers AI account ID and API token before running this agent.",
		public readonly status = 402,
	) {
		super(message);
		this.name = "UserAiCredentialsError";
	}
}

export class UserAiProviderError extends Error {
	/**
	 * How many SSE events the assembler accepted before the stall deadline fired.
	 *
	 * Set only on a stall or first-token deadline, where the stream had opened. Absent on every
	 * other kind of failure. Recorded by `recordCodingFailure` into `error_log.context` so a reader
	 * can tell whether the silence began before or after the first content byte (#734).
	 */
	eventsSeen?: number;
	/** The `type` of the last SSE event accepted before silence — companion to `eventsSeen`. */
	lastEventType?: string;

	constructor(
		message: string,
		public readonly status = 502,
		public readonly upstreamStatus?: number,
		public readonly details?: unknown,
		/**
		 * Could an IDENTICAL immediate retry plausibly succeed? (#518)
		 *
		 * Set at the site that knows WHICH failure this is, because by the time it reaches a caller
		 * the only things left are a message and a 502/504 — and the three deadlines all report 504
		 * while disagreeing completely about whether retrying helps. Read by
		 * `autoResumableRoundOf`, which is what decides whether the platform performs the retry its
		 * own error message recommends. Defaults to false: a failure nobody classified is one
		 * nobody has established is transient, and the cost of guessing wrong is the user's own
		 * provider credit.
		 */
		public readonly retryable = false,
	) {
		super(message);
		this.name = "UserAiProviderError";
	}
}

/**
 * Does a provider's error sentence say the account is out of money? (#773)
 *
 * Anthropic: "Your credit balance is too low to access the Anthropic API." Matched loosely on the
 * noun phrase rather than the whole sentence, so a reworded suffix does not silently drop the hint.
 * The classifier in `coding-failure.ts` matches the same phrase; the two are kept in step by
 * `user-ai.test.ts`, which feeds the live wording to both.
 */
export function isCreditBalanceMessage(message: string): boolean {
	const m = message.toLowerCase();
	return m.includes("credit balance") || m.includes("insufficient_funds") || m.includes("insufficient credit");
}

interface StoredCloudflareAiCredentials {
	accountId: string;
	token: string;
}

/**
 * Run AI inference using the user's stored API key.
 * Priority: Anthropic Claude > Cloudflare Workers AI.
 * BYOK: uses whatever provider the user has configured.
 */
export async function runUserWorkersAi(
	env: Env,
	userId: string | undefined,
	model: string,
	body: unknown,
	ctx?: UsageContext,
): Promise<unknown> {
	if (ctx?.promptSections?.length) {
		await logPromptSectionEstimates(env, {
			userId,
			instanceId: ctx.instanceId ?? null,
			traceId: ctx.traceId ?? null,
			source: ctx.promptSource ?? ctx.kind,
			kind: ctx.kind,
			model,
			phase: ctx.promptPhase ?? null,
			sections: ctx.promptSections,
		});
	}
	// BYOK: try providers in order of what the user has configured
	const anthropicKey = await getUserProviderKey(env, userId, "anthropic");
	if (anthropicKey) {
		// content is usually a string, but may be an array of content blocks (e.g. a
		// PDF `document` block for résumé parsing) — passed straight through to Anthropic.
		return runAnthropic(env, userId, anthropicKey, body as { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; toolChoice?: "auto" | "none"; maxTokens?: number; timeoutMs?: number }, ctx);
	}

	const cfCredentials = await getUserCloudflareAiCredentials(env, userId).catch(() => null);
	if (cfCredentials) {
		return runCloudflareAi(env, userId, cfCredentials, model, body, ctx);
	}

	throw new UserAiCredentialsError("Add an API key in Profile → API Keys (Anthropic or Cloudflare Workers AI).");
}

/**
 * Anthropic's Messages API rejects any array whose first message isn't `user` or
 * whose roles don't strictly alternate. Our chat history routinely violates both:
 * a 10-message context window can start on `assistant` (turn 6+), an errored turn
 * leaves two adjacent `user` messages once the `system` error note is filtered out,
 * and the tool loop appends `assistant, user, user`. Normalize before sending:
 * drop leading assistants, then merge consecutive same-role messages into one.
 *
 * It now also knows about `tool_use` / `tool_result` blocks (#398). It has to: those are the two
 * block types the API pairs across turns, and this function is the only thing between the caller's
 * array and the wire that DROPS and MERGES turns. Its merge of consecutive same-role turns is
 * exactly what used to erase the boundary between a platform result and the model's own prose, and
 * left unchanged it would now bury a `tool_result` behind a trailing string or orphan one behind a
 * dropped leading assistant — both of which the provider answers with a 400 on the whole request.
 * The rules are pure and live in lib/anthropic-tool-turns.ts with their tests.
 */
function normalizeForAnthropic(
	msgs: Array<{ role: string; content: unknown }>,
): Array<{ role: "user" | "assistant"; content: unknown }> {
	const mapped = msgs.map((m) => ({
		role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
		content: m.content,
	}));
	let start = 0;
	while (start < mapped.length && mapped[start].role === "assistant") start++;
	// …and the same rule at the OTHER end (#429). Serialising chat turns made a history whose tail
	// is `user, user, assistant` — the mid-turn arrival is stored when it arrives, the running
	// turn's reply when it finishes — and a trailing assistant turn is a PREFILL, which
	// `claude-sonnet-4-6` refuses with a 400 on the whole request. Before merging, deliberately:
	// merged first, the two user turns become one and the array still ends on the assistant.
	const ordered = endOnUserTurn(mapped.slice(start));
	// Pair BEFORE merging: an orphan is created by the drop above, and merging first would fold it
	// into a neighbouring turn where "which turn introduced this id" is no longer answerable.
	const paired = pairToolBlocks(ordered);
	const merged: Array<{ role: "user" | "assistant"; content: unknown }> = [];
	for (const m of paired) {
		const last = merged[merged.length - 1];
		if (last && last.role === m.role) {
			last.content = mergeContent(last.content, m.content);
		} else {
			merged.push({ role: m.role, content: m.content });
		}
	}
	return merged;
}

/**
 * One ordered part of a system prompt (#768).
 *
 * A system message's `content` is either a string — one block, cached whole, which is what every
 * caller sent before this — or an array of these. The array exists because the provider's cache
 * matches an identical PREFIX: a chat prompt that interleaves per-turn facts (the clock, retrieved
 * documents, the terminal tail) with fixed instructions changes early, so everything after the
 * first changing byte is re-written to the cache on every turn. Splitting it lets the fixed part
 * be read back instead.
 *
 * `cache` places a breakpoint at the END of the block. `label` names the block in prompt-section
 * traces and is never sent.
 */
export interface SystemPromptBlock {
	text: string;
	cache?: boolean;
	label?: string;
}

/** Anthropic accepts at most four cache breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

export function isSystemPromptBlocks(content: unknown): content is SystemPromptBlock[] {
	return Array.isArray(content) && content.every((b) => b !== null && typeof b === "object" && typeof (b as SystemPromptBlock).text === "string");
}

/**
 * The system prompt as ONE string, for a provider with no notion of blocks.
 *
 * Joined with nothing, because the builders already open each section with its own newlines: the
 * flattened text is byte-identical to what a single string builder would have produced.
 */
export function systemPromptText(content: unknown): string {
	return isSystemPromptBlocks(content) ? content.map((b) => b.text).join("") : String(content ?? "");
}

/**
 * Prompt-section trace entries for a system message: one per block (#768), so a run's trace shows
 * the cached half and the per-turn half separately — the split is only worth what that difference
 * measures. A string stays one section under `label`, as it was traced before.
 */
export function systemPromptSections(label: string, content: unknown): Array<{ label: string; value: unknown }> {
	return isSystemPromptBlocks(content) ? content.map((b) => ({ label: `${label}.${b.label ?? "block"}`, value: b.text })) : [{ label, value: content }];
}

/**
 * The Anthropic `system` field for a system message's content.
 *
 * A string becomes one cached block, as it always has. Blocks keep their order; empty ones are
 * dropped (the API rejects an empty text block, and an absent section is simply absent); a
 * breakpoint goes on each block marked `cache`, keeping the LAST four when more are asked for —
 * a later breakpoint already covers the prefix before it, so it is the earlier ones that are
 * redundant. Returns undefined when nothing is left to send.
 */
type AnthropicSystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

export function anthropicSystemBlocks(content: unknown): AnthropicSystemBlock[] | undefined {
	if (!isSystemPromptBlocks(content)) {
		const text = String(content ?? "");
		return text ? [{ type: "text", text, cache_control: { type: "ephemeral" } }] : undefined;
	}
	const kept = content.filter((b) => b.text.length > 0);
	if (!kept.length) return undefined;
	const cached = kept.filter((b) => b.cache);
	const breakpoints = new Set(cached.slice(-MAX_CACHE_BREAKPOINTS));
	return kept.map((b): AnthropicSystemBlock =>
		breakpoints.has(b) ? { type: "text", text: b.text, cache_control: { type: "ephemeral" } } : { type: "text", text: b.text },
	);
}

async function runAnthropic(
	env: Env,
	userId: string | undefined,
	apiKey: string,
	body: { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; toolChoice?: "auto" | "none"; maxTokens?: number; timeoutMs?: number },
	ctx?: UsageContext,
): Promise<unknown> {
	const messages = normalizeForAnthropic((body.messages || []).filter((m) => m.role !== "system"));
	const systemMsg = (body.messages || []).find((m) => m.role === "system");

	const anthropicBody: Record<string, unknown> = {
		model: "claude-sonnet-4-6",
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
	if (systemMsg) {
		const system = anthropicSystemBlocks(systemMsg.content);
		if (system) anthropicBody.system = system;
	}

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
	const firstTokenMs = body.timeoutMs ?? AI_FIRST_TOKEN_TIMEOUT_MS;
	const firstTokenDeadline = startedAt + firstTokenMs;
	const totalDeadline = startedAt + AI_TOTAL_TIMEOUT_MS;
	const controller = new AbortController();
	let res: Response;
	try {
		res = await withDeadline(
			fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: {
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(anthropicBody),
				signal: controller.signal,
			}),
			firstTokenDeadline - Date.now(),
			"first-token",
			firstTokenMs,
		);
	} catch (err) {
		controller.abort();
		throw asProviderError(err) ?? err;
	}

	if (!res.ok) {
		// An error is still a plain JSON body even with `stream: true` — the provider only opens the
		// event stream once the request is accepted — so this branch is unchanged.
		const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		const errObj = (errBody as { error?: { message?: string; type?: string } }).error;
		const errMsg = errObj?.message || JSON.stringify(errBody);
		// An exhausted balance arrives as a 400 `invalid_request_error` — the same status and type as
		// a malformed request — with the sentence as its only signature (#773). The vendor's text is
		// kept verbatim (it is what `coding-failure.ts` classifies on) and the remedy is appended in
		// the same shape as the 401 hint, so the owner reads which page to go to rather than which
		// endpoint said no.
		const hint = res.status === 404
			? " — Your API key may not have access to this model. Get a key from console.anthropic.com/settings/keys"
			: res.status === 401
				? " — Invalid API key. Update it in Profile → API Keys → Anthropic"
				: res.status === 400 && isCreditBalanceMessage(errMsg)
					? " — Insufficient Anthropic credit balance. Top up at console.anthropic.com/settings/billing"
					: "";
		throw new UserAiProviderError(
			`Anthropic (${res.status}): ${errMsg}${hint}`,
			res.status === 401 || res.status === 403 ? 400 : 502,
			res.status,
			errBody,
			// A 5xx (including 529 `overloaded_error`) is the provider saying "not me, not now" —
			// worth one immediate retry (#518). A 4xx is not: a bad key, a model the key cannot
			// reach, or a rate limit are all still true a second later, and 429 in particular wants
			// a backoff this path does not have.
			res.status >= 500,
		);
	}

	let data: AnthropicMessageBody;
	try {
		data = await readAnthropicStream(res, { firstTokenDeadline, totalDeadline, firstTokenMs });
	} catch (err) {
		controller.abort();
		throw asProviderError(err) ?? err;
	}
	if (!data.content.length) {
		throw new UserAiProviderError("Anthropic: the reply arrived empty — no content blocks", 502);
	}

	await env.DB.prepare(
		"UPDATE user_api_keys SET last_used_at = datetime('now') WHERE user_id = ?1 AND provider = 'anthropic'",
	).bind(userId).run();

	// Convert Anthropic response to Workers AI format for compatibility
	const content = data.content;
	const textParts = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
	const toolUse = content.filter((c) => c.type === "tool_use");
	const u = data.usage;
	// Kept SEPARATE, not summed (#212). Anthropic bills a cache read at 0.1x input and a cache
	// write at 1.25x; folding all three into `input` priced every read at the full rate and made
	// the cache invisible — you could not tell a hit from a miss, so you could not tell whether
	// caching was working before changing a prompt to make it work better.
	const usage = {
		input: u.input_tokens || 0,
		output: u.output_tokens || 0,
		cacheRead: u.cache_read_input_tokens || 0,
		cacheWrite: u.cache_creation_input_tokens || 0,
	};

	// Ledger the call for the Usage page. Best-effort: recordUsage swallows all errors,
	// so it can never break the AI call — it's a small awaited D1 insert on the return path.
	if (ctx) {
		await recordUsage(env, { ...ctx, userId, provider: "anthropic", model: (anthropicBody.model as string) || "claude-sonnet-4-6" }, usage);
	}

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
			usage,
			stopReason,
		};
	}
	return { response: textParts, usage, stopReason };
}

/** One deadline ran out. Carries WHICH, because the three mean different things to the user. */
class DeadlineExceeded extends Error {
	/** How many SSE events the assembler accepted before silence — annotated by readAnthropicStream. */
	eventsSeen?: number;
	/** The `type` of the last accepted event — annotated by readAnthropicStream. */
	lastEventType?: string;

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
function asProviderError(err: unknown): UserAiProviderError | null {
	if (err instanceof DeadlineExceeded) {
		// Retryability comes from the SAME table the sentence does (#518), so what the platform does
		// automatically is what the platform told the user to do.
		const provErr = new UserAiProviderError(deadlineMessage(err.kind, err.budgetMs), 504, undefined, undefined, isRetryableDeadline(err.kind));
		// Thread the stream state so `recordCodingFailure` can write what the assembler had seen
		// before the silence — the fact that settles whether a stall is pre- or post-content (#734).
		if (err.eventsSeen !== undefined) provErr.eventsSeen = err.eventsSeen;
		if (err.lastEventType !== undefined) provErr.lastEventType = err.lastEventType;
		return provErr;
	}
	// A malformed or truncated stream is a transport fact — a lost frame, a mid-stream
	// `overloaded_error`, tool arguments that arrived half-written. A fresh generation is a fresh
	// stream, so this is worth exactly one retry.
	if (err instanceof AnthropicStreamError) return new UserAiProviderError(`Anthropic: ${err.message}`, 502, undefined, undefined, true);
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
	deadlines: { firstTokenDeadline: number; totalDeadline: number; firstTokenMs: number },
): Promise<AnthropicMessageBody> {
	if (!res.body) throw new UserAiProviderError("Anthropic: the response carried no body to stream", 502);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const assembler = new AnthropicStreamAssembler();
	let buffer = "";
	let first = true;
	try {
		for (;;) {
			const now = Date.now();
			const silenceDeadline = first ? deadlines.firstTokenDeadline : now + AI_STALL_TIMEOUT_MS;
			const kind: AiDeadlineKind =
				deadlines.totalDeadline < silenceDeadline ? "total" : first ? "first-token" : "stall";
			const budgetMs =
				kind === "total" ? AI_TOTAL_TIMEOUT_MS : kind === "first-token" ? deadlines.firstTokenMs : AI_STALL_TIMEOUT_MS;
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
				}
				throw e;
			}
			first = false;
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

/**
 * Workers AI takes the system prompt as a plain string, so blocks (#768) are joined back into
 * exactly the text a single-string builder would have sent. Anything else passes through untouched.
 */
function withFlatSystemPrompt(body: unknown): unknown {
	const messages = (body as { messages?: unknown })?.messages;
	if (!Array.isArray(messages)) return body;
	if (!messages.some((m) => m?.role === "system" && isSystemPromptBlocks(m.content))) return body;
	return {
		...(body as Record<string, unknown>),
		messages: messages.map((m) => (m?.role === "system" && isSystemPromptBlocks(m.content) ? { ...m, content: systemPromptText(m.content) } : m)),
	};
}

async function runCloudflareAi(
	env: Env,
	userId: string | undefined,
	credentials: StoredCloudflareAiCredentials,
	model: string,
	body: unknown,
	ctx?: UsageContext,
): Promise<unknown> {
	const encodedModel = model.split("/").map(encodeURIComponent).join("/");
	// Still non-streamed, and correctly so: this path is the fallback for a user with CF creds and no
	// Anthropic key, where the model is `llama-3.2-3b` and the REST endpoint's default output is a few
	// hundred tokens — a total-time deadline is the right measurement for a call that short. It shares
	// the CONSTANT with the Anthropic path so there is one 25 in the codebase, not two.
	const timeoutMs = (body as { timeoutMs?: number })?.timeoutMs ?? AI_FIRST_TOKEN_TIMEOUT_MS;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	let res: Response;
	try {
		res = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/ai/run/${encodedModel}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(withFlatSystemPrompt(body)),
				signal: controller.signal,
			},
		);
	} catch (err) {
		clearTimeout(timeout);
		if (err instanceof Error && err.name === "AbortError") {
			// A non-streamed call that ran out of time IS the total-budget failure, so it reads as one.
			throw new UserAiProviderError(deadlineMessage("total", timeoutMs), 504);
		}
		throw err;
	}
	clearTimeout(timeout);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new UserAiProviderError(
			`Cloudflare Workers AI request failed with HTTP ${res.status}`,
			res.status === 401 || res.status === 403 ? 400 : 502,
			res.status,
			data,
		);
	}
	await env.DB.prepare(
		"UPDATE user_api_keys SET last_used_at = datetime('now') WHERE user_id = ?1 AND provider = 'cloudflare'",
	).bind(userId).run();
	// CF Workers AI is per-neuron (cost ~0), but still emit a ledger row with token
	// counts when the response carries usage, so the Usage page shows CF calls too.
	if (ctx) {
		const cu = (data as { usage?: Record<string, number> })?.usage || {};
		await recordUsage(env, { ...ctx, userId, provider: "cloudflare", model }, {
			input: cu.prompt_tokens || cu.input_tokens || 0,
			output: cu.completion_tokens || cu.output_tokens || 0,
		});
	}
	if (data && typeof data === "object" && "result" in data) {
		return (data as { result: unknown }).result;
	}
	return data;
}

export async function getUserProviderKey(
	env: Env,
	userId: string | undefined,
	provider: string,
): Promise<string | null> {
	if (!userId || !env.KEY_ENCRYPTION_KEY) return null;
	const row = await env.DB.prepare(
		// `account_id` and `key_hint` ride along for the display-hint backfill (#780). The WHERE
		// deliberately does NOT name an account — this is the long-standing "give me a key for
		// this provider" read — so the account of the row `.first()` actually returned has to
		// come back with it. Backfilling under this same loose WHERE could stamp one account's
		// hint onto another's row, and a confidently wrong "which key is this" is worse than none.
		"SELECT key_ciphertext, dek_wrapped, iv, account_id, key_hint FROM user_api_keys WHERE user_id = ?1 AND provider = ?2",
	).bind(userId, provider).first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer; account_id: string; key_hint: string | null }>();
	if (!row) return null;
	try {
		const plaintext = await decryptKey(
			new Uint8Array(row.key_ciphertext),
			new Uint8Array(row.dek_wrapped),
			new Uint8Array(row.iv),
			env.KEY_ENCRYPTION_KEY,
		);
		// This is the path that decrypts the BYOK Anthropic key on every chat turn, so it is the
		// one that gives a pre-0146 key its hint without the owner re-entering anything. It costs
		// nothing once the hint exists: `backfillKeyHint` returns on `row.key_hint` before D1.
		await backfillKeyHint(env, userId, provider, row.account_id ?? "", plaintext, row.key_hint);
		return plaintext;
	} catch {
		return null;
	}
}

async function getUserCloudflareAiCredentials(
	env: Env,
	userId: string | undefined,
): Promise<StoredCloudflareAiCredentials> {
	if (!userId) throw new UserAiCredentialsError();
	if (!env.KEY_ENCRYPTION_KEY) {
		throw new Error("Key encryption not configured");
	}

	const row = await env.DB.prepare(
		// `account_id`/`key_hint`: see getUserProviderKey — the WHERE names no account, so the
		// hint backfill (#780) needs the row it actually got rather than a guessed slot.
		"SELECT key_ciphertext, dek_wrapped, iv, account_id, key_hint FROM user_api_keys WHERE user_id = ?1 AND provider = 'cloudflare'",
	)
		.bind(userId)
		.first<{
			key_ciphertext: ArrayBuffer;
			dek_wrapped: ArrayBuffer;
			iv: ArrayBuffer;
			account_id: string;
			key_hint: string | null;
		}>();
	if (!row) throw new UserAiCredentialsError();

	const raw = await decryptKey(
		new Uint8Array(row.key_ciphertext),
		new Uint8Array(row.dek_wrapped),
		new Uint8Array(row.iv),
		env.KEY_ENCRYPTION_KEY,
	);

	const credentials = parseCloudflareAiCredentials(raw);
	if (!credentials) {
		throw new UserAiCredentialsError(
			"Stored Cloudflare Workers AI credentials are invalid. Re-add your Cloudflare account ID and API token.",
		);
	}
	// `raw` is the `{accountId,token}` envelope; `keyHint` unwraps it so the hint names the token
	// the owner pasted, not the last four characters of the JSON encoding.
	await backfillKeyHint(env, userId, "cloudflare", row.account_id ?? "", raw, row.key_hint);
	return credentials;
}

export function encodeCloudflareAiCredentials(
	accountId: string,
	token: string,
): string {
	return JSON.stringify({ accountId, token });
}

export function parseCloudflareAiCredentials(
	raw: string,
): StoredCloudflareAiCredentials | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith("{")) {
		try {
			const data = JSON.parse(trimmed) as Partial<StoredCloudflareAiCredentials>;
			if (data.accountId?.trim() && data.token?.trim()) {
				return { accountId: data.accountId.trim(), token: data.token.trim() };
			}
		} catch {
			return null;
		}
		return null;
	}

	const separator = trimmed.indexOf(":");
	if (separator > 0) {
		const accountId = trimmed.slice(0, separator).trim();
		const token = trimmed.slice(separator + 1).trim();
		if (accountId && token) return { accountId, token };
	}

	return null;
}
