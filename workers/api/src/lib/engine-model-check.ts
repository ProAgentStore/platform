/**
 * Check a pinned model id against the machine's own model list before saving it (#1199).
 *
 * `coding_engine_set` accepted any well-formed id and wrote it into the launch command, so `grok --model grok-4` was
 * saved and the session failed at its next turn: xAI's Grok CLI answers "unknown model id". The machine knows which
 * ids its CLI offers — `grok models`, asked over the relay (`POST /coding/engine-models`, CLI
 * {@link ENGINE_MODELS_MIN_CLI}) — so an id it does not list is refused, with the list.
 *
 * Only Grok publishes such a list. For Claude Code, Codex and Gemini — and when no runner is connected, or it is too old
 * to answer — the id is saved UNCHECKED and the answer says so (`validated: false` with the reason), rather than
 * refusing a choice nothing here can judge. Each machine's list is cached for {@link ENGINE_MODELS_TTL_MS}.
 */
import { HttpError } from "./auth.js";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS } from "./runner-client.js";
import type { Env } from "../types.js";

/** The CLI release whose runner answers `/coding/engine-models`. */
export const ENGINE_MODELS_MIN_CLI = "0.4.161";

/** How long one machine's model list is trusted. */
export const ENGINE_MODELS_TTL_MS = 5 * 60_000;

export interface ModelCheck {
	/** The machine's CLI listed the id. False: it was saved unchecked, for `reason`. */
	validated: boolean;
	reason?: string;
}

interface Listed {
	models: string[] | null;
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
	ask: (body: { clientType: string; command: string }) => Promise<{ node: string; models: string[] | null; reason?: string } | null>;
	now: () => number;
}

function liveDeps(env: Env, instanceId: string, userId: string): ModelListDeps {
	return {
		ask: async (body) => {
			const conn = await getBoundRunnerConn(env, instanceId, userId).catch(() => null);
			if (!conn) return null;
			const r = await callRunner<{ models?: unknown; reason?: unknown }>(conn, "/coding/engine-models", body, { timeoutMs: READ_TIMEOUT_MS });
			const models = Array.isArray(r?.models) ? r.models.filter((m): m is string => typeof m === "string") : null;
			return { node: conn.runnerNode ?? instanceId, models, ...(typeof r?.reason === "string" ? { reason: r.reason } : {}) };
		},
		now: Date.now,
	};
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
	if (engine.clientType !== "grok") return { validated: false, reason: `the ${engine.clientType} CLI publishes no model list, so the id was saved unchecked` };
	const key = `${instanceId}:${engine.clientType}:${engine.command}`;
	let listed = cache.get(key);
	if (!listed || deps.now() - listed.at > ENGINE_MODELS_TTL_MS) {
		let answer: Awaited<ReturnType<ModelListDeps["ask"]>>;
		try {
			answer = await deps.ask({ clientType: engine.clientType, command: engine.command });
		} catch (e) {
			const old = e instanceof Error && /→ 404/.test(e.message);
			return { validated: false, reason: old ? `this machine's runner cannot list models (CLI ${ENGINE_MODELS_MIN_CLI} or newer), so the id was saved unchecked` : "the machine could not be asked for its model list, so the id was saved unchecked" };
		}
		if (!answer) return { validated: false, reason: "no runner is connected to ask for the model list, so the id was saved unchecked" };
		listed = { models: answer.models, ...(answer.reason ? { reason: answer.reason } : {}), at: deps.now() };
		// Only a real list is cached: "could not list" is worth asking again next time.
		if (answer.models) cache.set(key, listed);
	}
	if (!listed.models) return { validated: false, reason: `${listed.reason ?? "the CLI listed no models"}, so the id was saved unchecked` };
	if (listed.models.includes(model)) return { validated: true };
	throw new HttpError(400, `"${model}" is not a model ${engine.label} offers on this machine — choose one of: ${listed.models.join(", ")}.`);
}
