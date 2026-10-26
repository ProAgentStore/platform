import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1292 — the console's header navigation, exercised REAL at a phone viewport.
 *
 * Route tests that mock the shell as a plain <div> never see the hamburger, so a menu that does not open, does not close, or
 * lists fewer destinations than the desktop bar passes them all. This spec renders the real `Layout` (the app shell of the
 * PAGS console) at 375 x 812 and checks the behaviour a phone user depends on:
 *
 *   1. below 640px a labelled "Menu" button exists, and the desktop bar is not exposed;
 *   2. opening it reveals every primary destination the desktop bar has;
 *   3. Escape closes it and returns focus to the button;
 *   4. a click outside closes it;
 *   5. choosing an item navigates WITHOUT a reload, closes the menu, and marks exactly that item `aria-current="page"`;
 *   6. there is exactly one navigation landmark in the accessibility tree, and it is the menu.
 *
 * WHEN A MOCK IS ACCEPTABLE (and when it is not): mock the shell in tests of a page's own behaviour (its data, forms, empty and
 * error states) — the header is not what they are about, and rendering it costs a session and a router. The real shell is
 * REQUIRED for anything about navigation itself: the menu, its keyboard and outside-click behaviour, `aria-current`, the
 * landmark count, and the overflow of the header at phone width. This is the one spec that owns those; do not re-mock them.
 */
const API = "https://api.proagentstore.online";

async function signedIn(page: Page) {
	await page.addInitScript(() => window.localStorage.setItem("pags:session", "test-pags-token"));
	await page.route(`${API}/**`, (route) => {
		const path = new URL(route.request().url()).pathname;
		const body =
			path === "/v1/auth/me"
				? { id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user", "creator"], boardConfig: null }
				: path === "/v1/instances/my/instances"
					? { instances: [] }
					: {};
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
	});
}

/** The destinations the desktop bar offers, read from the real DOM at a desktop width — the single source the menu must match. */
async function desktopDestinations(page: Page): Promise<string[]> {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/console/agents");
	const links = page.getByRole("navigation", { name: "Primary" }).getByRole("link");
	await expect(links.first()).toBeVisible();
	return links.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? "").filter(Boolean));
}

test.describe("mobile app-shell navigation, against the real shell (#1292)", () => {
	test.beforeEach(async ({ page }) => {
		await signedIn(page);
	});

	test("a labelled Menu button is there below 640px, closed, and the desktop bar is not in the accessibility tree", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/console/agents");
		const button = page.getByRole("button", { name: "Menu", exact: true });
		await expect(button).toBeVisible();
		await expect(button).toHaveAttribute("aria-expanded", "false");
		// Nothing is exposed as navigation until it is opened: the desktop bar is display:none at this width.
		await expect(page.getByRole("navigation")).toHaveCount(0);
		// And nothing pans the page sideways.
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
	});

	test("opening it reveals every primary destination the desktop bar offers", async ({ page }) => {
		const expected = await desktopDestinations(page);
		expect(expected.length, "the desktop bar listed nothing — this test would prove nothing").toBeGreaterThan(5);

		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/console/agents");
		const button = page.getByRole("button", { name: "Menu", exact: true });
		await button.click();
		await expect(button).toHaveAttribute("aria-expanded", "true");
		const menu = page.getByRole("navigation", { name: "Menu" });
		await expect(menu).toBeVisible();
		const offered = await menu.getByRole("link").evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));
		expect(offered).toEqual(expected);
		// Each one is a real link to its destination, so a middle-click or a copied link works.
		for (const href of await menu.getByRole("link").evaluateAll((els) => els.map((el) => el.getAttribute("href")))) expect(href).toMatch(/^\/console\/[a-z]+/);
	});

	test("Escape closes the menu and returns focus to the button", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/console/agents");
		const button = page.getByRole("button", { name: "Menu", exact: true });
		await button.click();
		await expect(page.getByRole("navigation", { name: "Menu" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("navigation")).toHaveCount(0);
		await expect(button).toHaveAttribute("aria-expanded", "false");
		await expect(button).toBeFocused();
	});

	test("a click outside the menu closes it", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/console/agents");
		await page.getByRole("button", { name: "Menu", exact: true }).click();
		await expect(page.getByRole("navigation", { name: "Menu" })).toBeVisible();
		// Well inside <main>, away from the menu panel (which hangs from the top right).
		await page.mouse.click(30, 600);
		await expect(page.getByRole("navigation")).toHaveCount(0);
	});

	test("choosing an item navigates without a reload, closes the menu, and marks exactly that item aria-current", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/console/agents");
		// A value that survives only while the document does: a full reload would lose it.
		await page.evaluate(() => {
			(window as unknown as { __noReload: number }).__noReload = 1;
		});
		const button = page.getByRole("button", { name: "Menu", exact: true });
		await button.click();
		await page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: "Instances" }).click();

		await expect(page).toHaveURL(/\/console\/instances$/);
		expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(1);
		await expect(page.getByRole("navigation")).toHaveCount(0);

		await button.click();
		const menu = page.getByRole("navigation", { name: "Menu" });
		await expect(menu.getByRole("link", { name: "Instances" })).toHaveAttribute("aria-current", "page");
		await expect(menu.locator('[aria-current="page"]')).toHaveCount(1);
	});

	test("exactly one navigation landmark is exposed at phone width — the menu — whether or not it is open", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/console/agents");
		await expect(page.getByRole("navigation")).toHaveCount(0);
		await page.getByRole("button", { name: "Menu", exact: true }).click();
		const landmarks = page.getByRole("navigation");
		await expect(landmarks).toHaveCount(1);
		await expect(landmarks).toHaveAccessibleName("Menu");
	});
});
