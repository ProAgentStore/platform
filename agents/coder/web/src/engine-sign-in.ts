// The sign-in options the engines panel offers for a preset — pure, so the wording is testable (#732).
//
// The one distinction this panel exists to make is API key vs subscription, and it used to be
// Claude-only: `subscription` was hidden for every other engine, so a ChatGPT subscriber running
// Codex could pick "Machine login" (spend the platform cannot attribute) or "OpenAI API key"
// (per-token charges they may not want), and nothing in between. Codex has a real subscription —
// Sign in with ChatGPT, via `codex login` — so it gets the option, named for its real mechanism.
//
// Every label names the concrete credential and what it costs. A generic "Subscription" would put
// the reader back to inferring the bill from a mechanism, which is the gap #551 and #556 closed
// for Claude.

import { engineBin } from "@proagentstore/sdk/ui";
import type { EngineAuth } from "./types";

/** The engines whose sign-in the panel can describe concretely. */
export type SignInEngine = "claude" | "codex" | "gemini" | "grok" | "other";

export function signInEngine(command: string): SignInEngine {
	const bin = engineBin(command);
	// A blank command falls back to Claude at the runner (see `isClaudeEngine`).
	if (!bin || bin.startsWith("claude")) return "claude";
	if (bin.startsWith("codex")) return "codex";
	if (bin.startsWith("gemini")) return "gemini";
	if (bin.startsWith("grok")) return "grok";
	return "other";
}

const PROVIDER: Record<SignInEngine, string> = {
	claude: "Anthropic",
	codex: "OpenAI",
	gemini: "Google",
	grok: "xAI",
	other: "provider",
};

export interface SignInOption {
	value: EngineAuth;
	label: string;
}

/**
 * The options for one preset, in display order. `subscription` appears only where the engine has
 * a subscription the platform can route to — Claude (an injected `claude setup-token`) and Codex
 * (its own `codex login`, with the OpenAI key stripped so it cannot override the plan).
 */
export function signInOptions(command: string): SignInOption[] {
	const engine = signInEngine(command);
	const apiKey: SignInOption = { value: "api-key", label: `${PROVIDER[engine]} API key — billed per token to your own account` };
	if (engine === "claude") {
		return [
			{ value: "auto", label: "Auto — subscription token if saved, else machine login" },
			{ value: "machine", label: "Machine login — the claude.ai session stored on the runner (payer unknown)" },
			{ value: "subscription", label: "Subscription token (from `claude setup-token`) — no per-token charge" },
			apiKey,
		];
	}
	if (engine === "codex") {
		return [
			{ value: "auto", label: "Auto — ChatGPT login if present, else whatever the CLI has" },
			{ value: "machine", label: "Machine login — `codex login` or an OpenAI key set in the CLI (payer unknown)" },
			{ value: "subscription", label: "ChatGPT subscription (from `codex login`) — no per-token charge, draws your ChatGPT plan" },
			apiKey,
		];
	}
	return [
		{ value: "auto", label: "Auto — this machine's login" },
		{ value: "machine", label: "Machine login only (payer unknown)" },
		apiKey,
	];
}
