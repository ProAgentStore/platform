/**
 * Who may make an agent CODE on an API key (#1042).
 *
 * Owner policy: actual repository coding runs on a subscription-authenticated local CLI. An engine
 * preset whose sign-in is `api-key` (the engine gets ANTHROPIC/OPENAI/GEMINI/XAI_API_KEY and bills
 * per token) is allowed only after the owner chose it IN THE UI and confirmed a billing warning
 * naming the provider, model and billing source. That confirmation is recorded per preset as an
 * {@link ApiCodingOptIn}, bound to the preset's exact launch command — so a later change of model,
 * by any path, is a new billing choice that needs a new confirmation.
 *
 * Enforced where an engine is actually spawned (`resolveEngineEnv`): an unconfirmed `api-key`
 * preset, or a confirmed one with no key stored, is REFUSED with a visible reason. It never falls
 * back to the machine's login, and no subscription engine ever falls back to a key (every non-api
 * mode strips inherited provider keys). MCP, loops, objectives and background dispatch cannot record
 * a confirmation: the write routes refuse one from an MCP request, and nothing else writes it.
 *
 * The advisory BRAIN (Pilot, Co-pilot, chat — `brain-models.ts`) is a separate path and may use a
 * provider key; this governs the coding ENGINE only.
 */
import { BRAIN_MODELS } from "./brain-models.js";
import { HttpError } from "./auth.js";
import { readEngineModel } from "./coding-engine-model.js";
import { deriveClientType } from "./coding-command.js";
import type { CodingClientType } from "./coding-types.js";

