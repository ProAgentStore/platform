/**
 * The Settings tab's "Coding engine" card — which CLI this agent opens sessions with, and which
 * model it runs (#792).
 *
 * Pure, for the reason every `lib/*.ts` here is: neither console has component tests (#282), so
 * what the card SHOWS is decided here and the component only renders it.
 *
 * The shapes are what `GET /v1/instances/:id/coding/engine-choice` returns. The server owns every
 * fact in them — which engines exist, which take a model, which aliases are worth offering, when
 * the choice applies — because this card is a second door onto the state the CLI engines panel
 * already owns, and migration 0126 is the record of what a dropdown with its own opinion costs.
 */

export interface EngineChoiceOption {
	id: string;
	label: string;
	command: string;
	model: string | null;
	modelSelectable: boolean;
	suggestions: { value: string; label: string }[];
}

export interface EngineChoice {
	defaultEngineId: string;
	engines: EngineChoiceOption[];
	lastObserved: { model: string; at: string } | null;
	appliesTo: string;
}

/** The `<select>` value meaning "let the CLI pick". Not a model id: no id is the empty string. */
export const CLI_DEFAULT = "";
/** The `<select>` value that reveals the free-text field. Cannot collide — a model id has no spaces. */
export const OTHER_MODEL = "other model";

export interface ModelOption {
	value: string;
	label: string;
}

/**
 * What the model dropdown lists for one engine.
 *
 * The CURRENT model is always in the list, even when it is not a suggestion — an owner who pinned
 * `claude-opus-5` by hand must see it selected, not see "CLI default" and conclude nothing is
 * pinned. That misreading is the whole failure this card exists to end.
 */
export function modelOptions(engine: EngineChoiceOption): ModelOption[] {
	const options: ModelOption[] = [{ value: CLI_DEFAULT, label: "The CLI's own default" }, ...engine.suggestions];
	if (engine.model && !options.some((o) => o.value === engine.model)) options.push({ value: engine.model, label: engine.model });
	options.push({ value: OTHER_MODEL, label: "Another model…" });
	return options;
}

/** The engine the card is showing: the chosen one, or the first when the id matches nothing. */
export function chosenEngine(choice: EngineChoice): EngineChoiceOption | undefined {
	return choice.engines.find((e) => e.id === choice.defaultEngineId) ?? choice.engines[0];
}

/**
 * The body a change sends. `model` is OMITTED when only the engine changed, so switching engines
 * never rewrites a command — the server reads an absent key as "leave it alone" and `null` as
 * "hand the choice back to the CLI".
 */
export function choiceBody(engineId: string, model?: string): { engineId: string; model?: string | null } {
	if (model === undefined) return { engineId };
	const id = model.trim();
	return { engineId, model: id === CLI_DEFAULT ? null : id };
}

/** "Last ran on …" — observed from the engine's own usage report, so it is stated as an observation. */
export function observedLine(choice: EngineChoice): string | null {
	return choice.lastObserved ? `The last measured engine turn on this agent ran ${choice.lastObserved.model}.` : null;
}
