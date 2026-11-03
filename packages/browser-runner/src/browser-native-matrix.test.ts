import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, firefox, webkit, type BrowserContext } from "playwright";
import { McpRuntime } from "./mcp-runtime.js";
import { maskedPageScreenshot } from "./local-browser/replay.js";
import { nativeTakeoverFrame, nativeTakeoverInput, stopNativeTakeover, type NativeTakeoverSession } from "./takeover-native.js";

// Dedicated release smoke: CI installs the runner's matching binaries, then explicitly selects
// its matrix. A selected missing browser is a failure, never an availability-based skip.
const requested = process.env.PAGS_TEST_BROWSER_ENGINES;
const engines = (requested || "chromium").split(",").map((value) => value.trim());
for (const engine of engines) if (!["chromium", "chrome", "msedge", "firefox", "webkit"].includes(engine)) throw new Error(`Unsupported smoke browser: ${engine}`);

describe.skipIf(!requested)("native MCP, masked replay and owner takeover on real engines (#1431)", () => {
	const server = createServer((_req, res) => {
		res.setHeader("Content-Type", "text/html");
		res.end(`<!doctype html><title>Native browser fixture</title><style>input { width: 250px; outline: none; border: 1px solid #888; } button { margin: 20px; }</style><h1>Browser fixture</h1><label>Full name <input id="name" onkeydown="if(event.key==='Enter')document.querySelector('#result').textContent='entered'"></label><label>Passcode <input id="secret" type="password"></label><button id="count" onclick="document.querySelector('#result').textContent='clicked'">Count</button><p id="result">ready</p>`);
	});
	let url: string;
	beforeAll(async () => {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No fixture port");
		url = `http://127.0.0.1:${address.port}/`;
	});
	afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

	for (const engine of engines) {
		it(`${engine}: standard MCP drives the caller's exact page; replay masks fields and native takeover streams and clicks`, async () => {
			const profileDir = mkdtempSync(join(tmpdir(), `pags-native-${engine}-`));
			let context: BrowserContext | undefined;
			let takeover: NativeTakeoverSession | undefined;
			const mcp = new McpRuntime();
			try {
				const browserType = engine === "firefox" ? firefox : engine === "webkit" ? webkit : chromium;
				context = await browserType.launchPersistentContext(profileDir, { headless: true, viewport: { width: 800, height: 600 }, ...(["chrome", "msedge", "chromium"].includes(engine) ? { channel: engine } : {}) });
				await mcp.start({ context });
				const navigated = await mcp.callTool("browser_navigate", { url });
				expect(navigated.isError).not.toBe(true);
				const page = context.pages()[0];
				expect(page.url()).toBe(url);
				const snapshot = mcp.textOf(await mcp.callTool("browser_snapshot"));
				const ref = snapshot.match(/textbox "Full name"[^\n]*\[ref=(\w+)\]/)?.[1];
				expect(ref).toBeTruthy();
				const typed = await mcp.callTool("browser_type", { element: "Full name", target: ref, text: "Example private name" });
				expect(typed.isError).not.toBe(true);
				expect(await page.locator("#name").inputValue()).toBe("Example private name");
				mcp.provideSecrets({ FIXTURE_PASSWORD: "native-password-123" });
				const secretSnapshot = mcp.textOf(await mcp.callTool("browser_snapshot"));
				const secretRef = secretSnapshot.match(/textbox "Passcode"[^\n]*\[ref=(\w+)\]/)?.[1];
				expect(secretRef).toBeTruthy();
				const secretResult = await mcp.callTool("browser_type", { element: "Passcode", target: secretRef, text: "FIXTURE_PASSWORD" }, { expectedOrigin: new URL(url).origin });
				expect(secretResult.isError).not.toBe(true);
				expect(await page.locator("#secret").inputValue()).toBe("native-password-123");
				expect(mcp.textOf(secretResult)).not.toContain("native-password-123");
				const maskedAfter = await maskedPageScreenshot(page, { quality: 50, timeout: 10_000 });
				expect(maskedAfter).toBeTruthy();
				const field = await page.locator("#name").boundingBox();
				if (!field) throw new Error("Fixture field missing");
				// Decode the captured JPEG, not the live page. Every sampled pixel inside the input
				// must be the opaque dark mask, even though the native field still contains its value.
				const pixels = await page.evaluate(async ({ image, box }) => {
					const img = new Image(); img.src = `data:image/jpeg;base64,${image}`; await img.decode();
					const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
					const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
					const samples: number[] = [];
					for (const x of [0.2, 0.4, 0.6, 0.8]) for (const y of [0.3, 0.5, 0.7]) samples.push(...ctx.getImageData(Math.floor(box.x + box.width * x), Math.floor(box.y + box.height * y), 1, 1).data.slice(0, 3));
					return samples;
				}, { image: maskedAfter, box: field });
				expect(pixels.every((value) => value < 30)).toBe(true);
				let streamedFrames = 0;
				const startStream = page.screencast.start.bind(page.screencast);
				vi.spyOn(page.screencast, "start").mockImplementation((options = {}) => startStream({ ...options, onFrame: async (frame) => { streamedFrames++; await options.onFrame?.(frame); } }));
				takeover = { page };
				const frame = await nativeTakeoverFrame(takeover);
				await expect.poll(() => streamedFrames, { timeout: 10_000 }).toBeGreaterThan(0);
				expect(frame).toMatchObject({ width: 800, height: 600, url });
				expect(frame.frame).toMatch(/^data:image\/jpeg;base64,/);
				const button = await page.locator("#count").boundingBox();
				if (!button) throw new Error("Fixture button missing");
				await nativeTakeoverInput(takeover, { type: "click", x: button.x + button.width / 2, y: button.y + button.height / 2 });
				expect(await page.locator("#result").textContent()).toBe("clicked");
				await nativeTakeoverInput(takeover, { type: "click", x: field.x + field.width / 2, y: field.y + field.height / 2 });
				await nativeTakeoverInput(takeover, { type: "key", key: "ControlOrMeta+A" });
				await nativeTakeoverInput(takeover, { type: "text", text: "Owner entry" });
				await nativeTakeoverInput(takeover, { type: "key", key: "Enter" });
				expect(await page.locator("#name").inputValue()).toBe("Owner entry");
				expect(await page.locator("#result").textContent()).toBe("entered");
				await stopNativeTakeover(takeover);
				await mcp.stop();
				// Native MCP teardown owns its transport, not the caller's browser.
				expect(await page.title()).toBe("Native browser fixture");
			} finally {
				if (takeover) await stopNativeTakeover(takeover);
				await mcp.stop();
				await context?.close();
				rmSync(profileDir, { recursive: true, force: true });
			}
		});
	}
});
