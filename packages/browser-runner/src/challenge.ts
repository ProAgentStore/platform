import type { Page } from "playwright";

/**
 * Detect an anti-bot human challenge on the page (reCAPTCHA, hCaptcha,
 * Cloudflare Turnstile, generic captcha). These can't be solved by the model,
 * so they trigger a handoff to a human rather than wasted retries.
 */
export async function detectHumanChallenge(page: Page): Promise<string | null> {
	// Specific widget classes first so the label is accurate (hCaptcha ships a
	// reCAPTCHA-compat shim, so a generic reCAPTCHA check would mislabel it).
	const checks: Array<[string, string]> = [
		["hcaptcha", 'iframe[src*="hcaptcha"], .h-captcha'],
		["cloudflare-turnstile", 'iframe[src*="challenges.cloudflare.com"], .cf-turnstile'],
		["recaptcha", 'iframe[src*="recaptcha"], .g-recaptcha'],
		["captcha", 'iframe[title*="captcha" i], [class*="captcha" i], [id*="captcha" i]'],
	];
	for (const [type, selector] of checks) {
		if ((await page.locator(selector).count().catch(() => 0)) > 0) return type;
	}
	return null;
}

/**
 * Whether a detected challenge has actually been solved — i.e. the widget has
 * produced a response token. A solved captcha keeps its widget in the DOM, so
 * presence alone isn't "still blocked"; the token is the real signal.
 */
export async function challengeSolved(page: Page): Promise<boolean> {
	return page
		.evaluate(() => {
			const names = ["h-captcha-response", "g-recaptcha-response", "cf-turnstile-response"];
			for (const n of names) {
				const el = document.querySelector(`textarea[name="${n}"], input[name="${n}"]`) as
					| HTMLInputElement
					| HTMLTextAreaElement
					| null;
				if (el && typeof el.value === "string" && el.value.length > 0) return true;
			}
			return false;
		})
		.catch(() => false);
}

/** Capture a downscaled JPEG screenshot as a data URL for the human-takeover UI. */
export async function captureScreenshotDataUrl(page: Page): Promise<string | undefined> {
	try {
		const buf = await page.screenshot({ type: "jpeg", quality: 55 });
		return `data:image/jpeg;base64,${buf.toString("base64")}`;
	} catch {
		return undefined;
	}
}