/** What an `api-key` engine bills, per CLI: the vault provider, the env var it gets, and who bills it. */
export const API_CODING_PROVIDERS: Record<CodingClientType, { provider: string; envVar: string; label: string }> = {
	claude: { provider: "anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
	codex: { provider: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" },
	gemini: { provider: "google", envVar: "GEMINI_API_KEY", label: "Google" },
	grok: { provider: "xai", envVar: "XAI_API_KEY", label: "xAI" },
};

/** The owner's recorded confirmation that one preset may code on a provider API key. */
export interface ApiCodingOptIn {
	/** The exact launch command confirmed — a different command (another model) is not confirmed. */
	command: string;
	provider: string;
	model: string | null;
	acknowledgedAt: string;
}

export type ApiCodingOptIns = Record<string, ApiCodingOptIn>;

/** The stored confirmations, read leniently: anything malformed is not a confirmation. */
export function parseApiCodingOptIns(raw: unknown): ApiCodingOptIns {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: ApiCodingOptIns = {};
	for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
		const o = v as Record<string, unknown> | null;
		if (o && typeof o.command === "string" && typeof o.provider === "string" && typeof o.acknowledgedAt === "string") {
			out[id] = { command: o.command, provider: o.provider, model: typeof o.model === "string" ? o.model : null, acknowledgedAt: o.acknowledgedAt };
		}
	}
	return out;
}

/** Is this preset's API-key coding confirmed — for exactly this command? */
export function apiCodingConfirmed(optIns: ApiCodingOptIns, engine: { id: string; command: string }): boolean {
	return optIns[engine.id]?.command === engine.command;
}

/** The confirmation to record for a preset the owner just confirmed. */
export function apiCodingOptInFor(engine: { command: string }, clientType: CodingClientType, now = Date.now()): ApiCodingOptIn {
	return { command: engine.command, provider: API_CODING_PROVIDERS[clientType].provider, model: readEngineModel(engine.command), acknowledgedAt: new Date(now).toISOString() };
}

/**
 * The billing warning the UI must show and the owner confirm, named per provider and model. Served
 * by the API so the Console and the coder UI show the same words the policy was written in.
 */
export function apiCodingWarning(clientType: CodingClientType, model: string | null): string {
	const { label, envVar } = API_CODING_PROVIDERS[clientType];
	return `API-key coding bills every token to your own ${label} account (${envVar} from Profile → API Keys), separately from any subscription, and is likely to cost more than your subscription CLI. Model: ${model ?? "the CLI's default"}. It stays on until you switch this coder back to a subscription engine.`;
}

/** Why a spawn is refused. Thrown from `resolveEngineEnv`, caught where a session start reports. */
export class ApiCodingRefused extends Error {
	readonly code: "api-key-not-confirmed" | "api-key-missing";
	constructor(code: "api-key-not-confirmed" | "api-key-missing", message: string) {
		super(message);
		this.code = code;
	}
}

export function apiCodingNotConfirmedMessage(label: string): string {
	return `Coding stopped: the engine "${label}" is set to code on a provider API key, which has not been confirmed in the console. Coding never falls back to an API key, or from one. Switch this coder to a subscription CLI, or confirm API-key coding for it in the CLI engines panel.`;
}

export function apiCodingMissingKeyMessage(label: string, clientType: CodingClientType): string {
	const { label: provider } = API_CODING_PROVIDERS[clientType];
	return `Coding stopped: "${label}" is confirmed for ${provider} API-key coding, but no ${provider} API key is stored. It does not fall back to this machine's login. Add the key in Profile → API Keys, or switch this coder to a subscription CLI.`;
}

/** Requests from the MCP worker carry this header (`workers/mcp/src/http.ts`). They may never confirm API-key coding. */
export const isMcpRequest = (header: string | undefined | null) => (header ?? "").toLowerCase() === "mcp";

export const MCP_API_CODING_REFUSAL =
	"API-key coding can only be turned on in the console, where its billing warning is confirmed. MCP may choose subscription engines, or an API-key engine the owner already confirmed — never confirm one.";

/** The Cloudflare Workers AI models offered for API-key coding once supported — listed, never selectable yet. */
export const CLOUDFLARE_CODING_MODELS = BRAIN_MODELS.filter((m) => m.provider === "cloudflare").map((m) => ({ id: m.id, label: m.label }));

/**
 * The confirmations to store when presets are saved. An `api-key` preset keeps a confirmation only
 * for its exact command; a new or changed one needs the owner's acknowledgement in THIS request
 * (`acknowledgeApiCoding: [engineId]`, sent by the console after its blocking billing warning), and
 * an MCP request can never supply one. Anything not `api-key` carries no confirmation.
 */
export function apiCodingOptInsForSave(
	engines: Array<{ id: string; label: string; command: string; auth?: string }>,
	prior: ApiCodingOptIns,
	acknowledged: unknown,
	fromMcp: boolean,
	now = Date.now(),
): ApiCodingOptIns {
	const ack = new Set(Array.isArray(acknowledged) ? acknowledged.map(String) : []);
	const out: ApiCodingOptIns = {};
	for (const e of engines) {
		if (e.auth !== "api-key") continue;
		if (apiCodingConfirmed(prior, e)) {
			out[e.id] = prior[e.id];
			continue;
		}
		if (fromMcp) throw new HttpError(403, MCP_API_CODING_REFUSAL);
		const clientType = deriveClientType(e.command);
		if (!ack.has(e.id)) {
			throw new HttpError(409, `"${e.label}" is set to code on a provider API key. ${apiCodingWarning(clientType, readEngineModel(e.command))} Confirm it in the console to save.`);
		}
		out[e.id] = apiCodingOptInFor(e, clientType, now);
	}
	return out;
}

/** What the engines panel shows about API-key coding (#1042). Subscription choices are the presets themselves. */
export interface ApiCodingView {
	/** The supported API-key coding alternatives, one per CLI, each usable only with its provider key stored. */
	options: Array<{ clientType: CodingClientType; provider: string; providerLabel: string; keyStored: boolean; warning: string }>;
	/** The presets the owner has confirmed, by id, for exactly the command recorded. */
	confirmed: ApiCodingOptIns;
	/** Presets the #1042 migration switched from an API key to the subscription CLI. */
	migrated: string[];
	/** Cloudflare Workers AI coding — listed (never selectable yet) only once Cloudflare credentials are stored. */
	cloudflare: { comingSoon: true; models: Array<{ id: string; label: string }> } | null;
}

export function apiCodingView(storedProviders: ReadonlySet<string>, confirmed: ApiCodingOptIns, migrated: string[]): ApiCodingView {
	const order: CodingClientType[] = ["claude", "codex", "gemini", "grok"];
	return {
		options: order.map((clientType) => {
			const { provider, label } = API_CODING_PROVIDERS[clientType];
			return { clientType, provider, providerLabel: label, keyStored: storedProviders.has(provider), warning: apiCodingWarning(clientType, null) };
		}),
		confirmed,
		migrated,
		cloudflare: storedProviders.has("cloudflare") ? { comingSoon: true, models: CLOUDFLARE_CODING_MODELS } : null,
	};
}
