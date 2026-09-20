// The instance's engine + model choice, as one read and one write (#792).
//
// This is NOT a new setting. It is a second, simpler door onto the state the ⚙ CLI engines panel
// already owns — `config.defaultEngineId` and the presets' own commands — because migration 0126
// deleted the last "engine" dropdown for being a rival to that state rather than a view of it.
// Everything here reads through `readEngines` and writes the same two config keys the panel's PUT
// writes, so the dropdown, the panel and `resolveEngine` cannot hold three opinions.
//
// The model half is `coding-engine-model.ts`: the model is a flag IN the preset's command, so
// choosing one rewrites that command and nothing else.

import { HttpError } from "./auth.js";
import { deriveClientType, readEngines, type CodingEngine } from "./coding-engines.js";
import { MODEL_SUGGESTIONS, isValidModelId, modelFlagEngine, readEngineModel, writeEngineModel, type ModelSuggestion } from "./coding-engine-model.js";
import { patchInstanceConfig } from "./instance-config.js";
import type { CodingClientType } from "./coding-types.js";
import type { Env } from "../types.js";

export interface EngineChoiceOption {
	id: string;
	label: string;
	/** The full launch command — shown so the owner can see exactly what the choice wrote. */
	command: string;
	clientType: CodingClientType;
	/** The model the command pins, or null when the CLI picks its own. */
	model: string | null;
	/** False for a binary whose model flag we do not know (a local model, a custom wrapper). */
	modelSelectable: boolean;
	suggestions: ModelSuggestion[];
}

export interface EngineChoiceView {
	defaultEngineId: string;
	engines: EngineChoiceOption[];
	/**
	 * The model the most recent MEASURED engine turn on this instance actually ran, or null when
	 * none is on the ledger. Observed, not configured: it answers "which model is driving my runs"
	 * (#792's other half) from the CLI's own usage report, and it is the check on the choice above —
	 * a preset that says `sonnet` beside an observation that says otherwise is a session that has not
	 * been restarted yet. Null for an engine that reports no usage (`docs/coding-engines.md`).
	 */
	lastObserved: { model: string; at: string } | null;
	/** When the choice takes effect — said by the server so every surface says the same thing. */
	appliesTo: string;
}

/**
 * Sessions persist the command they were LAUNCHED with (`coding_sessions.launch_command`), and that
 * correctly outranks any setting — it is a process already running on someone's machine (0126).
 * A control that did not say so would look broken the first time it was used mid-session.
 */
export const ENGINE_CHOICE_APPLIES_TO =
	"Applies to the next coding session this agent opens. A session that is already running keeps the engine it was started with — restart it, or start a fresh one, to switch.";

const toOption = (e: CodingEngine): EngineChoiceOption => {
	const flagEngine = modelFlagEngine(e.command);
	return {
		id: e.id,
		label: e.label,
		command: e.command,
		clientType: deriveClientType(e.command),
		model: readEngineModel(e.command),
		modelSelectable: flagEngine !== null,
		suggestions: flagEngine ? MODEL_SUGGESTIONS[flagEngine] : [],
	};
};

async function lastObservedModel(env: Env, instanceId: string, userId: string): Promise<EngineChoiceView["lastObserved"]> {
	// Engine turns are the rows keyed `engine:<session>:<record>` (`engineUsageRowId`); every other
	// row on this instance is the Pilot, the Co-pilot or chat, which run on BYOK Claude regardless.
	const row = await env.DB.prepare(
		"SELECT model, created_at FROM ai_usage WHERE instance_id = ?1 AND user_id = ?2 AND id LIKE 'engine:%' ORDER BY created_at DESC LIMIT 1",
	)
		.bind(instanceId, userId)
		.first<{ model: string; created_at: string }>();
	return row?.model ? { model: row.model, at: row.created_at } : null;
}

export async function readEngineChoice(env: Env, instanceId: string, userId: string): Promise<EngineChoiceView> {
	const { engines, defaultEngineId } = await readEngines(env, instanceId, userId);
	// The observation is an improvement to the view, never a reason to fail it.
	const lastObserved = await lastObservedModel(env, instanceId, userId).catch(() => null);
	return { defaultEngineId, engines: engines.map(toOption), lastObserved, appliesTo: ENGINE_CHOICE_APPLIES_TO };
}

/**
 * Choose the engine this instance opens sessions with, and optionally the model it runs.
 *
 * `model` is tri-state on purpose: ABSENT leaves the preset's command alone (switching engine must
 * not quietly strip a `--model` the owner wrote by hand), `null` hands the choice back to the CLI,
 * a string pins it.
 *
 * An unknown engine id is refused rather than falling back to the default the way `resolveEngine`
 * does at launch. There, falling back keeps a session opening; here it would answer "saved" to a
 * choice that was not made, which is the exact failure 0126 was written about.
 */
export async function writeEngineChoice(
	env: Env,
	instanceId: string,
	userId: string,
	input: { engineId?: unknown; model?: unknown },
): Promise<EngineChoiceView> {
	const { engines } = await readEngines(env, instanceId, userId);
	const engine = engines.find((e) => e.id === input.engineId);
	if (!engine) throw new HttpError(400, `No engine "${String(input.engineId ?? "")}" on this agent — choose one of: ${engines.map((e) => e.id).join(", ")}.`);

	if (input.model !== undefined) {
		const model = input.model === null || input.model === "" ? null : input.model;
		if (model !== null && !isValidModelId(model)) throw new HttpError(400, "That is not a model id — use the id the CLI itself accepts, with no spaces or quotes.");
		// Only a PIN is refused. Handing the choice back to a CLI that never had one is already true.
		if (model !== null && !modelFlagEngine(engine.command)) {
			throw new HttpError(400, `${engine.label} has no model flag this platform knows — edit its command in the CLI engines panel instead.`);
		}
		const command = writeEngineModel(engine.command, model);
		if (command !== engine.command) {
			// The whole list, because that is the key's shape — and because an instance that has saved
			// nothing is running on `DEFAULT_ENGINES`, which exist only in code until this writes them.
			await patchInstanceConfig(env, instanceId, userId, "codingEngines", engines.map((e) => (e.id === engine.id ? { ...e, command } : e)));
		}
	}
	await patchInstanceConfig(env, instanceId, userId, "defaultEngineId", engine.id);
	return readEngineChoice(env, instanceId, userId);
}
