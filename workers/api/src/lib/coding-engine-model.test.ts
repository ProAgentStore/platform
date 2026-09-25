/**
 * The model an engine runs is a flag in its preset command (#792).
 *
 * What these hold is the property the whole design rests on: WRITE then READ round-trips, for every
 * shipped preset, without disturbing a single other token — because the command is a real argv the
 * owner may have tuned by hand, and the shipped Gemini and Grok presets END in the flag that takes
 * the turn text. A model appended there is a broken engine that still looks configured.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINES, engineAuthFor, type CodingEngine } from "./coding-engines.js";
import { MODEL_SUGGESTIONS, isValidModelId, modelFlagEngine, readEngineModel, writeEngineModel } from "./coding-engine-model.js";

const preset = (id: string) => DEFAULT_ENGINES.find((e) => e.id === id)?.command ?? "";

describe("which commands have a model flag at all", () => {
	it.each(["claude", "codex", "gemini", "grok"])("knows the shipped %s preset's", (id) => {
		expect(modelFlagEngine(preset(id))).toBe(id);
	});

	it("does NOT treat an unknown binary as Codex, though deriveClientType does — ollama takes its model positionally", () => {
		expect(modelFlagEngine(preset("local"))).toBeNull();
		expect(writeEngineModel(preset("local"), "llama4")).toBe(preset("local"));
	});

	it("finds the real binary behind env prefixes and launchers", () => {
		expect(modelFlagEngine("FOO=bar npx claude --dangerously-skip-permissions")).toBe("claude");
	});
});

describe("reading the model a command pins", () => {
	it("is null for every shipped preset — the CLI picks, which is why the run in #792 was a surprise", () => {
		for (const e of DEFAULT_ENGINES) expect(readEngineModel(e.command)).toBeNull();
	});

	it.each([
		["claude --model sonnet --dangerously-skip-permissions", "sonnet"],
		["claude --model=claude-opus-5[1m] --dangerously-skip-permissions", "claude-opus-5[1m]"],
		["codex exec -m gpt-x --json", "gpt-x"],
		['codex exec --model "gpt-x" --json', "gpt-x"],
	])("reads %s", (command, model) => {
		expect(readEngineModel(command)).toBe(model);
	});

	it("reports the LAST of a repeated flag — the one the CLI actually honours", () => {
		expect(readEngineModel("claude --model opus --model sonnet")).toBe("sonnet");
	});

	it("does not read Claude's `-m`, which is not its model flag", () => {
		expect(readEngineModel("claude -m sonnet")).toBeNull();
	});
});

describe("writing one", () => {
	it.each(["claude", "codex", "gemini", "grok"])("round-trips through the shipped %s preset and keeps every other token, in order", (id) => {
		const before = preset(id);
		const after = writeEngineModel(before, "some-model-1");
		expect(readEngineModel(after)).toBe("some-model-1");
		expect(after.split(" ").filter((t) => t !== "--model" && t !== "some-model-1")).toEqual(before.split(" "));
		expect(writeEngineModel(after, null)).toBe(before);
	});

	it("never appends — Gemini and Grok end in the flag that takes the TURN TEXT as its value", () => {
		expect(writeEngineModel(preset("gemini"), "g-1").endsWith("--prompt")).toBe(true);
		expect(writeEngineModel(preset("grok"), "g-1").endsWith(" -p")).toBe(true);
	});

	it("puts Codex's after `exec`, whose option it is", () => {
		expect(writeEngineModel(preset("codex"), "gpt-x")).toBe("codex exec --model gpt-x --json --sandbox danger-full-access");
	});

	it("places it after the real binary, not after an env value that happens to end the same way", () => {
		expect(writeEngineModel("BIN=/opt/claude npx claude --verbose", "opus")).toBe("BIN=/opt/claude npx claude --model opus --verbose");
	});

	it("REPLACES — a preset never carries two model flags, in any spelling", () => {
		expect(writeEngineModel("codex exec -m old --model=older --json", "new")).toBe("codex exec --model new --json");
	});

	it("writes nothing it could not read back: an id with a space or a quote leaves the command alone", () => {
		for (const bad of ["two words", 'so"nnet', "", "-rf", "x".repeat(101)]) {
			expect(isValidModelId(bad)).toBe(false);
			expect(writeEngineModel(preset("claude"), bad)).toBe(preset("claude"));
		}
		expect(isValidModelId("claude-opus-5[1m]")).toBe(true);
	});
});

describe("what the dropdown suggests", () => {
	it("offers only ids that are valid to write", () => {
		for (const list of Object.values(MODEL_SUGGESTIONS)) for (const s of list) expect(isValidModelId(s.value)).toBe(true);
	});
});

describe("a RUNNING session keeps its preset's sign-in when the owner picks a model (#792)", () => {
	// Sessions persist the command they launched with, and the preset is matched back by command.
	// Choosing a model rewrites the preset's command — so without this, a Gemini session (`api-key`)
	// would fall to `auto` mid-session and have its key stripped on the next turn.
	const engines: CodingEngine[] = DEFAULT_ENGINES.map((e) => (e.id === "gemini" ? { ...e, command: writeEngineModel(e.command, "g-2") } : e));

	it("matches the old command to the re-modelled preset", () => {
		expect(engineAuthFor(engines, preset("gemini"))).toBe("api-key");
	});

	it("still prefers an exact match, and still falls to auto for a command no preset has", () => {
		expect(engineAuthFor(engines, engines.find((e) => e.id === "gemini")?.command)).toBe("api-key");
		expect(engineAuthFor(engines, "gemini --something-else")).toBe("auto");
	});
});
