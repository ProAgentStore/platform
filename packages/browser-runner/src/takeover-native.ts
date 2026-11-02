import type { Page } from "playwright";
import { RunnerInputError } from "./errors.js";
import { takeoverNavigation } from "./takeover-nav.js";
import type { TakeoverInput } from "./types.js";

/** Native Playwright control keeps the same page available in Chromium, Firefox and WebKit. */
export interface NativeTakeoverSession {
	page: Page;
	latestFrame?: string;
	width?: number;
	height?: number;
	screencasting?: boolean;
	startingScreencast?: Promise<void>;
}

async function ensureScreencast(session: NativeTakeoverSession): Promise<void> {
	if (session.screencasting) return;
	if (!session.startingScreencast) {
		session.startingScreencast = session.page.screencast.start({
			quality: 50,
			onFrame: async ({ data, viewportWidth, viewportHeight }) => {
				session.latestFrame = data.toString("base64");
				session.width = viewportWidth;
				session.height = viewportHeight;
			},
		}).then(() => { session.screencasting = true; }).finally(() => { session.startingScreencast = undefined; });
	}
	await session.startingScreencast;
}

/** Live owner view, separate from masked, stored replay shots. No CDP or viewport resizing. */
export async function nativeTakeoverFrame(session: NativeTakeoverSession): Promise<{ frame: string; width: number; height: number; url: string }> {
	await ensureScreencast(session);
	if (!session.latestFrame) {
		const frame = await session.page.screenshot({ type: "jpeg", quality: 55 });
		session.latestFrame = frame.toString("base64");
	}
	// Input coordinates and the console's scaling use CSS viewport pixels, also on Retina displays.
	const viewport = await session.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
	return { frame: `data:image/jpeg;base64,${session.latestFrame}`, width: viewport.width, height: viewport.height, url: session.page.url() };
}

export async function nativeTakeoverInput(session: NativeTakeoverSession, input: TakeoverInput): Promise<void> {
	const page = session.page;
	if (await takeoverNavigation(page, input)) return;
	const x = input.x ?? 0;
	const y = input.y ?? 0;
	switch (input.type) {
		case "move": await page.mouse.move(x, y); return;
		case "down": await page.mouse.move(x, y); await page.mouse.down({ button: "left" }); return;
		case "up": await page.mouse.move(x, y); await page.mouse.up({ button: "left" }); return;
		case "click": await page.mouse.click(x, y); return;
		case "scroll": await page.mouse.move(x, y); await page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0); return;
		case "text": await page.keyboard.insertText(input.text ?? ""); return;
		case "key": {
			const key = input.key === "Esc" ? "Escape" : input.key === "Spacebar" ? "Space" : input.key;
			if (!key) throw new RunnerInputError("A keyboard input needs a key.");
			await page.keyboard.press(key);
			return;
		}
	}
}

/** Stop just the live stream. The caller still owns the page and browser session. */
export async function stopNativeTakeover(session: NativeTakeoverSession): Promise<void> {
	await session.startingScreencast?.catch(() => undefined);
	if (session.screencasting) await session.page.screencast.stop().catch(() => undefined);
	session.screencasting = false;
	session.latestFrame = undefined;
}
