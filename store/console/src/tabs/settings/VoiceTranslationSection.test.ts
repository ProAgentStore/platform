import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import VoiceTranslationSection from "./VoiceTranslationSection";
import type { OverrideLoad } from "../../lib/overrideLine";

const noop = async () => {};
const base = {
	voiceSettings: { speed: 130 } as Record<string, unknown> | null,
	voiceLoad: "loaded" as OverrideLoad,
	voiceOverride: false,
	voiceRevealed: false,
	hasOpenAiKey: true,
	trLoad: "loaded" as OverrideLoad,
	trOverride: false,
	trRevealed: false,
	trEnabled: false,
	trTarget: "English",
	trTranslit: false,
	trWordTap: true,
	trFontSize: "medium",
	trLanguages: [{ name: "English", tag: "en-US" }],
	onSaveVoice: noop,
	onClearVoiceOverride: noop,
	onSaveTranslationOverride: noop,
	onClearTrOverride: noop,
	onSetVoiceRevealed: () => {},
	onSetTrRevealed: () => {},
};
const render = (over: Partial<typeof base> = {}) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(VoiceTranslationSection, { ...base, ...over })));

describe("Settings General voice and translation (#1599)", () => {
	it("no override: two single lines, no forms, no radios", () => {
		const html = render();
		expect(html).toContain("Voice: follows your account (");
		expect(html).toContain("Translation: follows your account (off)");
		expect(html.match(/Override for this agent/g)).toHaveLength(2);
		expect(html.match(/Change in Preferences/g)).toHaveLength(2);
		expect(html).not.toContain('type="radio"');
		expect(html).not.toContain("voice-stt-mode");
	});
	it("a server-side override shows its form on first render with Use account default", () => {
		const html = render({ voiceOverride: true, trOverride: true });
		expect(html).toContain("voice-stt-mode");
		expect(html.match(/Use account default/g)).toHaveLength(2);
		expect(html).not.toContain("Cancel");
		expect(html).not.toContain("follows your account");
	});
	it("revealed shows the form with Cancel", () => {
		const html = render({ voiceRevealed: true });
		expect(html).toContain("voice-stt-mode");
		expect(html).toContain("Cancel");
	});
	it("loading and failed never claim 'follows your account' and offer no action", () => {
		const html = render({ voiceLoad: "loading", trLoad: "failed" });
		expect(html).toContain("Voice: Checking…");
		expect(html).toContain("Translation: Couldn&#x27;t check");
		expect(html).not.toContain("follows your account");
		expect(html).not.toContain("<button");
	});
});
