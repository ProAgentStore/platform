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
