/**
 * What the Settings "Coding engine" card shows and sends (#792).
 *
 * The assertions that matter are the two ways this card could LIE: showing "the CLI's default"
 * while a model is pinned, and rewriting an engine's command when the owner only switched engines.
 */
import { describe, expect, it } from "vitest";
import { CLI_DEFAULT, OTHER_MODEL, choiceBody, chosenEngine, modelOptions, observedLine, type EngineChoice, type EngineChoiceOption } from "./engineChoice";

const engine = (over: Partial<EngineChoiceOption> = {}): EngineChoiceOption => ({
	id: "claude",
	label: "Claude Code",
	command: "claude --dangerously-skip-permissions",
	model: null,
	modelSelectable: true,
	suggestions: [
		{ value: "opus", label: "Opus (latest)" },
		{ value: "sonnet", label: "Sonnet (latest)" },
	],
	...over,
});

const choice = (over: Partial<EngineChoice> = {}): EngineChoice => ({
	defaultEngineId: "claude",
	engines: [engine(), engine({ id: "codex", label: "Codex", suggestions: [] })],
	lastObserved: null,
	appliesTo: "Applies to the next coding session.",
	...over,
});

describe("the model dropdown", () => {
	it("always offers the CLI's own default first and a free-text escape last", () => {
		const values = modelOptions(engine()).map((o) => o.value);
		expect(values[0]).toBe(CLI_DEFAULT);
		expect(values.at(-1)).toBe(OTHER_MODEL);
		expect(values).toEqual([CLI_DEFAULT, "opus", "sonnet", OTHER_MODEL]);
	});

	it("lists a hand-pinned model that is not a suggestion — so it shows as SELECTED, not as 'default'", () => {
		const options = modelOptions(engine({ model: "claude-opus-5[1m]" }));
		expect(options.map((o) => o.value)).toContain("claude-opus-5[1m]");
	});

	it("does not list a suggested model twice when it is the pinned one", () => {
		expect(modelOptions(engine({ model: "opus" })).filter((o) => o.value === "opus")).toHaveLength(1);
	});

	it("still works for an engine with no suggestions at all", () => {
		expect(modelOptions(engine({ suggestions: [] })).map((o) => o.value)).toEqual([CLI_DEFAULT, OTHER_MODEL]);
	});

	it("the 'another model' value can never be a real model id", () => {
		expect(OTHER_MODEL).toMatch(/\s/);
	});
});

describe("which engine the card shows", () => {
	it("is the chosen one", () => {
		expect(chosenEngine(choice({ defaultEngineId: "codex" }))?.id).toBe("codex");
	});

	it("falls to the first when the id matches nothing, rather than rendering an empty card", () => {
		expect(chosenEngine(choice({ defaultEngineId: "gone" }))?.id).toBe("claude");
	});
});

describe("what a change sends", () => {
	it("OMITS `model` when only the engine changed — switching engines must not rewrite a command", () => {
		expect(choiceBody("codex")).toEqual({ engineId: "codex" });
		expect("model" in choiceBody("codex")).toBe(false);
	});

	it("sends null for the CLI's default, and the trimmed id otherwise", () => {
		expect(choiceBody("claude", CLI_DEFAULT)).toEqual({ engineId: "claude", model: null });
		expect(choiceBody("claude", "  sonnet ")).toEqual({ engineId: "claude", model: "sonnet" });
	});
});

describe("the observed model", () => {
	it("is stated as an observation, and not at all when there is none", () => {
		expect(observedLine(choice())).toBeNull();
		expect(observedLine(choice({ lastObserved: { model: "claude-fable-5-1", at: "2026-09-19 10:00:00" } }))).toBe(
			"The last measured engine turn on this agent ran claude-fable-5-1.",
		);
	});
});
