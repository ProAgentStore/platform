// Whose money will this preset's spend be recorded against? — pure, so the sentence is testable (#551).
//
// `engine-metering-note.ts` answers the first question: will a row be written at all. This answers
// the second, and it is the one that made 99.62% of an account's notional value unreadable: a row
// IS written for every Claude Code turn, and its `payer` is derived from what the runner observed
// in the engine's spawn env. Three of the four sign-in modes can resolve to `machine-login`, which
// maps to a NULL payer — correctly, because a login stored on the machine may be a subscription OR
// an API key configured inside the CLI, and guessing is what migration 0092 exists to remove.
//
// The panel offered all four modes with no indication that three of them leave the platform unable
// to say who paid. The choice is made here, so the consequence is stated here.
//
// ── Why `auto` needs the vault answer
//
// `auto` is not one behaviour. `resolveEngineEnv` injects the stored `claude setup-token` when one
// exists (→ resolved "subscription", attributable) and otherwise strips the API key and lets the
// CLI use the machine's own login (→ "machine-login", NULL). It is also the DEFAULT, so the mode
// most users are on is the one whose meaning depends on a fact this panel would otherwise not
// know. `hasClaudeCodeToken: null` means "not looked up yet" and produces the both-ways sentence
// rather than a confident half of it.

import { isClaudeEngine } from "@proagentstore/sdk/ui";
import type { EngineAuth } from "./types";

export interface EngineAttributionNote {
	/** Can the platform name who paid for this engine's turns? */
	attributable: boolean;
	/** The headline answer to "will Usage be able to tell me who paid?". */
	label: string;
	/** What it means for the figures on the Usage page. */
	detail: string;
}

/** Where the remedy lives, named identically on both surfaces that mention it. */
const STORE_IT = "Save one under Profile → API Keys (`claude setup-token`).";

/**
 * The attribution line for a preset, or null when there is nothing honest to say.
 *
 * Null for a non-Claude engine, and that is not an omission: no ledger row is written for a raw
 * engine at all (`engineMeteringNote` says so, in the line directly above this one), so there is
 * nothing to attribute. Two notes both saying "you will not see this" would be one message too
 * many. Null for a blank command for the same reason `engineMeteringNote` is — a preset the user
 * has not written yet is not a preset to make claims about.
 */
export function engineAttributionNote(
	command: string,
	auth: EngineAuth | undefined,
	hasClaudeCodeToken: boolean | null,
): EngineAttributionNote | null {
	if (!command.trim()) return null;
	const isClaude = isClaudeEngine(command);
	// Match the command parsing in EnginesModal: Codex is the only supported engine whose
	// provider-key label is OpenAI. This describes raw-session authentication, not Usage
	// attribution: the generic fallback publishes no usage row.
	const isCodex = command.trim().split(/\s+/).some((part) => (part.split("/").pop() || "").toLowerCase().startsWith("codex"));
	if (!isClaude && !isCodex) return null;
	const mode = auth ?? "auto";

	if (isCodex) {
		if (mode === "api-key") {
			return {
				attributable: true,
				label: "OpenAI API key — billed per token",
				detail: "Turns use your saved OpenAI API key and are billed per token to your own account. This raw Codex session does not publish token or cost records to Usage, so the platform cannot attribute an invoice.",
			};
		}
		if (mode === "subscription") {
			return {
				attributable: false,
				label: "ChatGPT plan requested — no shell API-key billing",
				detail: "OPENAI_API_KEY is removed before Codex starts, so a shell key cannot silently bill per token. Codex then relies on `codex login`; when that login is a ChatGPT subscription it draws your plan allowance. The platform cannot validate that opaque local login, and this raw session publishes no Usage row.",
			};
		}
		if (mode === "machine") {
			return {
				attributable: false,
				label: "Machine credential — payer unknown",
				detail: "Codex uses whatever is configured on this runner (`codex login` or another local CLI credential). This raw session has no Usage row to attribute; use ChatGPT subscription to remove an inherited OPENAI_API_KEY, or choose an OpenAI API key deliberately.",
			};
		}
		return {
			attributable: false,
			label: "Codex login decides — payer unknown",
			detail: "Automatic mode removes an inherited OPENAI_API_KEY, then uses `codex login` if present or whatever other credential Codex has. A ChatGPT login draws your plan allowance rather than charging per token, but the platform cannot verify the local login and this raw session has no Usage row to attribute.",
		};
	}

	if (mode === "api-key") {
		return {
			attributable: true,
			label: "Charged spend, visible on Usage",
			detail: "Turns are billed to your Anthropic API key, so they count towards the charged total on the Usage page.",
		};
	}
	if (mode === "subscription") {
		return {
			attributable: true,
			label: "No per-token charge — tokens only",
			detail:
				"Turns draw your plan's allowance, which is measured in tokens over a rolling window, not in dollars. Usage shows them as value with no charge, under \"Drawn from a subscription\".",
		};
	}
	if (mode === "machine") {
		return {
			attributable: false,
			label: "Attribution unknown",
			detail: `The CLI uses whatever login is stored on that machine. That may be a subscription or an API key configured inside the CLI, so Usage records these turns as "Payer not established" rather than guessing. ${STORE_IT}`,
		};
	}
	// auto — the default, and the mode whose meaning depends on the vault.
	if (hasClaudeCodeToken === true) {
		return {
			attributable: true,
			label: "No per-token charge — tokens only",
			detail:
				"Your saved Claude Code token is injected, so Usage records these turns under \"Drawn from a subscription\": real tokens, no dollar charge.",
		};
	}
	if (hasClaudeCodeToken === false) {
		return {
			attributable: false,
			label: "Attribution unknown — no token saved",
			detail: `With no Claude Code token saved, the CLI falls back to that machine's own login and Usage records these turns as "Payer not established". ${STORE_IT}`,
		};
	}
	return {
		attributable: false,
		label: "Attribution depends on a saved token",
		detail: `With a Claude Code token saved, Usage shows these turns as drawn from a subscription; without one, the CLI uses the machine's own login and they land under "Payer not established". ${STORE_IT}`,
	};
}
