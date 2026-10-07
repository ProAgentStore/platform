/**
 * The page inspector the bridge runs inside every page it lands on (#947), against REAL DOM.
 *
 * `INSPECT_PAGE` is a string evaluated in the browser, so neither tsc nor the fake-browser bridge
 * tests can see a typo in it or a selector that never matches — they feed its RESULT in by hand.
 * This runs it in Chromium on fixtures shaped like the pages it must tell apart: the ones a run
 * stops for (captcha, sign-in, bot check, payment/upload/application form) and the ordinary
 * research pages it must NOT stop for (a job list with a search box, an article that merely
 * mentions "access denied").
 */
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSPECT_PAGE } from "./bridge.js";

let browser: Browser;
beforeAll(async () => {
	browser = await chromium.launch();
});
afterAll(async () => {
	await browser?.close();
});

async function inspect(html: string, title = "Page"): Promise<Record<string, unknown>> {
	const page = await browser.newPage();
	try {
		await page.setContent(`<!doctype html><title>${title}</title><body>${html}</body>`);
		return (await page.evaluate(`(${INSPECT_PAGE})()`)) as Record<string, unknown>;
	} finally {
		await page.close();
	}
}

const CLEAN = { captcha: false, login: false, paywall: false, accessBlocked: false, writeForm: false };

describe("pages research may read — no pause", () => {
	it("a job list with a search form", async () => {
		const r = await inspect(`
			<form role="search"><input type="search" name="q"><input name="where"><button>Search</button></form>
			<ul><li><a href="/job/1">Senior Engineer</a> — Melbourne</li><li><a href="/job/2">Engineering Manager</a></li></ul>`, "Jobs | SEEK");
		expect(r).toMatchObject(CLEAN);
	});

	it("a long article that only mentions access being denied", async () => {
		const r = await inspect(`<article><p>${"Engineers on the platform team own reliability. ".repeat(80)}</p><p>When access is denied to a service, the on-call engineer is paged.</p></article>`);
		expect(r.accessBlocked).toBe(false);
	});

	it("a job ad with an Apply link — a link to apply is not a form to fill", async () => {
		expect(await inspect(`<h1>Head of Engineering</h1><p>Lead the team.</p><a href="/apply">Apply now</a>`)).toMatchObject(CLEAN);
	});

	it("a newsletter box with one email field", async () => {
		expect((await inspect(`<p>${"News. ".repeat(50)}</p><form><input type="email" name="e"><button>Sign up</button></form>`)).writeForm).toBe(false);
	});
});

describe("pages a person must handle — the run pauses", () => {
	it("a captcha", async () => {
		expect((await inspect(`<div class="h-captcha"></div>`)).captcha).toBe(true);
	});

	it("a sign-in form", async () => {
		expect((await inspect(`<form><input name="u"><input type="password" name="p"><button>Sign in</button></form>`)).login).toBe(true);
	});

	it.each([
		["a bot-check interstitial", "Just a moment", `<p>Our systems have detected unusual traffic from your computer network.</p>`],
		["an Akamai-style access denial", "Access Denied", `<h1>Access Denied</h1><p>You don't have permission to access this server. Reference #18.a1b2</p>`],
		["a 403", "403 Forbidden", `<h1>403 Forbidden</h1>`],
		["a 'pardon our interruption' page", "Pardon Our Interruption", `<p>As you were browsing something about your browser made us think you were a bot.</p>`],
	])("%s is access-blocked", async (_what, title, html) => {
		expect((await inspect(html, title)).accessBlocked).toBe(true);
	});
});

describe("write affordances — the run stops before a page that pays, uploads or submits (#947)", () => {
	it("a job application form", async () => {
		const r = await inspect(`<form><input name="first"><input name="last"><input type="email" name="email"><textarea name="cover"></textarea><button type="submit">Submit application</button></form>`);
		expect(r.writeForm).toBe(true);
	});

	it("a résumé upload", async () => {
		expect((await inspect(`<input type="file" name="resume">`)).writeForm).toBe(true);
	});

	it("card payment fields", async () => {
		expect((await inspect(`<input autocomplete="cc-number"><input autocomplete="cc-exp">`)).writeForm).toBe(true);
	});

	it("an account registration form", async () => {
		expect((await inspect(`<form><input name="name"><input type="email" name="email"><button>Create account</button></form>`)).writeForm).toBe(true);
	});
});
