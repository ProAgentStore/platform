/**
 * Check a pinned model id against the machine's own model list before saving it (#1199).
 *
 * `coding_engine_set` accepted any well-formed id and wrote it into the launch command, so `grok --model grok-4` was
 * saved and the session failed at its next turn: xAI's Grok CLI answers "unknown model id". The machine knows which
 * ids its CLI offers — `grok models`, asked over the relay (`POST /coding/engine-models`, CLI
 * {@link ENGINE_MODELS_MIN_CLI}) — so an id it does not list is refused, with the list.
 *
 * Only Grok's CLI publishes such a list. For Claude Code, Codex and Gemini (#1206) the runner asks the PROVIDER's own
 * list instead, with an API key the machine already holds (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) — the
 * usual subscription login has none. Where no list can be had — no key, no runner connected, one too old to answer —
 * the id is saved UNCHECKED and the answer says so (`validated: false` with the reason), rather than refusing a choice
 * nothing here can judge. Each machine's list is cached for {@link ENGINE_MODELS_TTL_MS}.
 */
import { HttpError } from "./auth.js";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS } from "./runner-client.js";
import type { Env } from "../types.js";

/** The CLI release whose runner answers `/coding/engine-models`. */
export const ENGINE_MODELS_MIN_CLI = "0.4.161";

/** How long one machine's model list is trusted. */
export const ENGINE_MODELS_TTL_MS = 5 * 60_000;

/** A refusal names at most this many models; a provider's list can run to a hundred. */
const MAX_LISTED = 40;

/**
 * Claude Code's own model aliases (`opus`, `sonnet`, `haiku`, `fable`, `opusplan`, `default`, `best`, with an optional
 * `[1m]` context suffix) are not in Anthropic's `/v1/models`, which lists only full ids — so a list from the provider
 * must never refuse them.
 */
export function isClaudeAlias(model: string): boolean {
	return /^(?:opus|sonnet|haiku|fable|opusplan|default|best)(?:\[1m\])?$/i.test(model);
}

export interface ModelCheck {
	/** The machine's CLI listed the id. False: it was saved unchecked, for `reason`. */
	validated: boolean;
	reason?: string;
}

interface Listed {
	models: string[] | null;
	defaultModel?: string | null;
	reason?: string;
	at: number;
}

const cache = new Map<string, Listed>();

/** For tests. */
export function clearEngineModelCache(): void {
	cache.clear();
}

export interface ModelListDeps {
	/** The machine's answer, or null when no runner is connected. Throws as the relay does. */
	ask: (body: { clientType: string; command: string }) => Promise<{ node: string; models: string[] | null; defaultModel?: string | null; reason?: string } | null>;
	now: () => number;
}

function liveDeps(env: Env, instanceId: string, userId: string): ModelListDeps {
	return {
		ask: async (body) => {
			const conn = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
			if (!conn) return null;
			const r = await callRunner<{ models?: unknown; defaultModel?: unknown; reason?: unknown }>(conn, "/coding/engine-models", body, { timeoutMs: READ_TIMEOUT_MS });
			const models = Array.isArray(r?.models) ? r.models.filter((m): m is string => typeof m === "string") : null;
			return { node: conn.runnerNode ?? instanceId, models, defaultModel: typeof r?.defaultModel === "string" ? r.defaultModel : null, ...(typeof r?.reason === "string" ? { reason: r.reason } : {}) };
		},
		now: Date.now,
	};
}

/**
 * The models the machine's `clientType` CLI offers right now — shared by the model check below and the model
 * dropdown's suggestions (#1202), through one cache. `models: null` with the reason when there is no list to have.
 */
export async function liveModelList(
	env: Env,
	instanceId: string,
	userId: string,
	engine: { clientType: string; command: string },
	deps: ModelListDeps = liveDeps(env, instanceId, userId),
): Promise<{ models: string[] | null; defaultModel?: string | null; reason: string | null }> {
	if (!["grok", "claude", "codex", "gemini"].includes(engine.clientType)) return { models: null, reason: `the ${engine.clientType} CLI publishes no model list` };
	// Keyed by the BINARY, not the whole command: pinning a model rewrites the command (`--model …`), and the list the
	// machine's CLI offers does not change with which of its models is pinned.
	const key = `${instanceId}:${engine.clientType}:${engine.command.trim().split(/\s+/)[0] ?? ""}`;
	const cached = cache.get(key);
	if (cached && deps.now() - cached.at <= ENGINE_MODELS_TTL_MS) return { models: cached.models, defaultModel: cached.defaultModel ?? null, reason: null };
	let answer: Awaited<ReturnType<ModelListDeps["ask"]>>;
	try {
		answer = await deps.ask({ clientType: engine.clientType, command: engine.command });
	} catch (e) {
		const old = e instanceof Error && /→ 404/.test(e.message);
		return { models: null, reason: old ? `this machine's runner cannot list models (CLI ${ENGINE_MODELS_MIN_CLI} or newer)` : "the machine could not be asked for its model list" };
	}
	if (!answer) return { models: null, reason: "no runner is connected to ask for the model list" };
	// Only a real list is cached: "could not list" is worth asking again next time.
	if (answer.models) cache.set(key, { models: answer.models, defaultModel: answer.defaultModel ?? null, at: deps.now() });
	return { models: answer.models, defaultModel: answer.defaultModel ?? null, reason: answer.models ? null : (answer.reason ?? "the CLI listed no models") };
}

/**
 * Is `model` one the machine's `clientType` CLI offers? Refuses (400, naming the list) when the machine listed models
 * and this is not among them; otherwise answers whether it could be checked at all.
 */
export async function checkEngineModel(
	env: Env,
	instanceId: string,
	userId: string,
	engine: { clientType: string; command: string; label: string },
	model: string,
	deps: ModelListDeps = liveDeps(env, instanceId, userId),
): Promise<ModelCheck> {
	const listed = await liveModelList(env, instanceId, userId, engine, deps);
	if (!listed.models) return { validated: false, reason: `${listed.reason ?? "the CLI listed no models"}, so the id was saved unchecked` };
	if (listed.models.includes(model) || (engine.clientType === "claude" && isClaudeAlias(model))) return { validated: true };
	const shown = listed.models.filter((_, i) => i < MAX_LISTED); // marked below, not a silent cut
	const more = listed.models.length - shown.length;
	throw new HttpError(400, `"${model}" is not a model ${engine.label} offers on this machine — choose one of: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`);
}
