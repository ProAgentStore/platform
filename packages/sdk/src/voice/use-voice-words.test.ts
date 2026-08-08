/**
 * The hook assembles the matcher's word set in ONE place (#469).
 *
 * STRUCTURAL, over the source, for the reason `mute-invariant.test.ts` states for its own third
 * kind of assertion: the hook cannot be mounted here (no jsdom, no renderer in this repo), and the
 * defect this file is about is invisible to every pure test — five hand-written copies of a
 * seven-field literal, one of which was missing a field.
 *
 * The behavioural half is in `convo.test.ts` ("a partial word set silently un-reserves a user's
 * phrase"): with `repeat` absent, a phrase the user bound to repeat stops being reserved against
 * every other command, so "stop" meant *repeat* everywhere in the app and *tear hands-free down*
 * on the one listener that runs while the agent is speaking.
 *
 * What is asserted is the PROPERTY, not today's field list: there is exactly one construction, it
 * names every field of `VoiceCommandWords`, and no call site builds its own. A field added to that
 * interface is therefore added in one place or fails here — which is the only durable answer to a
 * bug whose cause was "four of the five got updated".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const USE_VOICE = readFileSync(new URL("./use-voice.ts", import.meta.url), "utf-8");
const CONVO = readFileSync(new URL("./convo.ts", import.meta.url), "utf-8");
const CONFIG = readFileSync(new URL("./config.ts", import.meta.url), "utf-8");

/** Every field of `VoiceCommandWords`, read FROM the interface rather than copied out of it — the
 *  same trick `mute-invariant.test.ts` uses on the ADR, and for the same reason. */
function wordsFields(): string[] {
	const start = CONVO.indexOf("export interface VoiceCommandWords {");
	expect(start, "convo.ts no longer declares VoiceCommandWords — this guard is looking at nothing").toBeGreaterThan(-1);
	const body = CONVO.slice(start, CONVO.indexOf("\n}", start));
	const fields = [...body.matchAll(/^\t(\w+)\?:/gm)].map((m) => m[1]);
	expect(fields.length, "parsed no fields off VoiceCommandWords — fix the parse before trusting the assertions").toBeGreaterThan(3);
	return fields;
}

/** Can a user set this field at all? `VoiceConfig` is the only source the hook copies from, so a
 *  field with no entry there is unreachable rather than dropped — see the `back` test below. */
function configurable(field: string): boolean {
	if (field === "stopSpeech") return CONFIG.includes("stopSpeechKeyword:");
	if (field === "disabled") return CONFIG.includes("disabledCommands:");
	return new RegExp(`^\\t${field}Words:`, "m").test(CONFIG);
}

/** The assignment that builds it. Sliced, not grepped: "somewhere in a 1,700-line file" is not the
 *  claim — the claim is about this one statement. */
function assembly(): string {
	const i = USE_VOICE.indexOf("voiceWordsRef.current = {");
	expect(i, "use-voice.ts no longer assembles a single word set — #469 has been undone").toBeGreaterThan(-1);
	return USE_VOICE.slice(i, USE_VOICE.indexOf("\n\t\t};", i));
}

describe("use-voice.ts builds the matcher's word set once (#469)", () => {
	it("has exactly one construction site", () => {
		expect(USE_VOICE.match(/voiceWordsRef\.current = \{/g) ?? []).toHaveLength(1);
	});

	it("names every field of VoiceCommandWords the user can actually set", () => {
		const built = assembly();
		for (const field of wordsFields().filter(configurable)) {
			expect(built, `\`${field}\` is missing from the word set the hook passes to the matcher. That is #469 exactly: a field absent from one call site is a phrase the user bound that stops being RESERVED, so it silently becomes some other command on that path.`).toContain(`${field}:`);
		}
	});

	/**
	 * `back` is the one field the hook does not pass, and it is not the same defect: there is no
	 * `backWords` in `VoiceConfig`, so `words.back` can never be non-empty and there is nothing to
	 * reserve. Asserted rather than assumed — the day a back-words setting is added, this fails
	 * until it is threaded through the assembly, which is precisely the moment it starts to matter.
	 */
	it("only skips a field because nothing can set it", () => {
		const skipped = wordsFields().filter((f) => !configurable(f));
		expect(skipped, "a settable field is missing from the assembly — thread it through, or this is #469 again").toEqual(["back"]);
	});

	it("has no call site that assembles its own", () => {
		// The five literals this replaced all started `{ mute: muteWordsRef.current, …` or
		// `{ repeat: repeatWordsRef.current, …`. Any per-command words ref is a copy coming back.
		expect(USE_VOICE, "a per-command words ref is back — that is how the five literals drifted").not.toMatch(/(repeat|mute|unmute|exit|next|scrap)WordsRef/);
		// `stopSpeech:` is written exactly once in the file — inside the assembly. A second one is
		// a second word set, whatever it is called and however it is passed.
		expect(USE_VOICE.match(/stopSpeech:/g) ?? [], "a call site is building its own word set again").toHaveLength(1);
	});
});
