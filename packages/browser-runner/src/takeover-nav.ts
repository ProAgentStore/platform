/**
 * The live takeover view's browser controls (#1105): back, forward, reload and the address bar.
 *
 * On a phone the owner needed the remote page to behave like a browser — SEEK's apply flow detours
 * through login.seek.com and back, and without back or reload one wrong turn stranded the session.
 * These move the PAGE the person is taking over; they never reach the machine.
 */
import type { Page } from "playwright";
import { RunnerInputError } from "./errors.js";
import type { TakeoverInput } from "./types.js";

/** A slow page still lands where it was sent and the frame poll shows it, so a timeout is not a failure. */
const NAV = { waitUntil: "commit" as const, timeout: 15_000 };

/** Run a navigation control. True when `input` was one (and was handled); false for every other input. */
export async function takeoverNavigation(page: Pick<Page, "goBack" | "goForward" | "reload" | "goto">, input: TakeoverInput): Promise<boolean> {
	if (input.type === "back") await page.goBack(NAV).catch(() => undefined);
	else if (input.type === "forward") await page.goForward(NAV).catch(() => undefined);
	else if (input.type === "reload") await page.reload(NAV).catch(() => undefined);
	else if (input.type === "navigate") {
		const url = takeoverUrl(input.url);
		if (!url) throw new RunnerInputError("navigate takes an http(s) address");
		await page.goto(url, NAV).catch(() => undefined);
	} else return false;
	return true;
}

/**
 * What the address bar may open: an http(s) address, as an address bar takes it — a bare host gets
 * `https://`. Anything else (`file:`, `javascript:`, `chrome:`) is refused.
 */
export function takeoverUrl(raw: unknown): string | null {
	const text = typeof raw === "string" ? raw.trim() : "";
	if (!text || /\s/.test(text)) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
	try {
		const u = new URL(withScheme);
		return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
	} catch {
		return null;
	}
}
