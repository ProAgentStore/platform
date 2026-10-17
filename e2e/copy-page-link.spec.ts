import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1130 — an installed PWA has no address bar, so the shared header carries a "copy link to this
 * page" control. It is in `Layout`, so every page has it; this checks it on a deep link (a ticket)
 * and that it copies the FULL URL, query string included.
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
					: path.endsWith("/actions")
						? { entries: [], hasMore: false, nextCursor: null, tail: null, total: 0 }
						: path.endsWith("/browser-takeovers")
							? { takeovers: [] }
							: path.endsWith("/browser-artifacts")
								? { artifacts: [] }
								: path.endsWith("/task-events")
									? { events: [] }
									: path.endsWith("/thread")
										? { turns: [] }
										: path === "/v1/instances/inst-1/tasks/t1"
											? { id: "t1", type: "coding.session", status: "running", createdAt: "2026-10-17T00:00:00Z", description: "A ticket" }
											: {};
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
	});
}

test.describe("copy page link (#1130)", () => {
	test("copies the page's full URL and confirms it", async ({ page, context, browserName }) => {
		test.skip(browserName !== "chromium", "clipboard permissions are a Chromium-only grant in Playwright");
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await signedIn(page);
		await page.goto("/console/instances/inst-1/tasks/t1?from=board");
		await page.getByRole("button", { name: "Copy link to this page" }).click();
		await expect(page.getByRole("status").filter({ hasText: "Link copied" })).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
		expect(page.url()).toContain("/console/instances/inst-1/tasks/t1?from=board");
	});

	test("is in the header at phone width without pushing the bar sideways", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await signedIn(page);
		await page.goto("/console/agents");
		const btn = page.getByRole("button", { name: "Copy link to this page" });
		await expect(btn).toBeVisible();
		const box = await btn.boundingBox();
		expect(box && box.x + box.width <= 390).toBe(true);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	});
});
