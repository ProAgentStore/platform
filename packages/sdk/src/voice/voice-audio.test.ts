import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadVoiceAudio } from "./voice-audio.js";
import * as client from "../client.js";

/**
 * The replay-upload's skip/retry rules. These branches existed inside `use-voice.ts` with no
 * coverage at all — that file is a React hook, so nothing could reach them without a DOM and
 * a mic. Extracting the function made them testable, which is most of the point of the move.
 *
 * `fetch` is stubbed via stubGlobal, not spyOn: Node defines the global as an accessor, so a
 * plain spy does not intercept it and the tests quietly hit the real network instead.
 */

function blobOf(bytes: number, type = "audio/webm"): Blob {
	return new Blob([new Uint8Array(bytes)], { type });
}

/**
 * Stub `fetch` and return the mock, so each test states its own server behaviour.
 *
 * `localStorage` is stubbed alongside it because `getToken()` reads it for the Bearer
 * header. In a browser it always exists; under Node it throws, and — since the read happens
 * INSIDE the retry try/block — that failure looked exactly like three failed uploads.
 */
function stubFetch(): ReturnType<typeof vi.fn> {
	vi.stubGlobal("localStorage", { getItem: () => "test-session-token", setItem() {}, removeItem() {} });
	const mock = vi.fn();
	vi.stubGlobal("fetch", mock);
	return mock;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

/** Run `fn` with fake timers so the 600/1200ms retry backoff doesn't cost wall-clock time. */
async function runWithFakeTimers(fn: () => Promise<void>): Promise<void> {
	vi.useFakeTimers();
	const done = fn();
	await vi.runAllTimersAsync();
	await done;
}

describe("uploadVoiceAudio", () => {
	it("skips an empty recording with a specific reason, and never calls the API", async () => {
		const report = vi.spyOn(client, "reportClientError").mockImplementation(() => {});
		const fetchMock = stubFetch();

		await uploadVoiceAudio("inst1", "turn1", blobOf(0));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(report).toHaveBeenCalledWith("voice-audio", expect.stringContaining("empty recording blob"));
	});

	it("skips a recording over the 5MB server cap rather than earning a bare 400", async () => {
		const report = vi.spyOn(client, "reportClientError").mockImplementation(() => {});
		const fetchMock = stubFetch();

		await uploadVoiceAudio("inst1", "turn1", blobOf(5 * 1024 * 1024 + 1));

		expect(fetchMock).not.toHaveBeenCalled();
		// The message must name the actual size — that is what made these diagnosable.
		expect(report).toHaveBeenCalledWith("voice-audio", expect.stringContaining("5MB cap"));
	});

	it("PUTs to the instance's voice-audio path and reports nothing on success", async () => {
		const report = vi.spyOn(client, "reportClientError").mockImplementation(() => {});
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(new Response("", { status: 200 }));

		await uploadVoiceAudio("inst1", "turn-abc", blobOf(10));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/v1/instances/inst1/voice-audio/turn-abc");
		expect(init.method).toBe("PUT");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-session-token");
		// `keepalive` caps the body at 64KB, which is smaller than a real recording — it must
		// stay off, or the PUT fails outright. This is the regression that comment guards.
		expect(init).not.toHaveProperty("keepalive");
		expect(report).not.toHaveBeenCalled();
	});

	it("does NOT retry a 4xx — it cannot succeed, and keeps the server's reason in the log", async () => {
		const report = vi.spyOn(client, "reportClientError").mockImplementation(() => {});
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(new Response("empty audio", { status: 400 }));

		await runWithFakeTimers(() => uploadVoiceAudio("inst1", "turn1", blobOf(10)));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		// "HTTP 400" alone was undiagnosable — the body must survive into the message.
		expect(report).toHaveBeenCalledWith("voice-audio", expect.stringContaining("HTTP 400"));
		expect(report).toHaveBeenCalledWith("voice-audio", expect.stringContaining("empty audio"));
	});

	it("retries a 5xx up to three attempts before giving up", async () => {
		const report = vi.spyOn(client, "reportClientError").mockImplementation(() => {});
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(new Response("nope", { status: 503 }));

		await runWithFakeTimers(() => uploadVoiceAudio("inst1", "turn1", blobOf(10)));

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(report).toHaveBeenCalledWith("voice-audio", expect.stringContaining("after retries"));
	});

	it("recovers a dropped connection on a later attempt (mobile) and stays silent", async () => {
		const report = vi.spyOn(client, "reportClientError").mockImplementation(() => {});
		const fetchMock = stubFetch();
		fetchMock
			.mockRejectedValueOnce(new Error("Load failed"))
			.mockResolvedValueOnce(new Response("", { status: 200 }));

		await runWithFakeTimers(() => uploadVoiceAudio("inst1", "turn1", blobOf(10)));

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(report).not.toHaveBeenCalled();
	});
});
