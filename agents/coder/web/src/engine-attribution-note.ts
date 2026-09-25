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

import { engineInvocationMode, isClaudeEngine } from "@proagentstore/sdk/ui";
import { signInEngine } from "./engine-sign-in";
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
 * Codex's line (#732). It differs from Claude's in one fact that decides every sentence: Codex has
 * no subscription token for the platform to inject or the runner to observe. Its ChatGPT sign-in
 * is `~/.codex/auth.json` on the runner, written by `codex login`, so every mode but `api-key`
 * resolves to `machine-login` and a NULL payer — the platform cannot tell a ChatGPT login from an
 * API key saved inside the CLI, and says so rather than guessing.
 *
 * Whether `codex login` has been run is not detectable from here either (no runner-side probe
 * exists), so the subscription note tells the user to check rather than implying it was checked.
 */
function codexAttributionNote(mode: EngineAuth): EngineAttributionNote {
	if (mode === "api-key") {
		return {
			attributable: true,
			label: "Charged spend, visible on Usage",
			detail: "Turns are billed per token to your OpenAI API key, so they count towards the charged total on the Usage page.",
		};
	}
	if (mode === "subscription") {
		return {
			attributable: false,
			label: "No per-token charge — draws your ChatGPT plan",
			detail:
				"Codex runs on the runner machine's `codex login`. If you also have an OpenAI API key saved, this mode prevents it from being used — Codex runs on your ChatGPT plan instead. The platform can't see whether `codex login` has been run on that machine: run it there first, or the engine falls back to whatever the CLI has or fails to start. Usage lists these turns under \"Payer not established\", because the login type can't be confirmed from outside the CLI.",
		};
	}
	if (mode === "machine") {
		return {
			attributable: false,
			label: "Attribution unknown",
			detail:
				"The CLI uses whatever `codex login` stored on that machine — a ChatGPT sign-in or an OpenAI API key saved in the CLI. The platform can't tell which, so Usage records these turns as \"Payer not established\". Pick ChatGPT subscription to say it is your plan, or OpenAI API key to bill a key you saved under Profile → API Keys.",
		};
	}
	return {
		attributable: false,
		label: "Attribution unknown",
		detail:
			"Codex uses its ChatGPT login if `codex login` has been run on that machine, else whatever the CLI has. No saved OpenAI API key is injected in this mode. Usage records these turns as \"Payer not established\".",
	};
}

/**
 * The attribution line for a preset, or null when there is nothing honest to say.
 *
 * Null for a raw (non-Claude, non-`codex exec`) engine, and that is not an omission: no ledger row is written for a raw
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
	const mode = auth ?? "auto";
	// Codex's `exec --json` preset is structured, so its turns ARE ledgered and the payer question
	// is real. A raw Codex command writes no row — same null as every other raw engine.
	if (signInEngine(command) === "codex") return engineInvocationMode(command) === "structured" ? codexAttributionNote(mode) : null;
	if (!isClaudeEngine(command)) return null;

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
