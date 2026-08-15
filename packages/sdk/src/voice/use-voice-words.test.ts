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
import { ALL_VOICE_COMMANDS, commandPhrases, commandStateFor, matchVoiceCommand, type VoiceCommand } from "./convo.js";

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

/**
 * A command the control listener can MATCH but cannot ACT on is a phrase that does nothing (#469).
 *
 * Giving that listener the same word set as every other one closed the reservation leak, and left
 * the other half of the same asymmetry standing: `matchVoiceCommand` returns `repeat` there —
 * "say that again" is a built-in English repeat phrase — and the dispatch chain had no repeat
 * branch, so the result was computed, returned, and dropped on the floor. That listener is the only
 * speech path alive while the agent is talking or thinking, which is exactly when a user says "say
 * that again", so the one phase where the command is most wanted was the one phase it did nothing.
 *
 * The denominator is derived by RUNNING the matcher with the state this call site really passes,
 * not from a hand-written list (ADR 0002). A command that becomes matchable here later — a new
 * entry in the phrase tables, or a flag this listener starts passing — is therefore in the set the
 * moment it exists, and fails this until someone decides what it should do.
 */
describe("the control listener acts on every command it can match (#469)", () => {
	/** The one callback, sliced — see `mute-invariant.test.ts` for why a whole-file grep is not the
	 *  claim. */
	function controlDispatch(): string {
		const start = USE_VOICE.indexOf("const handleControlResult = useCallback(");
		const end = USE_VOICE.indexOf("const handleControlResultRef", start + 1);
		expect(start, "use-voice.ts no longer declares handleControlResult — this guard is looking at nothing").toBeGreaterThan(-1);
		expect(end, "cannot find the end of handleControlResult — fix the slice before trusting the assertions").toBeGreaterThan(start);
		return USE_VOICE.slice(start, end);
	}

	/**
	 * Every command the matcher can return AT THIS CALL SITE, measured rather than listed: each
	 * command's built-in phrases are said to it, under both transcript kinds and both muted states,
	 * with the flags `handleControlResult` actually passes.
	 *
	 * `canScrap` is deliberately absent, exactly as the call site leaves it out — this listener has
	 * no scrap dispatch and passing the flag would enable a destructive command on a path that
	 * cannot act on it. So `scrap` must NOT appear in this set; that is asserted, not assumed.
	 */
	function matchableHere(): Set<VoiceCommand> {
		const found = new Set<VoiceCommand>();
		let saidCount = 0;
		for (const muted of [false, true]) {
			for (const kind of ["partial", "final"] as const) {
				for (const command of ALL_VOICE_COMMANDS) {
					for (const phrase of commandPhrases(command, undefined, "en")) {
						saidCount += 1;
						const cmd = matchVoiceCommand(phrase, undefined, "en", commandStateFor(kind, { muted, canSwitch: true, canBack: true, echoing: false }));
						if (cmd) found.add(cmd);
					}
				}
			}
		}
		expect(saidCount, "no phrases were said to the matcher — this set is empty for the wrong reason").toBeGreaterThan(100);
		return found;
	}

	it("has a dispatch branch for every command reachable on that path", () => {
		const body = controlDispatch();
		const matchable = [...matchableHere()].sort();
		// ADR 0002 — the size of the set that was examined, asserted. An empty or shrunken set would
		// otherwise make "every command is dispatched" true by checking nothing.
		expect(matchable.length, "the matcher returned almost nothing at this call site — the denominator is wrong, not the code").toBeGreaterThanOrEqual(5);
		expect(matchable, "`scrap` is now matchable on the control listener, which has no scrap dispatch — a destructive command must not be reachable where nothing can act on it").not.toContain("scrap");
		for (const cmd of matchable) {
			expect(body, `the control listener can match \`${cmd}\` but has no branch for it, so the phrase does nothing in the one phase where the mic is closed — the agent talking or thinking (#469).`).toMatch(new RegExp(`cmd === "${cmd}"`));
		}
	});

	it("re-speaks the last reply from the start rather than queueing behind the sentence it interrupts", () => {
		const body = controlDispatch();
		expect(body, "the control listener no longer reaches repeatLast — 'say that again' while the agent talks is inert again (#469)").toMatch(/cmd === "repeat"/);
		// `tts.speak` QUEUES — the manual word-tap path cancels first for exactly this reason. This is
		// the only repeat call site that can arrive mid-playback, so a repeat that does not cut the
		// current sentence off makes the user hear the rest of it and then the whole thing again.
		const repeatLast = USE_VOICE.slice(USE_VOICE.indexOf("const repeatLast = useCallback("), USE_VOICE.indexOf("const repeatLastRef"));
		expect(repeatLast, "repeatLast no longer cancels the utterance it interrupts — a repeat during playback queues a second reading instead of restarting (#469)").toMatch(/ttsRef\.current\?\.cancel\(\)/);
	});

	/**
	 * The half of the same change that is invisible from the outside and breaks silently.
	 *
	 * Cancelling the playback resolves the `await tts.speak(...)` inside the invocation that was
	 * interrupted. Without a generation check that invocation walks on and reopens the microphone —
	 * while the replacement utterance is still playing — which is the self-transcription loop
	 * (`speakAndResume` stops the recognizer at the top for exactly this reason). `speak` has
	 * carried this guard since it was written; `speakAndResume` did not need one until the control
	 * listener gave it something that could interrupt it.
	 */
	it("does not let a superseded reply reopen the mic underneath the one that replaced it", () => {
		const body = USE_VOICE.slice(USE_VOICE.indexOf("const speakAndResume = useCallback("), USE_VOICE.indexOf("// \"repeat\" voice command"));
		expect(body.length, "cannot find speakAndResume — fix the slice before trusting this assertion").toBeGreaterThan(200);
		expect(body, "speakAndResume no longer takes a generation, so a cancelled reply cannot tell that it was superseded (#469)").toMatch(/\+\+speakGenRef\.current/);
		expect(body, "speakAndResume no longer bails when superseded — it will reopen the microphone during the utterance that replaced it (#469)").toMatch(/speakGenRef\.current !== myGen/);
		// ONE counter, shared with `speak`: two counters cannot order two utterances against each
		// other, which is the only ordering that matters here.
		expect(USE_VOICE.match(/useRef\(0\);/g)?.length, "a second speak generation counter would let the two paths supersede only themselves").toBeDefined();
		expect(USE_VOICE.match(/speakGenRef = useRef/g) ?? [], "there is more than one speak generation counter").toHaveLength(1);
	});
});
