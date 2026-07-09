import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanForSpeech, VoiceTts } from "./tts.js";

describe("cleanForSpeech", () => {
	it("leaves plain prose untouched", () => {
		expect(cleanForSpeech("Your flight is booked, see you at the gate.")).toBe(
			"Your flight is booked, see you at the gate.",
		);
	});

	it("replaces fenced code blocks with '(code)'", () => {
		expect(cleanForSpeech("before ```\nconst x = 1\n``` after")).toBe("before (code) after");
	});

	it("keeps short plain-word inline code but drops technical tokens", () => {
		expect(cleanForSpeech("run `npm test` please")).toBe("run npm test please");
		expect(cleanForSpeech("value `x.y_z()` here")).toBe("value here");
	});

	it("replaces URLs with 'a link'", () => {
		expect(cleanForSpeech("go to https://example.com/path?q=1 now")).toBe("go to a link now");
	});

	it("replaces unix + windows file paths with 'a file'", () => {
		expect(cleanForSpeech("open /etc/hosts please")).toBe("open a file please");
		expect(cleanForSpeech("edit ./src/app.ts now")).toBe("edit a file now");
	});

	it("replaces bare filenames-with-extensions with 'a file'", () => {
		expect(cleanForSpeech("the config.json file")).toBe("the a file file");
	});

	it("strips git-like hashes", () => {
		expect(cleanForSpeech("commit deadbeef1 done")).toBe("commit done");
	});

	it("strips markdown formatting characters", () => {
		expect(cleanForSpeech("**Bold** _italic_ # Heading")).toBe("Bold italic Heading");
	});

	it("strips emoji", () => {
		expect(cleanForSpeech("Nice work 🎉 done")).toBe("Nice work done");
	});

	it("collapses whitespace", () => {
		expect(cleanForSpeech("a\n\n  b\t c")).toBe("a b c");
	});

	it("caps the spoken length at 1500 chars", () => {
		expect(cleanForSpeech("a".repeat(3000)).length).toBe(1500);
	});
});

describe("cleanForSpeech (technical mode)", () => {
	const tech = (s: string) => cleanForSpeech(s, { technical: true });

	it("keeps the file basename but drops the long directory chain", () => {
		expect(tech("the change is in ~/dev/stores/pags/workers/api/src/agent-think.ts now"))
			.toBe("the change is in agent-think.ts now");
		expect(tech("edit src/App.tsx here")).toBe("edit App.tsx here");
	});

	it("keeps bare filenames (a dev wants to hear the file named)", () => {
		expect(tech("the config.json file")).toBe("the config.json file");
	});

	it("speaks inline code as its contents instead of dropping it", () => {
		expect(tech("call `resolveAgentCapabilities` first")).toBe("call resolveAgentCapabilities first");
	});

	it("does not mangle ordinary slashed prose like read/write", () => {
		expect(tech("it is a read/write conflict")).toBe("it is a read/write conflict");
	});

	it("still summarizes fenced code blocks and condenses URLs + hashes", () => {
		expect(tech("here ```\nconst x = 1\n``` see https://x.com/y at deadbeef1 done"))
			.toBe("here (code) see a link at done");
	});
});

describe("VoiceTts.unlock", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("browser voice speaks in the configured language with a matching voice", async () => {
		const zhVoice = { lang: "zh-CN", name: "Tingting" };
		const spoken: Array<{ lang: string; voice: unknown }> = [];
		const synth = {
			cancel() {},
			resume() {},
			getVoices: () => [{ lang: "en-US", name: "Samantha" }, zhVoice],
			speak: vi.fn((u: { lang: string; voice: unknown; onend?: (() => void) | null }) => {
				spoken.push({ lang: u.lang, voice: u.voice });
				u.onend?.();
			}),
		};
		vi.stubGlobal("window", { speechSynthesis: synth });
		vi.stubGlobal("speechSynthesis", synth);
		vi.stubGlobal("SpeechSynthesisUtterance", class {
			text: string;
			lang = "";
			voice: unknown = null;
			rate = 1;
			onend: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor(t: string) { this.text = t; }
		});

		await new VoiceTts("browser", { language: "zh-CN" }).speak("你好");

		expect(spoken).toHaveLength(1);
		expect(spoken[0].lang).toBe("zh-CN");
		expect(spoken[0].voice).toBe(zhVoice);
	});

	it("resumes a suspended SpeechSynthesis + speaks a silent priming utterance", async () => {
		const speak = vi.fn();
		const resume = vi.fn();
		const synth = { resume, speak };
		vi.stubGlobal("window", { speechSynthesis: synth });
		vi.stubGlobal("speechSynthesis", synth);
		vi.stubGlobal("SpeechSynthesisUtterance", class {
			text: string;
			volume = 1;
			constructor(t: string) { this.text = t; }
		});

		await new VoiceTts("browser").unlock();

		expect(resume).toHaveBeenCalled();
		expect(speak).toHaveBeenCalledTimes(1);
		// Primes with a silent (volume 0) utterance — audible artifacts would be a bug.
		expect(speak.mock.calls[0][0].volume).toBe(0);
	});

	it("resumes a suspended AudioContext for the OpenAI voice (created in-gesture)", async () => {
		const resume = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("AudioContext", class {
			state = "suspended";
			resume = resume;
		});
		const synth = { resume: vi.fn(), speak: vi.fn() };
		vi.stubGlobal("window", { speechSynthesis: synth });
		vi.stubGlobal("speechSynthesis", synth);
		vi.stubGlobal("SpeechSynthesisUtterance", class { volume = 1; constructor(_: string) {} });

		await new VoiceTts("openai").unlock();

		expect(resume).toHaveBeenCalled();
	});

	it("never throws when no audio APIs exist in the environment", async () => {
		vi.stubGlobal("window", {});
		vi.stubGlobal("speechSynthesis", undefined);
		await expect(new VoiceTts("openai").unlock()).resolves.toBeUndefined();
	});
});

