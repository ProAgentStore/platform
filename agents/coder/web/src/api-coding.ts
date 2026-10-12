// API-key coding, as the coder UI reads it (#1042).
//
// Subscription CLI is the default for actual coding. An engine preset may code on a provider API key
// only after the owner picks that here AND confirms a blocking billing warning; the API refuses an
// unconfirmed one at save and at spawn. Pure, so the confirmation rule and the session wording are
// tested apart from the components.

import type { CodingEngine } from "./types";
import type { EngineAuthReport } from "./engine-auth-view";

export type ApiClient = "claude" | "codex" | "gemini" | "grok";

export interface ApiCodingOption {
	clientType: ApiClient;
	provider: string;
	providerLabel: string;
	keyStored: boolean;
	warning: string;
}

/** `GET /coding/engines` → `apiCoding` (workers/api/src/lib/coding-api-policy.ts). */
export interface ApiCodingView {
	options: ApiCodingOption[];
	confirmed: Record<string, { command: string; provider: string; model: string | null; acknowledgedAt: string }>;
	migrated: string[];
	cloudflare: { comingSoon: true; models: Array<{ id: string; label: string }> } | null;
}

/** Which provider's CLI a launch command runs — the same prefix rule the API's `deriveClientType` uses. */
export function clientTypeOf(command: string): ApiClient | null {
	for (const t of command.trim().split(/\s+/)) {
		if (!t || t.includes("=") || t.startsWith("-")) continue;
		const base = (t.split("/").pop() || "").toLowerCase();
		if (base.startsWith("claude")) return "claude";
		if (base.startsWith("codex")) return "codex";
		if (base.startsWith("gemini")) return "gemini";
		if (base.startsWith("grok")) return "grok";
	}
	return null;
}

/** The model a command pins with `--model`/`-m`, or null when the CLI picks its own. */
export function modelInCommand(command: string): string | null {
	const tokens = command.trim().split(/\s+/);
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].startsWith("--model=")) return tokens[i].slice(8) || null;
		if ((tokens[i] === "--model" || tokens[i] === "-m") && tokens[i + 1] && !tokens[i + 1].startsWith("-")) return tokens[i + 1];
	}
	return null;
}

/** The API-key choice for a preset: offered only for a known CLI whose provider key is stored. */
export function apiKeyChoice(command: string, view: ApiCodingView | null): { option: ApiCodingOption | null; available: boolean } {
	const client = clientTypeOf(command);
	const option = (client && view?.options.find((o) => o.clientType === client)) || null;
	return { option, available: !!option?.keyStored };
}

export interface PendingApiConfirmation {
	engine: CodingEngine;
	option: ApiCodingOption | null;
	model: string | null;
}

/**
 * The presets that would save as API-key coding without a confirmation that covers them: new, or
 * changed since the owner confirmed (another model is another bill). Each needs the blocking dialog.
 */
export function pendingApiConfirmations(engines: CodingEngine[], view: ApiCodingView | null): PendingApiConfirmation[] {
	return engines
		.filter((e) => e.auth === "api-key" && view?.confirmed[e.id]?.command !== e.command)
		.map((engine) => ({ engine, option: apiKeyChoice(engine.command, view).option, model: modelInCommand(engine.command) }));
}

/** Subscription presets first, API-key ones after — the order the panel offers them in. Indices kept for editing. */
export function subscriptionFirst(engines: CodingEngine[]): Array<{ engine: CodingEngine; index: number }> {
	const rows = engines.map((engine, index) => ({ engine, index }));
	return [...rows.filter((r) => r.engine.auth !== "api-key"), ...rows.filter((r) => r.engine.auth === "api-key")];
}

const PROVIDER: Record<ApiClient, string> = { claude: "Anthropic", codex: "OpenAI", gemini: "Google", grok: "xAI" };
const ENGINE: Record<ApiClient, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", grok: "Grok" };

/**
 * The persistent banner for a session coding on an API key — set to it, or observed running on one.
 * Null for a subscription or local session. Shown for as long as the session runs that way.
 */
export function apiCodingSessionBanner(auth: EngineAuthReport | null | undefined): string | null {
	if (!auth || (auth.mode !== "api-key" && auth.resolved !== "api-key")) return null;
	const provider = auth.clientType ? PROVIDER[auth.clientType] : "the provider";
	return `API-key coding is ON — every token this session uses is billed to your own ${provider} account, separately from any subscription. Switch this coder to a subscription CLI in CLI engines to stop it.`;
}

/** Engine, model and how it signs in — the one line every session shows. */
export function sessionEngineLine(auth: EngineAuthReport | null | undefined, command: string | null | undefined): string | null {
	const client = (command && clientTypeOf(command)) || auth?.clientType || null;
	if (!client && !command) return null;
	const engine = client ? ENGINE[client] : (command?.trim().split(/\s+/)[0] ?? "engine");
	const model = command ? modelInCommand(command) : null;
	const billing = auth?.mode === "api-key" || auth?.resolved === "api-key" ? `${client ? PROVIDER[client] : "provider"} API key — billed per token` : "subscription / local CLI login";
	return `${engine} · ${model ? `model ${model}` : "CLI default model"} · ${billing}`;
}
