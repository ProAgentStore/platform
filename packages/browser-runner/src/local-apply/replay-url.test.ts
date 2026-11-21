import { describe, expect, it } from "vitest";
import { ShotRecorder } from "../local-browser/replay.js";
import { ApplyReplay } from "./apply-replay.js";
import type { LocalApplyEvent } from "./contract.js";

const SEEK = "https://seek.example.test/job/1/apply";
const EMPLOYER = "https://careers.example.test/apply/abc";

describe("replay frame URL attribution (#1519)", () => {
	it("labels a frame with the URL the page had when the screenshot finished, not before an in-capture redirect", async () => {
		let now = SEEK;
		const page = { url: () => now, locator: () => ({}) as never, screenshot: async () => { now = EMPLOYER; return Buffer.from("pixels"); } };
		const events: Array<Omit<LocalApplyEvent, "at">> = [];
		const shots = new ShotRecorder(5);
		const replay = new ApplyReplay({ emit: (e) => { events.push(e); }, page: () => page }, shots);
		await replay.beforePause({ reason: "missing_answer", url: SEEK } as never);
		expect(shots.shots[0]?.url).toBe(EMPLOYER);
		expect(events.find((e) => e.type === "screenshot.captured")?.url).toBe(EMPLOYER);
	});

	it("still records a URL when the page was unreadable before the capture (mid-navigation)", async () => {
		let reads = 0;
		const page = { url: () => (++reads === 1 ? "" : EMPLOYER), locator: () => ({}) as never, screenshot: async () => Buffer.from("pixels") };
		const shots = new ShotRecorder(5);
		const replay = new ApplyReplay({ emit: () => undefined, page: () => page }, shots);
		await replay.beforePause({ reason: "missing_answer", url: "" } as never);
		expect(shots.shots[0]?.url).toBe(EMPLOYER);
	});
});
