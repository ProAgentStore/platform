/**
 * #1067 — the legacy workflow browser path (`runtime_task`: JOB_APPLY / BROWSER_TASK) blurs form controls
 * before every stored frame, as the Scout/Runner replay does (#1063), and keeps NO frame when the blur
 * cannot be confirmed. `runner.ts` `shot()` (each `/browser/act` frame) and `challenge.ts`
 * `captureScreenshotDataUrl` (the handoff still) both capture through `maskedPageScreenshot`.
 *
 * Two layers: a fake page for the order and the fail-closed rule, and a real Chromium page proving the
 * blur is IN the page at the moment of capture and gone straight after.
 */
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureScreenshotDataUrl } from "../challenge.js";
import { maskedPageScreenshot, MASK_FORM_CONTROLS, UNMASK_FORM_CONTROLS } from "./replay.js";

/** A page that records what it was asked, in order. */
function fakePage(opts: { mask?: unknown; maskThrows?: boolean; shotThrows?: boolean } = {}) {
	const calls: string[] = [];
	return {
		calls,
		page: {
			evaluate: async (expression: string) => {
				if (expression === `(${MASK_FORM_CONTROLS})()`) {
					calls.push("mask");
					if (opts.maskThrows) throw new Error("page closed");
					return "mask" in opts ? opts.mask : "masked";
				}
				if (expression === `(${UNMASK_FORM_CONTROLS})()`) {
					calls.push("unmask");
					return "unmasked";
				}
				calls.push(`other:${expression}`);
				return null;
			},
			screenshot: async () => {
				calls.push("shot");
				if (opts.shotThrows) throw new Error("timeout");
				return Buffer.from("jpeg-bytes");
			},
		},
	};
}

describe("maskedPageScreenshot — the order and the fail-closed rule (#1067)", () => {
	it("blurs, captures, unblurs — and returns the frame", async () => {
		const f = fakePage();
		expect(await maskedPageScreenshot(f.page, { quality: 45, timeout: 8_000 })).toBe(Buffer.from("jpeg-bytes").toString("base64"));
		expect(f.calls).toEqual(["mask", "shot", "unmask"]);
	});

	it("no frame when the blur is not confirmed, or cannot run — the page is never captured unblurred", async () => {
		for (const opts of [{ mask: "unmasked" }, { mask: null }, { maskThrows: true }]) {
			const f = fakePage(opts);
			expect(await maskedPageScreenshot(f.page, { quality: 45, timeout: 8_000 })).toBeUndefined();
			expect(f.calls).not.toContain("shot");
		}
	});

	it("a capture that fails still unblurs the page", async () => {
		const f = fakePage({ shotThrows: true });
		expect(await maskedPageScreenshot(f.page, { quality: 45, timeout: 8_000 })).toBeUndefined();
		expect(f.calls).toEqual(["mask", "shot", "unmask"]);
	});
});

describe("in a real page (#1067)", () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await chromium.launch();
	});
	afterAll(async () => {
		await browser?.close();
	});

	it("the typed field is blurred AT the moment of capture, and the blur is gone straight after — for the per-action frame and the handoff still", async () => {
		const page = await browser.newPage();
		await page.setContent(`<form><input id="phone" value="+61 400 123 456"><textarea id="note">secret answer</textarea><p id="text">plain text</p></form>`);
		const filters: Array<{ input: string; textarea: string; text: string }> = [];
		const realShot = page.screenshot.bind(page);
		// Read the page's computed style at the instant the frame is taken.
		page.screenshot = (async (o: Parameters<typeof realShot>[0]) => {
			filters.push(
				await page.evaluate(() => ({
					input: getComputedStyle(document.getElementById("phone") as Element).filter,
					textarea: getComputedStyle(document.getElementById("note") as Element).filter,
					text: getComputedStyle(document.getElementById("text") as Element).filter,
				})),
			);
			return realShot(o);
		}) as typeof page.screenshot;

		const frame = await maskedPageScreenshot(page, { quality: 45, timeout: 8_000 });
		const still = await captureScreenshotDataUrl(page);
		expect(frame && frame.length > 100).toBe(true);
		expect(still).toMatch(/^data:image\/jpeg;base64,/);
		expect(filters).toEqual([
			{ input: "blur(8px)", textarea: "blur(8px)", text: "none" },
			{ input: "blur(8px)", textarea: "blur(8px)", text: "none" },
		]);
		// Unblurred straight after: the next human or automated step sees the real page.
		expect(await page.evaluate(() => getComputedStyle(document.getElementById("phone") as Element).filter)).toBe("none");
		await page.close();
	});
});

describe("no stored frame bypasses the blur (#1067)", () => {
	it("the only direct page.screenshot outside maskedPageScreenshot is the LIVE takeover fallback — and runner shot() masks", async () => {
		const { readdirSync, readFileSync, statSync } = await import("node:fs");
		const { join, relative } = await import("node:path");
		const root = join(import.meta.dirname, "..");
		const direct: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const full = join(dir, name);
				if (statSync(full).isDirectory()) walk(full);
				else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
					readFileSync(full, "utf8")
						.split("\n")
						.forEach((line, i) => {
							if (/\.screenshot\(/.test(line)) direct.push(`${relative(root, full)}:${i + 1}`);
						});
				}
			}
		};
		walk(root);
		// replay.ts is maskedPageScreenshot itself. runner.ts's one is `takeoverFrame`'s first-frame
		// fallback: the person's live control surface, which must show what they are typing into.
		expect(direct.map((d) => d.split(":")[0]).sort()).toEqual(["local-browser/replay.ts", "runner.ts"]);
		const runner = readFileSync(join(root, "runner.ts"), "utf8");
		const takeover = runner.split("\n").findIndex((l) => /\.screenshot\(/.test(l));
		expect(runner.split("\n").slice(Math.max(0, takeover - 12), takeover).join("\n")).toMatch(/async takeoverFrame\(/);
		expect(runner).toMatch(/private async shot\(page: Page\)[^}]*maskedPageScreenshot\(page/);
	});
});
