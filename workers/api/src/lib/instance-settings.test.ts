import { describe, expect, it } from "vitest";
import type { SettingsField } from "./agent-capabilities.js";
import { applySettingsPatch, resolveSettingsValues, settingsPromptBlock } from "./instance-settings.js";

const SCHEMA: SettingsField[] = [
	{
		id: "target_language",
		label: "Target language",
		type: "select",
		voiceLanguage: true,
		default: "es-ES",
		options: [
			{ value: "es-ES", label: "Spanish" },
			{ value: "zh-CN", label: "Chinese (Mandarin)" },
		],
	},
	{
		id: "level",
		label: "Level",
		type: "select",
		default: "beginner",
		options: [
			{ value: "beginner", label: "Beginner" },
			{ value: "advanced", label: "Advanced" },
		],
	},
	{ id: "nickname", label: "Nickname", type: "text" },
	{ id: "daily_goal", label: "Daily goal", type: "number", default: 10 },
	{ id: "corrections", label: "Corrections", type: "toggle", default: true },
];

describe("resolveSettingsValues", () => {
	it("merges stored values over defaults and fills gaps", () => {
		const values = resolveSettingsValues(SCHEMA, { target_language: "zh-CN" });
		expect(values.target_language).toBe("zh-CN");
		expect(values.level).toBe("beginner"); // default
		expect(values.daily_goal).toBe(10); // default
		expect(values.nickname).toBeUndefined(); // no value, no default
	});

	it("filters stale/unknown ids and wrong-typed values", () => {
		const values = resolveSettingsValues(SCHEMA, {
			removed_field: "x",
			target_language: "not-an-option",
			daily_goal: "not-a-number",
		});
		expect(values.removed_field).toBeUndefined();
		expect(values.target_language).toBe("es-ES"); // invalid → default
		expect(values.daily_goal).toBe(10);
	});
});

describe("applySettingsPatch", () => {
	it("keeps only known, type-valid fields and merges over current", () => {
		const { settings } = applySettingsPatch(
			SCHEMA,
			{ level: "advanced" },
			{ nickname: "Sam", unknown_field: "x", daily_goal: "bad" },
		);
		expect(settings).toEqual({ level: "advanced", nickname: "Sam" });
	});

	it("rejects a select value that is not an option", () => {
		const { settings } = applySettingsPatch(SCHEMA, {}, { target_language: "xx-XX" });
		expect(settings.target_language).toBeUndefined();
	});

	it("caps text at 500 chars", () => {
		const { settings } = applySettingsPatch(SCHEMA, {}, { nickname: "a".repeat(600) });
		expect((settings.nickname as string).length).toBe(500);
	});

	it("returns voiceLanguageValue only when a voiceLanguage field is in the patch", () => {
		const withVoice = applySettingsPatch(SCHEMA, {}, { target_language: "zh-CN" });
		expect(withVoice.voiceLanguageValue).toBe("zh-CN");
		const withoutVoice = applySettingsPatch(SCHEMA, { target_language: "zh-CN" }, { level: "advanced" });
		expect(withoutVoice.voiceLanguageValue).toBeUndefined();
		expect(withoutVoice.settings.target_language).toBe("zh-CN"); // preserved
	});
});

describe("settingsPromptBlock", () => {
	it("renders labels with the raw value in parens when they differ", () => {
		const block = settingsPromptBlock(SCHEMA, {
			target_language: "zh-CN",
			level: "beginner",
			corrections: true,
		});
		expect(block).toContain("## Settings");
		expect(block).toContain("They are authoritative");
		expect(block).toContain("never store them in\nmemory");
		expect(block).toContain("- Target language: Chinese (Mandarin) (zh-CN)");
		expect(block).toContain("- Level: Beginner (beginner)");
		expect(block).toContain("- Corrections: on");
		expect(block).not.toContain("Nickname"); // unset, no default
	});

	it("returns empty when nothing is set", () => {
		expect(settingsPromptBlock(SCHEMA, {})).toBe("");
		expect(settingsPromptBlock([], {})).toBe("");
	});
});
