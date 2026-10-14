/**
 * The runner's replay recorder (#1063): every capture masks the page's form controls first and unmasks
 * after, captures NOTHING when the mask cannot be confirmed (fail closed), and is bounded by a per-run
 * cap, a per-frame size cap and a paged pull.
 */
import { describe, expect, it } from "vitest";
import type { BrowserTools } from "./bridge.js";
import { MASK_FORM_CONTROLS, MAX_SHOT_BASE64, SHOTS_PAGE_BASE64, ShotRecorder, UNMASK_FORM_CONTROLS } from "./replay.js";

const IMAGE = "/9j/4AAQSkZJRg==";

function fakeBrowser(opts: { mask?: "masked" | "unmasked" | "error"; image?: string | null } = {}) {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const tools: BrowserTools = {
		listTools: async () => [],
		callTool: async (name, args = {}) => {
			calls.push({ name, args });
			if (name === "browser_evaluate") {
				if (args.function === MASK_FORM_CONTROLS) {
					if (opts.mask === "error") return { content: [{ type: "text", text: "Error: page closed" }], isError: true };
					return { content: [{ type: "text", text: `### Result\n"${opts.mask ?? "masked"}"\n### Ran Playwright code` }] };
				}
				return { content: [{ type: "text", text: '### Result\n"unmasked"' }] };
			}
			if (name === "browser_take_screenshot") return { content: opts.image === null ? [{ type: "text", text: "no image" }] : [{ type: "image", data: opts.image ?? IMAGE, mimeType: "image/jpeg" }] };
			return { content: [] };
		},
	};
	return { tools, calls };
}

describe("ShotRecorder.capture", () => {
	it("masks every form control, takes a viewport JPEG, then unmasks — in that order", async () => {
		const b = fakeBrowser();
		const rec = new ShotRecorder(10, () => Date.parse("2026-10-14T00:00:00Z"));
		expect(await rec.capture(b.tools, "filled", { url: "https://jobs.example/apply" })).toBe(1);
		expect(b.calls.map((c) => c.name)).toEqual(["browser_evaluate", "browser_take_screenshot", "browser_evaluate"]);
		expect(b.calls[0].args.function).toBe(MASK_FORM_CONTROLS);
		expect(b.calls[1].args).toEqual({ type: "jpeg" });
		expect(b.calls[2].args.function).toBe(UNMASK_FORM_CONTROLS);
		expect(rec.shots).toEqual([{ seq: 1, point: "filled", url: "https://jobs.example/apply", mimeType: "image/jpeg", data: IMAGE, at: "2026-10-14T00:00:00.000Z" }]);
	});

	it("the mask blurs inputs, textareas, selects and contenteditable regions", () => {
		for (const sel of ["input", "textarea", "select", "[contenteditable]"]) expect(MASK_FORM_CONTROLS).toContain(sel);
		expect(MASK_FORM_CONTROLS).toMatch(/filter: blur\(\d+px\) !important/);
	});

	it.each([["the mask reports it is not in place", "unmasked"], ["the mask call errors", "error"]] as const)("fails closed: no screenshot is taken when %s", async (_label, mask) => {
		const b = fakeBrowser({ mask });
		const rec = new ShotRecorder(10);
		expect(await rec.capture(b.tools, "filled")).toBeNull();
		expect(b.calls.some((c) => c.name === "browser_take_screenshot")).toBe(false);
		expect(rec.shots).toEqual([]);
	});

	it("unmasks even when the screenshot yields no image, and keeps nothing", async () => {
		const b = fakeBrowser({ image: null });
		const rec = new ShotRecorder(10);
		expect(await rec.capture(b.tools, "snapshot")).toBeNull();
		expect(b.calls.at(-1)?.args.function).toBe(UNMASK_FORM_CONTROLS);
	});

	it("is capped per run, and refuses an oversized frame", async () => {
		const rec = new ShotRecorder(2);
		const b = fakeBrowser();
		expect([await rec.capture(b.tools, "clicked"), await rec.capture(b.tools, "clicked"), await rec.capture(b.tools, "clicked")]).toEqual([1, 2, null]);
		const big = new ShotRecorder(5);
		expect(await big.capture(fakeBrowser({ image: "A".repeat(MAX_SHOT_BASE64 + 4) }).tools, "clicked")).toBeNull();
	});
});

describe("ShotRecorder.page — what the cloud pulls", () => {
	it("returns frames after the cursor, paged by size, never advancing past one it did not return", async () => {
		const frame = "A".repeat(Math.floor(SHOTS_PAGE_BASE64 / 2) + 8);
		const rec = new ShotRecorder(10);
		const b = fakeBrowser({ image: frame });
		for (let i = 0; i < 3; i++) await rec.capture(b.tools, "navigated");
		const first = rec.page("run-1", 0);
		expect(first.shots.map((s) => s.seq)).toEqual([1]);
		expect(first.lastSeq).toBe(1);
		expect(rec.page("run-1", first.lastSeq).shots.map((s) => s.seq)).toEqual([2]);
		expect(rec.page("run-1", 3)).toEqual({ runId: "run-1", shots: [], lastSeq: 3 });
	});
});