describe("VoiceTts OpenAI playback — iOS AudioContext recovery", () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	/** A fetch that returns audio bytes for the TTS proxy and OK for the error log. */
	const stubAudioFetch = () =>
		vi.stubGlobal("fetch", vi.fn(async (url: string) =>
			String(url).includes("/v1/errors")
				? ({ ok: true } as unknown as Response)
				: ({ ok: true, arrayBuffer: async () => new ArrayBuffer(32) } as unknown as Response),
		));

	const bufferSource = () => ({ buffer: null as unknown, connect() {}, onended: null as null | (() => void), start() { this.onended?.(); } });

	it("revives an 'interrupted' context (iOS) and plays via Web Audio — no browser fallback", async () => {
		vi.stubGlobal("localStorage", { getItem: () => "tok", setItem() {}, removeItem() {} });
		stubAudioFetch();
		const resume = vi.fn(async function (this: { state: string }) { this.state = "running"; });
		const decodeAudioData = vi.fn(async () => ({}));
		vi.stubGlobal("AudioContext", class {
			state = "interrupted"; // the state the OLD code gave up on
			resume = resume;
			decodeAudioData = decodeAudioData;
			destination = {};
			createBufferSource() { return bufferSource(); }
		});
		// If it wrongly fell back, this would be used — assert it ISN'T.
		const synthSpeak = vi.fn();
		vi.stubGlobal("speechSynthesis", { cancel() {}, resume() {}, speak: synthSpeak });
		vi.stubGlobal("window", { speechSynthesis: { cancel() {}, resume() {}, speak: synthSpeak } });

		await new VoiceTts("openai").speak("hello there");

		expect(resume).toHaveBeenCalled();
		expect(decodeAudioData).toHaveBeenCalled(); // played through Web Audio
		expect(synthSpeak).not.toHaveBeenCalled(); // did NOT drop to the browser voice
	});

	it("falls back to the browser voice only when resume() still can't revive it", async () => {
		vi.stubGlobal("localStorage", { getItem: () => "tok", setItem() {}, removeItem() {} });
		stubAudioFetch();
		const resume = vi.fn(async () => {}); // stays "interrupted"
		const decodeAudioData = vi.fn(async () => ({}));
		vi.stubGlobal("AudioContext", class {
			state = "interrupted";
			resume = resume;
			decodeAudioData = decodeAudioData;
			destination = {};
			createBufferSource() { return bufferSource(); }
		});
		// Resolve _speakBrowser immediately by firing onend from within speak().
		const synthSpeak = vi.fn((u: { onend?: () => void }) => u.onend?.());
		const synth = { cancel() {}, resume() {}, speak: synthSpeak };
		vi.stubGlobal("speechSynthesis", synth);
		vi.stubGlobal("window", { speechSynthesis: synth });
		vi.stubGlobal("SpeechSynthesisUtterance", class { rate = 1; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(public text: string) {} });

		await new VoiceTts("openai").speak("hello");

		expect(resume).toHaveBeenCalled();
		expect(decodeAudioData).not.toHaveBeenCalled(); // never got a running context
		expect(synthSpeak).toHaveBeenCalled(); // used the browser voice
	});
});
