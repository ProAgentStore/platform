import { chromium, firefox, webkit, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { launchTestChromium } from "../test-chromium.js";
import { capturePageScreenshot, ShotRecorder } from "./replay.js";

// Chromium is already required by the runner suite. The release smoke explicitly selects
// additional installed engines; selecting an unavailable engine must fail, never skip.
const requested = process.env.PAGS_TEST_BROWSER_ENGINES;
const engines = (requested || "chromium").split(",").map((value) => value.trim());
for (const engine of engines) if (!["chromium", "chrome", "msedge", "firefox", "webkit"].includes(engine)) throw new Error(`Unsupported screenshot browser: ${engine}`);

async function regionPixels(page: Page, image: string, box: { x: number; y: number; width: number; height: number }) {
	return page.evaluate(async ({ image, box }) => {
		const img = new Image();
		img.src = `data:image/jpeg;base64,${image}`;
		await img.decode();
		const canvas = document.createElement("canvas");
		canvas.width = img.width;
		canvas.height = img.height;
		const ctx = canvas.getContext("2d")!;
		ctx.drawImage(img, 0, 0);
		return Array.from(ctx.getImageData(Math.ceil(box.x) + 5, Math.ceil(box.y) + 5, Math.floor(box.width) - 10, Math.floor(box.height) - 10).data);
	}, { image, box });
}

describe("owner screenshot blur policy renders real pixels (#1433)", () => {
	for (const engine of engines) {
		it(`${engine}: explicit off preserves rendered fields; default masks top, shadow and frame controls without changing passwords`, async () => {
			const browserType = engine === "firefox" ? firefox : engine === "webkit" ? webkit : chromium;
			const browser = requested
				? await browserType.launch({ headless: true, ...(["chrome", "msedge", "chromium"].includes(engine) ? { channel: engine } : {}) })
				: await launchTestChromium();
			try {
				const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
				const fieldStyle = "width:360px;height:44px;font:24px monospace;color:black;background:white;border:0;padding:0;caret-color:transparent";
				await page.setContent(`<style>body{margin:20px}input{${fieldStyle}}div{margin:15px 0}iframe{width:450px;height:80px;border:0}</style><input id="plain" value="Visible field answer"><div><input id="password" type="password" value="password-stays-masked"></div><div id="host"></div><iframe srcdoc='<input id="framed" value="Framed field answer" style="${fieldStyle}">'></iframe>`);
				await page.locator("#host").evaluate((host, style) => {
					host.attachShadow({ mode: "open" }).innerHTML = `<input id="shadow" value="Shadow field answer" style="${style}">`;
				}, fieldStyle);
				await page.frameLocator("iframe").locator("#framed").waitFor();
				const opts = { quality: 90, timeout: 8_000 };
				const baseline = (await page.screenshot({ type: "jpeg", ...opts, scale: "css" })).toString("base64");
				const raw = await capturePageScreenshot(page, { ...opts, blurFormFields: false });
				expect(raw).toBe(baseline);
				const masked = await capturePageScreenshot(page, opts);
				expect(masked).toBeTruthy();
				for (const locator of [page.locator("#plain"), page.locator("#shadow"), page.frameLocator("iframe").locator("#framed")]) {
					const box = await locator.boundingBox();
					if (!box || !raw || !masked) throw new Error("Missing screenshot fixture");
					const [rawPixels, maskedPixels] = await Promise.all([regionPixels(page, raw, box), regionPixels(page, masked, box)]);
					// Inspect each control's own image region so masking another control cannot make
					// this pass when iframe or shadow-root protection is accidentally dropped.
					expect(rawPixels.filter((value, i) => i % 4 !== 3 && Math.abs(value - maskedPixels[i]) > 30).length).toBeGreaterThan(100);
					expect(await locator.evaluate((element) => getComputedStyle(element).filter)).toBe("none");
				}
				expect(await page.locator("#password").getAttribute("type")).toBe("password");
				expect(await page.locator("#password").inputValue()).toBe("password-stays-masked");
				// Replay retains the selected policy for later capture points on the same run.
				const recorder = new ShotRecorder(2, () => 0, false);
				await recorder.capture(page, "snapshot");
				expect(recorder.shots[0]?.data).toBe(await capturePageScreenshot(page, { quality: 50, timeout: 8_000, blurFormFields: false }));
				const disabled = new ShotRecorder(0, () => 0, false);
				expect(await disabled.capture(page, "snapshot")).toBeNull();
				expect(disabled.shots).toEqual([]);
			} finally {
				await browser.close();
			}
		});
	}
});
