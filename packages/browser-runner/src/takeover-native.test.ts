import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { nativeTakeoverFrame, nativeTakeoverInput, stopNativeTakeover, type NativeTakeoverSession } from "./takeover-native.js";

function fixture() {
	let onFrame!: (frame: { data: Buffer; viewportWidth: number; viewportHeight: number }) => Promise<void>;
	const page = {
		screencast: { start: vi.fn(async (options) => { onFrame = options.onFrame; }), stop: vi.fn(async () => undefined) },
		screenshot: vi.fn(async () => Buffer.from("first frame")),
		evaluate: vi.fn(async () => ({ width: 901, height: 702 })),
		url: () => "https://example.test/page",
		mouse: { move: vi.fn(), down: vi.fn(), up: vi.fn(), click: vi.fn(), wheel: vi.fn() },
		keyboard: { insertText: vi.fn(), press: vi.fn() },
		goto: vi.fn(async () => undefined), goBack: vi.fn(async () => undefined), goForward: vi.fn(async () => undefined), reload: vi.fn(async () => undefined),
	};
	const session: NativeTakeoverSession = { page: page as unknown as Page };
	return { page, session, frame: (data: string) => onFrame({ data: Buffer.from(data), viewportWidth: 1802, viewportHeight: 1404 }) };
}

describe("native takeover across browser engines (#1431)", () => {
	it("starts one shared stream for concurrent polls and reports CSS coordinates rather than scaled frame dimensions", async () => {
		const { page, session, frame } = fixture();
		await Promise.all([nativeTakeoverFrame(session), nativeTakeoverFrame(session)]);
		expect(page.screencast.start).toHaveBeenCalledOnce();
		await frame("stream frame");
		expect(await nativeTakeoverFrame(session)).toEqual({ frame: `data:image/jpeg;base64,${Buffer.from("stream frame").toString("base64")}`, width: 901, height: 702, url: "https://example.test/page" });
		await stopNativeTakeover(session);
		expect(page.screencast.stop).toHaveBeenCalledOnce();
		expect(session.latestFrame).toBeUndefined();
	});

	it("uses native mouse, keyboard and navigation APIs without requiring a Chromium CDP session", async () => {
		const { page, session } = fixture();
		await nativeTakeoverInput(session, { type: "down", x: 10, y: 20 });
		await nativeTakeoverInput(session, { type: "up", x: 11, y: 21 });
		await nativeTakeoverInput(session, { type: "click", x: 12, y: 22 });
		await nativeTakeoverInput(session, { type: "scroll", x: 13, y: 23, deltaY: 100 });
		await nativeTakeoverInput(session, { type: "text", text: "hello" });
		await nativeTakeoverInput(session, { type: "key", key: "Enter", keyCode: 13 });
		await nativeTakeoverInput(session, { type: "navigate", url: "example.test" });
		expect(page.mouse.move.mock.calls).toEqual([[10, 20], [11, 21], [13, 23]]);
		expect(page.mouse.click).toHaveBeenCalledWith(12, 22);
		expect(page.mouse.wheel).toHaveBeenCalledWith(0, 100);
		expect(page.keyboard.insertText).toHaveBeenCalledWith("hello");
		expect(page.keyboard.press).toHaveBeenCalledWith("Enter");
		expect(page.goto).toHaveBeenCalledWith("https://example.test/", expect.any(Object));
		expect(page.screencast.start).not.toHaveBeenCalled();
	});

	it("does not mark a failed stream started, so a later poll can retry", async () => {
		const { page, session } = fixture();
		page.screencast.start.mockRejectedValueOnce(new Error("page unavailable"));
		await expect(nativeTakeoverFrame(session)).rejects.toThrow("page unavailable");
		await nativeTakeoverFrame(session);
		expect(page.screencast.start).toHaveBeenCalledTimes(2);
	});

	it("waits for an in-flight stream start before stopping it", async () => {
		const { page, session } = fixture();
		let release!: () => void;
		page.screencast.start.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
		const poll = nativeTakeoverFrame(session);
		const stop = stopNativeTakeover(session);
		release();
		await Promise.all([poll, stop]);
		expect(page.screencast.stop).toHaveBeenCalledOnce();
		expect(session.screencasting).toBe(false);
	});
});
