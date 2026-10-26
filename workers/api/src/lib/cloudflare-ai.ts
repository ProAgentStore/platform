/**
 * The Cloudflare Workers AI adapter (#1356): the REST request, the refusal read once into a kind, and the result in the one shape every brain
 * reads. Moved out of `user-ai.ts` unchanged in behaviour; the driver that observes the account and records the call is shared with Anthropic.
 *
 * Still non-streamed, and correctly so: this is the path for a user with Cloudflare credentials and no Anthropic key, where the model is
 * `llama-3.2-3b` and the REST endpoint's default output is a few hundred tokens — a total-time deadline is the right measurement for a
 * call that short. It shares the CONSTANT with the Anthropic path so there is one 25 in the codebase, not two.
 */
import { AI_FIRST_TOKEN_TIMEOUT_MS, deadlineMessage } from "./ai-deadlines.js";
import { clipMarked } from "./clip-marked.js";
import { redactCloudflareUpstream } from "./cloudflare-redact.js";
import type { StoredCloudflareAiCredentials } from "./cloudflare-credentials.js";
import { isSystemPromptBlocks, isUserPromptBlocks, systemPromptText } from "./anthropic-prompt.js";
import { type ProviderAdapter, type ProviderErrorWire, providerFacts } from "./provider-adapter.js";
import { classifyCloudflareError } from "./provider-error-kind.js";
import { UserAiProviderError, UserAiUnsupportedInputError } from "./user-ai-errors.js";
import { fromWorkersAiResult, toWorkersAiBody, WorkersAiUnsupportedContentError, workersAiModelFor } from "./workers-ai-protocol.js";
import { workersAiToolCallCount } from "./usage.js";

/**
 * Workers AI takes the system prompt as a plain string, so blocks (#768) are joined back into
 * exactly the text a single-string builder would have sent. Anything else passes through untouched.
 */
function withFlatSystemPrompt(body: unknown): unknown {
	const messages = (body as { messages?: unknown })?.messages;
	if (!Array.isArray(messages)) return body;
	// A provider with no cache reads the same text: system blocks and user prompt blocks (#914) flattened.
	const flat = (m: { role?: string; content?: unknown }) => (m?.role === "system" && isSystemPromptBlocks(m.content)) || (m?.role === "user" && isUserPromptBlocks(m.content));
	if (!messages.some(flat)) return body;
	return {
		...(body as Record<string, unknown>),
		messages: messages.map((m) => (flat(m) ? { ...m, content: systemPromptText(m.content) } : m)),
	};
}

/** The Workers AI body, or the refusal — thrown before any request is made. */
function workersAiPayload(body: unknown): unknown {
	try {
		return toWorkersAiBody(withFlatSystemPrompt(body));
	} catch (e) {
		if (e instanceof WorkersAiUnsupportedContentError) throw new UserAiUnsupportedInputError(e.message, 400);
		throw e;
	}
}

/** A request prepared for sending. */
export interface CloudflareRequest {
	model: string;
	/** The platform's callers speak one provider-neutral body (#851); `/run` is a public passthrough that must reach the caller untouched. */
	platform: boolean;
	payload: unknown;
	timeoutMs: number;
}

/** A Workers AI reply: the parsed JSON, whatever shape the model has. */
type CloudflareRaw = unknown;

export const cloudflareAdapter: ProviderAdapter<StoredCloudflareAiCredentials, CloudflareRequest, CloudflareRaw> = {
	id: "cloudflare",

	buildRequest(body, model, ctx) {
		const platform = ctx?.kind !== "run";
		// The brains name an Anthropic model; on this path that is a URL that does not exist.
		const resolved = platform ? workersAiModelFor(model) : model;
		// Built first: content this path cannot carry is refused before any request or timer (#853).
		const payload = platform ? workersAiPayload(body) : withFlatSystemPrompt(body);
		return { model: resolved, platform, payload, timeoutMs: (body as { timeoutMs?: number })?.timeoutMs ?? AI_FIRST_TOKEN_TIMEOUT_MS };
	},

	async send(req, credentials) {
		const encodedModel = req.model.split("/").map(encodeURIComponent).join("/");
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), req.timeoutMs);
		try {
			return await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/ai/run/${encodedModel}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(req.payload),
				signal: controller.signal,
			});
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				// A non-streamed call that ran out of time IS the total-budget failure, so it reads as one.
				throw new UserAiProviderError(deadlineMessage("total", req.timeoutMs), 504);
			}
			throw err;
		} finally {
			clearTimeout(timeout);
		}
	},

	async parseError(res, _req, credentials): Promise<ProviderErrorWire> {
		const data = await res.json().catch(() => ({}));
		const kind = classifyCloudflareError({ status: res.status });
		// `details` reaches the verify response and the error log; Cloudflare's errors quote the account path, which holds a token when the
		// two were saved swapped (#893).
		const redacted = redactCloudflareUpstream(data, credentials);
		const first = (redacted as { errors?: Array<{ code?: unknown; message?: unknown }> })?.errors?.[0];
		const said = typeof first?.message === "string" ? `: ${clipMarked(first.message, 300, { within: true })}` : "";
		return {
			kind,
			message: `Cloudflare Workers AI request failed with HTTP ${res.status}${said}${providerFacts(first?.code != null ? `code ${String(first.code)}` : null, res.headers.get("cf-ray"))}`,
			status: res.status === 401 || res.status === 403 ? 400 : 502,
			upstreamStatus: res.status,
			details: redacted,
			retryable: false,
		};
	},

	async readSuccess(res) {
		return res.json().catch(() => ({}));
	},

	usage(data) {
		// CF Workers AI is per-neuron (cost ~0), but still emit a ledger row with token counts when the response carries usage, so the Usage
		// page shows CF calls too.
		const cu = (data as { usage?: Record<string, number> })?.usage || {};
		return { input: cu.prompt_tokens || cu.input_tokens || 0, output: cu.completion_tokens || cu.output_tokens || 0, toolCalls: workersAiToolCallCount(data) };
	},

	toResult(data, req) {
		// One result shape for every brain, whichever habit the model has (#851) — see workers-ai-protocol.
		const result = data && typeof data === "object" && "result" in data ? (data as { result: unknown }).result : data;
		return req.platform ? { ...fromWorkersAiResult(result, (req.payload as { max_tokens?: number }).max_tokens), inference: { provider: "cloudflare", model: req.model } } : result;
	},

	// Cloudflare errors carry no owner-facing remedy of their own today: the provider's message and code are the whole sentence.
	remedy: () => "",
	credentialRef: (credentials) => credentials,
};
