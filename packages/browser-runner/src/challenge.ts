import type { Page } from "playwright";

/**
 * Detect an anti-bot human challenge on the page (reCAPTCHA, hCaptcha,
 * Cloudflare Turnstile, generic captcha). These can't be solved by the model,
 * so they trigger a handoff to a human rather than wasted retries.
 */
export async function detectHumanChallenge(page: Page): Promise<string | null> {
	// hCaptcha + Turnstile mount as explicit widgets — their presence means a
	// human challenge (these aren't sprinkled invisibly across the web).
	for (const [type, selector] of [
		["hcaptcha", 'iframe[src*="hcaptcha.com"], .h-captcha'],
		["cloudflare-turnstile", 'iframe[src*="challenges.cloudflare.com"], .cf-turnstile'],
		["arkose-funcaptcha", 'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], #arkose, #FunCaptcha, [data-callback*="arkose"]'],
		["geetest", '.geetest_holder, .geetest_panel, [class*="geetest_"]'],
	] as Array<[string, string]>) {
		if ((await page.locator(selector).count().catch(() => 0)) > 0) return type;
	}
	// reCAPTCHA is the trap: the invisible v3 "protected by reCAPTCHA" badge is on
	// countless pages and needs NO human. Only hand off for a VISIBLE, interactive
	// widget — the "I'm not a robot" checkbox (anchor) or the image-challenge popup
	// (bframe) — never the badge or the size=invisible variant.
	const recaptcha = await page
		.evaluate(() => {
			const visible = (el: Element) => {
				const r = el.getBoundingClientRect();
				const s = getComputedStyle(el);
				return r.width > 100 && r.height > 50 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
			};
			for (const f of Array.from(document.querySelectorAll("iframe"))) {
				const src = f.getAttribute("src") || "";
				if (!/recaptcha/.test(src)) continue;
				if (f.closest(".grecaptcha-badge")) continue; // invisible v3 badge
				if (/size=invisible/.test(src)) continue; // invisible variant
				if (/bframe/.test(src) && visible(f)) return true; // image-challenge popup
				if (/anchor/.test(src) && visible(f)) return true; // checkbox
			}
			const div = document.querySelector('.g-recaptcha:not([data-size="invisible"])');
			return !!(div && visible(div));
		})
		.catch(() => false);
	if (recaptcha) return "recaptcha";
	// Unknown-vendor captchas (e.g. PageUp/Bendigo): an explicit "confirm you are
	// not a robot" prompt is a near-certain human challenge. Match the specific
	// phrasing (not just the word "robot") to avoid flagging article text.
	const robotPrompt = await page
		.evaluate(() => {
			const t = (document.body?.innerText || "").toLowerCase();
			return /confirm (that )?you('?re| are) not a robot|i'?m not a robot|verify (that )?you('?re| are) (a )?human|prove you('?re| are) (not a robot|human)/.test(t);
		})
		.catch(() => false);
	return robotPrompt ? "captcha" : null;
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
