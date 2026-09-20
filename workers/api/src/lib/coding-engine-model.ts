// Which MODEL an engine preset runs, read from and written to the preset's own command (#792).
//
// ── Why the model is not a new field
//
// An owner whose run silently burned one model's usage window had nowhere to say "use another
// one". The obvious fix is a `model` setting — and migration 0126 is the record of what that
// costs: FOUR things once claimed to decide which CLI a session launches, the one the console
// labelled "Coding CLI" was read by nothing, and the agent asserted it back to its owner while a
// different engine ran. Its conclusion stands: the preset COMMAND is the only thing that launches,
// so it is the only place a choice can live without becoming a second opinion.
//
// Every engine this platform ships takes the model as a flag — `--model` on all four, verified
// against the installed binaries on 2026-09-20 (`claude`, `codex exec`, `gemini`, `grok`) — and the
// runner passes every preset token through verbatim (`docs/coding-engines.md`, pinned by
// `headless.test.ts`). So "which model" is already expressible; what was missing is a control that
// is not a free-text argv. This module is that control's whole logic: READ the model out of a
// command, WRITE one into it. No state of its own, so it cannot disagree with what launches.
//
// ── What it will not do
//
// List "all available models". The platform does not know them: they are a property of the CLI
// version on the owner's machine and of the account it is signed in to, and a hardcoded catalogue
// is a list that is wrong the day a vendor ships. Claude Code publishes stable ALIASES for its
// latest models (its own `--help` names them), so those are offered; for every engine the owner
// can type any id, and "the CLI's own default" is always a choice. A model the CLI rejects fails
// loudly on the first turn, in the engine's own words.
//
// PURE — no Env, no D1. The read and the write are in `coding-engine-choice.ts`.

import { commandEngineParts } from "./coding-command.js";

/** The binaries whose `--model` flag is known. Matched by prefix, the way `deriveClientType` does. */
const MODEL_FLAG_BINARIES = ["claude", "codex", "gemini", "grok"] as const;
export type ModelFlagEngine = (typeof MODEL_FLAG_BINARIES)[number];

/**
 * Which engine's model flag this command takes, or null when the binary is not one we know.
 *
 * NOT `deriveClientType`: that maps an unknown binary to "codex" so it runs raw, which is right
 * for driving it and wrong here — `ollama run llama3` takes its model positionally, and writing
 * `--model` into it would break a working preset.
 */
export function modelFlagEngine(command: string): ModelFlagEngine | null {
	const { bin } = commandEngineParts(command);
	return MODEL_FLAG_BINARIES.find((b) => bin.startsWith(b)) ?? null;
}

/** A model id as a single argv token: no spaces, no quotes, nothing a shell-ish parser could split. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,99}$/;

export function isValidModelId(v: unknown): v is string {
	return typeof v === "string" && MODEL_ID.test(v);
}

/** `-m` is the short form on Codex, Gemini CLI and Grok. Claude Code has none. */
const isModelFlag = (token: string, engine: ModelFlagEngine) => token === "--model" || (token === "-m" && engine !== "claude");

/**
 * The model this command pins, or null when it leaves the choice to the CLI.
 *
 * The LAST occurrence wins, because that is what every one of these CLIs does with a repeated
 * flag — reporting the first would state a model the engine is not running.
 */
export function readEngineModel(command: string): string | null {
	const engine = modelFlagEngine(command);
	if (!engine) return null;
	const tokens = command.trim().split(/\s+/);
	let model: string | null = null;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("--model=")) model = t.slice("--model=".length) || null;
		else if (isModelFlag(t, engine) && tokens[i + 1] && !tokens[i + 1].startsWith("-")) model = tokens[++i];
	}
	return model ? model.replace(/^["']|["']$/g, "") : null;
}

/**
 * The same command running `model` — or, for null, leaving the choice to the CLI again.
 *
 * Every existing model flag is removed first, so a preset never carries two. The new one goes
 * directly after the binary (after `exec` for Codex, whose `--model` belongs to the subcommand) and
 * NEVER at the end: a preset is a PREFIX the turn text is appended to, and the shipped Gemini and
 * Grok presets end in `--prompt` / `-p`, which take that text as their value. Appending would hand
 * the model id to the prompt flag and the prompt to nothing.
 *
 * Returns the command unchanged when the binary has no known model flag, or the id is not one —
 * the caller refuses those; this function never writes something it cannot read back.
 */
export function writeEngineModel(command: string, model: string | null): string {
	const engine = modelFlagEngine(command);
	if (!engine || (model !== null && !isValidModelId(model))) return command;
	const tokens = command.trim().split(/\s+/);
	const kept: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("--model=")) continue;
		if (isModelFlag(t, engine) && tokens[i + 1] && !tokens[i + 1].startsWith("-")) {
			i++;
			continue;
		}
		kept.push(t);
	}
	if (model === null) return kept.join(" ");
	// The binary is the first token that is not an env assignment, a flag or a launcher — found the
	// same way `commandEngineParts` finds it, by asking it for the binary's own name.
	const { bin } = commandEngineParts(command);
	let at = kept.findIndex((t) => !t.includes("=") && !t.startsWith("-") && (t.split("/").pop() || "").toLowerCase() === bin) + 1;
	if (engine === "codex" && kept[at] && !kept[at].startsWith("-")) at++;
	return [...kept.slice(0, at), "--model", model, ...kept.slice(at)].join(" ");
}

export interface ModelSuggestion {
	value: string;
	label: string;
}

/**
 * What the dropdown offers beside "the CLI's default" and "another model…". See the header for why
 * only Claude has any: these are exactly the three aliases `claude --help` documents as tracking
 * the latest model of each tier, so they do not rot when a version ships. Anything else — a pinned
 * full id, another tier — is one "another model…" away.
 */
export const MODEL_SUGGESTIONS: Record<ModelFlagEngine, ModelSuggestion[]> = {
	claude: [
		{ value: "fable", label: "Fable (latest)" },
		{ value: "opus", label: "Opus (latest)" },
		{ value: "sonnet", label: "Sonnet (latest)" },
	],
	codex: [],
	gemini: [],
	grok: [],
};
