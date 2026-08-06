import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceStt } from "./stt.js";

/** Drive the private Whisper upload directly — start() needs a real mic + recorder. */
const transcribe = (stt: VoiceStt, blob: Blob) =>
	(stt as unknown as { _transcribeWhisper(b: Blob): Promise<void> })._transcribeWhisper(blob);

/** Stub fetch + localStorage; returns the captured request FormData bodies. */
function stubFetch(response: { ok: boolean; text?: string }) {
	const bodies: FormData[] = [];
	vi.stubGlobal("localStorage", { getItem: () => "test-token" });
	vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: FormData }) => {
		bodies.push(init.body);
		return {
			ok: response.ok,
			body: null, // no SSE stream → the plain-json path
			json: async () => ({ text: response.text ?? "" }),
			text: async () => "",
		};
	}));
	return bodies;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Whisper transcription request", () => {
	it("sends the configured language and returns the transcript", async () => {
		const results: string[] = [];
		const bodies = stubFetch({ ok: true, text: "你好" });
		const stt = new VoiceStt("openai", { language: "zh-CN", onResult: (t) => results.push(t) });

		await transcribe(stt, new Blob(["x"], { type: "audio/webm" }));

		expect(bodies[0].get("language")).toBe("zh");
		expect(results).toEqual(["你好"]);
	});

	it("sends the vocabulary-bias prompt only when transcribing English", async () => {
		const bodies = stubFetch({ ok: true, text: "hi" });
		const prompt = "Expect terms like: repo, commit.";

		await transcribe(new VoiceStt("openai", { language: "en-US", transcribePrompt: prompt }), new Blob(["x"], { type: "audio/webm" }));
		expect(String(bodies[0].get("prompt"))).toContain("repo");

		// An English prompt hints Whisper's OUTPUT language — with language=zh it pulls
		// Chinese speech toward English, so it must be omitted.
		await transcribe(new VoiceStt("openai", { language: "zh-CN", transcribePrompt: prompt }), new Blob(["x"], { type: "audio/webm" }));
		expect(bodies[1].get("prompt")).toBeNull();
	});
});

// ── #291: a swallowed failure that leaves the microphone live is not "degraded" ──
describe("stop() always releases the microphone", () => {
	/** A fake mic track that records whether it was stopped. */
	function track(opts: { throws?: boolean } = {}) {
		return {
			stopped: false,
			stop() {
				this.stopped = true;
				if (opts.throws) throw new Error("track is wedged");
			},
		};
	}

	/** Wire fake `_mediaRec` + `_stream` internals onto a real VoiceStt. */
	function sttWith(mediaRec: unknown, tracks: Array<{ stop(): void }>) {
		const stt = new VoiceStt("openai", {});
		const priv = stt as unknown as { _mediaRec: unknown; _stream: unknown };
		priv._mediaRec = mediaRec;
		priv._stream = { getTracks: () => tracks };
		return stt;
	}

	it("stops the mic tracks when MediaRecorder.stop() throws", () => {
		// The bug this closes: `stop()` was `try { this._mediaRec.stop() } catch {}`, and the
		// track teardown lived only in the recorder's `onstop`. If `stop()` threw, `onstop` never
		// fired and the `else if` branch was unreachable — so the MediaStream stayed live: the
		// browser's recording indicator stayed lit and the mic kept capturing after the user
		// turned voice off.
		const t = track();
		const stt = sttWith(
			{
				state: "recording",
				stop() {
					throw new Error("InvalidStateError");
				},
			},
			[t],
		);

		expect(() => stt.stop()).not.toThrow();
		expect(t.stopped).toBe(true);
	});

	it("does NOT pre-empt onstop when the recorder stops cleanly", () => {
		// The inverse must hold: tearing tracks down here races the final `dataavailable` and
		// drops the recording (→ empty blob → no transcription). Only the throwing path releases.
		const t = track();
		const stt = sttWith({ state: "recording", stop() {} }, [t]);

		stt.stop();
		expect(t.stopped).toBe(false);
	});

	// #325 — the dictation half of the same bug. Whisper mode was fixed above; browser mode
	// runs a SpeechRecognition instead, and its `stop()` was wrapped in a bare `catch {}`.
	it("aborts the recognizer when SpeechRecognition.stop() throws (browser dictation)", () => {
		const rec = {
			aborted: false,
			stop() {
				throw new Error("InvalidStateError");
			},
			abort() {
				this.aborted = true;
			},
		};
		const stt = new VoiceStt("browser", {});
		(stt as unknown as { _rec: unknown })._rec = rec;

		expect(() => stt.stop()).not.toThrow();
		// Without this the recognizer stayed running: `onend` never fires after a failed stop,
		// so Web Speech kept streaming the mic after the user turned voice off.
		expect(rec.aborted).toBe(true);
	});

	it("does NOT abort a recognizer that stopped cleanly", () => {
		// abort() forfeits the final result; a clean stop must be allowed to deliver it.
		const rec = { aborted: false, stop() {}, abort() { this.aborted = true; } };
		const stt = new VoiceStt("browser", {});
		(stt as unknown as { _rec: unknown })._rec = rec;

		stt.stop();
		expect(rec.aborted).toBe(false);
	});

	it("releases every track even when one of them throws", () => {
		const bad = track({ throws: true });
		const good = track();
		const stt = sttWith(
			{
				state: "recording",
				stop() {
					throw new Error("InvalidStateError");
				},
			},
			[bad, good],
		);

		expect(() => stt.stop()).not.toThrow();
		// `good` is the regression: one wedged track used to strand every later one.
		expect(good.stopped).toBe(true);
	});
});
