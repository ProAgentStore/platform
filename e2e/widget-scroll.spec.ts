import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1311 — the embeddable widget's open panel used to float over a scrolling host page with its own scrolling
 * transcript: two vertical scroll owners at once. Now the expanded view (the default on phones and short
 * screens, opt-in on desktop) fills the viewport and locks the host's scroll, so the transcript is the only
 * vertical scroller; the small docked panel on a desktop deliberately leaves the host interactive beside it.
 * The real widget.js is embedded in the platform's own long About page; the trial API is intercepted.
 *
 * Phone and landscape blocks start with `mobile — ` so the WebKit project runs them too (playwright.config.ts).
 */
const API = "https://api.proagentstore.online";
const REPLY = "A long synthetic widget reply that keeps going so the transcript outgrows the panel. ".repeat(10);

async function embed(page: Page, size: { width: number; height: number }) {
	await page.setViewportSize(size);
	await page.route(`${API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (d: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(d) });
		if (path === "/v1/public/agents/e2e-agent") return json({ name: "E2E Agent" });
		if (path === "/v1/public/agents/e2e-agent/try") return json({ sessionId: "s1", message: { content: REPLY } });
		return json({});
	});
	await page.goto("/about/");
	await page.evaluate(() => {
		const s = document.createElement("script");
		s.src = "/widget.js";
		s.setAttribute("data-agent", "e2e-agent");
		document.body.appendChild(s);
	});
	await page.locator("#pags-fab").waitFor();
}
async function converse(page: Page, turns = 6) {
	for (let i = 1; i <= turns; i++) {
		await page.locator("#pags-input").fill(`question ${i}`);
		await page.locator("#pags-bar button").click();
		await expect(page.locator("#pags-msgs .pags-msg.assistant")).toHaveCount(i);
	}
}
const scrollers = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLElement>("html, body, body *"))
			.filter((el) => {
				const oy = getComputedStyle(el).overflowY;
				return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
			})
			.map((el) => el.id || el.tagName.toLowerCase()),
	);
const hostLocked = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).overflow === "hidden" && getComputedStyle(document.body).overflow === "hidden");
const hostScrolls = (page: Page) => page.evaluate(() => (document.scrollingElement as HTMLElement).scrollHeight > window.innerHeight + 1);

/** The small docked panel on a desktop, then the expanded view. */
test.describe("widget on a desktop (#1311)", () => {
	test("closed it is only a launcher; open it docks beside an interactive host; expanded it is the single scroller", async ({ page }) => {
		await embed(page, { width: 1440, height: 900 });
		expect(await hostScrolls(page)).toBe(true);
		await expect(page.locator("#pags-panel")).toBeHidden();
		expect(await hostLocked(page)).toBe(false);

		await page.locator("#pags-fab").click();
		await converse(page);
		const docked = await page.locator("#pags-panel").boundingBox();
		expect(docked?.width).toBeLessThan(500); // the docked embed, not a takeover
		expect(await hostLocked(page)).toBe(false); // the host stays interactive beside it — the intentional desktop behaviour
		await page.mouse.move(300, 300);
		await page.mouse.wheel(0, 200);
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

		await page.locator("#pags-expand").click();
		const full = await page.locator("#pags-panel").boundingBox();
		expect(full).toMatchObject({ x: 0, y: 0, width: 1440, height: 900 });
		expect(await hostLocked(page)).toBe(true);
		expect(await scrollers(page)).toEqual(["pags-msgs"]); // the host cannot scroll; the transcript is the one owner
		await expect(page.locator("#pags-expand")).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator("#pags-close")).toBeVisible();
		await expect(page.locator("#pags-input")).toBeInViewport();

		await page.locator("#pags-expand").click(); // collapse back to the dock
		expect(await hostLocked(page)).toBe(false);
		expect((await page.locator("#pags-panel").boundingBox())?.width).toBeLessThan(500);
	});

	test("minimizing restores the host exactly as it was, and keeps the conversation", async ({ page }) => {
		await embed(page, { width: 1440, height: 900 });
		await page.evaluate(() => { document.body.style.overflow = "scroll"; }); // the host's own inline value
		await page.locator("#pags-fab").click();
		await page.locator("#pags-expand").click();
		await converse(page, 2);
		await page.locator("#pags-close").click();
		await expect(page.locator("#pags-panel")).toBeHidden();
		await expect(page.locator("#pags-fab")).toBeVisible();
		expect(await page.evaluate(() => [document.documentElement.style.overflow, document.body.style.overflow])).toEqual(["", "scroll"]);
		await page.locator("#pags-fab").click();
		await expect(page.locator("#pags-msgs .pags-msg")).toHaveCount(4); // 2 questions, 2 replies
	});
});

for (const [label, size] of [["phone 390x844", { width: 390, height: 844 }], ["landscape phone 844x390", { width: 844, height: 390 }]] as const) {
	test.describe(`mobile — widget has one vertical scroller (#1311) — ${label}`, () => {
		test("opening goes straight to the expanded view: host locked, transcript the only scroller", async ({ page }) => {
			await embed(page, size);
			expect(await hostScrolls(page)).toBe(true);
			await page.locator("#pags-fab").click();
			await converse(page);
			const box = await page.locator("#pags-panel").boundingBox();
			expect(box).toMatchObject({ x: 0, y: 0, width: size.width });
			expect(Math.abs((box?.height ?? 0) - size.height)).toBeLessThanOrEqual(1);
			expect(await hostLocked(page)).toBe(true);
			// Non-vacuity: the transcript really is longer than its box, and still the only thing that scrolls.
			const over = await page.evaluate(() => { const m = document.getElementById("pags-msgs") as HTMLElement; return m.scrollHeight - m.clientHeight; });
			expect(over).toBeGreaterThan(100);
			expect(await scrollers(page)).toEqual(["pags-msgs"]);
			await expect(page.locator("#pags-close")).toBeVisible();
			await expect(page.locator("#pags-input")).toBeInViewport();
			await expect(page.locator("#pags-expand")).toBeHidden(); // already full-screen: nothing to expand
		});

		test("a wheel moves the transcript and never the host behind it", async ({ page }) => {
			await embed(page, size);
			await page.locator("#pags-fab").click();
			await converse(page);
			await page.evaluate(() => { (document.getElementById("pags-msgs") as HTMLElement).scrollTop = 0; });
			const before = await page.evaluate(() => window.scrollY);
			await page.mouse.move(size.width / 2, size.height / 2);
			await page.mouse.wheel(0, 150);
			await page.waitForTimeout(200);
			const after = await page.evaluate(() => ({ y: window.scrollY, inner: (document.getElementById("pags-msgs") as HTMLElement).scrollTop }));
			expect(after.inner).toBeGreaterThan(0);
			expect(after.y).toBe(before);
		});

		test("closing hands scrolling back to the host and leaves a usable launcher", async ({ page }) => {
			await embed(page, size);
			await page.locator("#pags-fab").click();
			await expect(page.locator("#pags-fab")).toBeHidden(); // covered by the full-screen panel while open
			await page.locator("#pags-close").click();
			await expect(page.locator("#pags-fab")).toBeVisible();
			expect(await hostLocked(page)).toBe(false);
			await page.mouse.move(size.width / 2, size.height / 2);
			await page.mouse.wheel(0, 200);
			await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
		});
	});
}
