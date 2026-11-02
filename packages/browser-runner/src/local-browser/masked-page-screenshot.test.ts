/**
 * #1067 — the legacy workflow browser path (`runtime_task`: JOB_APPLY / BROWSER_TASK) blurs form controls
 * before every stored frame, as the Scout/Runner replay does (#1063), and keeps NO frame when the capture
 * fails. `runner.ts` `shot()` (each `/browser/act` frame) and `challenge.ts` `captureScreenshotDataUrl`
 * (the handoff still) both capture through `maskedPageScreenshot`.
 *
 * Playwright-native since #1419: one `page.screenshot({style, mask, maskColor})` call, nothing to
 * mutate or confirm. Two layers: a fake page for the fail-closed rule, and real Chromium pages proving
 * the mask actually changes the rendered pixels — across the top document, a same-origin iframe, and an
 * open shadow root, since `style` is documented to pierce both and nothing here had ever proven it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureScreenshotDataUrl } from "../challenge.js";
import { launchTestChromium } from "../test-chromium.js";
import { maskedPageScreenshot, MASK_CSS, MASK_SELECTOR, type MaskablePage } from "./replay.js";

/** A page that records what it was asked, in order. */
function fakePage(opts: { shotThrows?: boolean } = {}) {
	const calls: string[] = [];
	const page: MaskablePage = {
		locator: (selector: string) => {
			calls.push(`locator:${selector}`);
			return {} as ReturnType<MaskablePage["locator"]>;
		},
		screenshot: async (o) => {
			calls.push("shot");
			expect(o.style).toBe(MASK_CSS);
			if (opts.shotThrows) throw new Error("timeout");
			return Buffer.from("jpeg-bytes");
		},
	};
	return { calls, page };
}

describe("maskedPageScreenshot — one native call, fail-closed (#1067, #1419)", () => {
	it("masks and captures in a single call, and returns the frame", async () => {
		const f = fakePage();
		expect(await maskedPageScreenshot(f.page, { quality: 45, timeout: 8_000 })).toBe(Buffer.from("jpeg-bytes").toString("base64"));
		expect(f.calls).toEqual([`locator:${MASK_SELECTOR}`, "shot"]);
	});

	it("no frame when the screenshot throws — nothing to unblur, nothing half-done", async () => {
		const f = fakePage({ shotThrows: true });
		expect(await maskedPageScreenshot(f.page, { quality: 45, timeout: 8_000 })).toBeUndefined();
	});
});

describe("in a real page — the mask changes the rendered pixels (#1067, #1419)", () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await launchTestChromium();
	});
	afterAll(async () => {
		await browser?.close();
	});

	it("a top-level input: masked and unmasked captures differ, byte for byte", async () => {
		const page = await browser.newPage();
		await page.setContent(`<form><input id="phone" value="+61 400 123 456"><textarea id="note">secret answer</textarea><p id="text">plain text</p></form>`);
		const unmasked = await page.screenshot({ type: "jpeg", quality: 90 });
		const maskedBase64 = await maskedPageScreenshot(page, { quality: 90, timeout: 8_000 });
		expect(maskedBase64 && maskedBase64.length > 100).toBe(true);
		const masked = Buffer.from(maskedBase64 as string, "base64");
		expect(masked.equals(unmasked)).toBe(false);
		// The page itself is never mutated: `style`/`mask` apply only for the instant of the capture.
		expect(await page.evaluate(() => getComputedStyle(document.getElementById("phone") as Element).filter)).toBe("none");
		const still = await captureScreenshotDataUrl(page);
		expect(still).toMatch(/^data:image\/jpeg;base64,/);
		await page.close();
	}, 20_000);

	it("an input inside an open shadow root: masked and unmasked captures differ", async () => {
		const page = await browser.newPage();
		await page.setContent(`<div id="shadow-host"></div>`);
		await page.evaluate(() => {
			const host = document.getElementById("shadow-host") as HTMLElement;
			const root = host.attachShadow({ mode: "open" });
			root.innerHTML = `<input id="shadowInput" value="shadow-secret-value" style="width:200px;height:40px">`;
		});
		const unmasked = await page.screenshot({ type: "jpeg", quality: 90 });
		const maskedBase64 = await maskedPageScreenshot(page, { quality: 90, timeout: 8_000 });
		expect(maskedBase64 && maskedBase64.length > 100).toBe(true);
		const masked = Buffer.from(maskedBase64 as string, "base64");
		expect(masked.equals(unmasked)).toBe(false);
		await page.close();
	}, 20_000);

	describe("an input inside a same-origin iframe", () => {
		let server: Server;
		let base: string;
		beforeAll(async () => {
			server = createServer((req, res) => {
				res.setHeader("Content-Type", "text/html");
				if (req.url === "/child") res.end(`<input id="childInput" value="iframe-secret-value" style="width:200px;height:40px">`);
				else res.end(`<iframe id="frame" src="/child" style="width:300px;height:100px;border:0"></iframe>`);
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		});
		afterAll(async () => {
			await new Promise((resolve) => server.close(resolve));
		});

		it("masked and unmasked captures differ, byte for byte — the mask reaches into the iframe's own document", async () => {
			const page = await browser.newPage();
			await page.goto(base);
			await page.waitForTimeout(200); // the iframe's own navigation
			const unmasked = await page.screenshot({ type: "jpeg", quality: 90 });
			const maskedBase64 = await maskedPageScreenshot(page, { quality: 90, timeout: 8_000 });
			expect(maskedBase64 && maskedBase64.length > 100).toBe(true);
			const masked = Buffer.from(maskedBase64 as string, "base64");
			expect(masked.equals(unmasked)).toBe(false);
			await page.close();
		}, 20_000);
	});
});

describe("no stored frame bypasses the mask (#1067, #1419)", () => {
	it("only the replay masker and live owner view may call screenshot directly", async () => {
		const { readdirSync, readFileSync, statSync } = await import("node:fs");
		const { join, relative } = await import("node:path");
		const ts = await import("typescript");
		const root = join(import.meta.dirname, "..");
		const direct: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const full = join(dir, name);
				if (statSync(full).isDirectory()) walk(full);
				else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
					const source = ts.createSourceFile(full, readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true);
					const visit = (node: import("typescript").Node) => {
						if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "screenshot") direct.push(relative(root, full));
						ts.forEachChild(node, visit);
					};
					visit(source);
				}
			}
		};
		walk(root);
		// This is an architectural boundary, checked on syntax nodes rather than line spelling.
		// The live owner control surface is intentionally unmasked; stored evidence is not.
		expect(direct.sort()).toEqual(["local-browser/replay.ts", "takeover-native.ts"]);
	});

	it("the workflow runner's stored-shot boundary actually applies the mask", async () => {
		const { LocalRunner } = await import("../runner.js");
		const f = fakePage();
		expect(await LocalRunner.prototype["shot"](f.page as unknown as import("playwright").Page)).toBe(Buffer.from("jpeg-bytes").toString("base64"));
		expect(f.calls).toEqual([`locator:${MASK_SELECTOR}`, "shot"]);
	});
});
