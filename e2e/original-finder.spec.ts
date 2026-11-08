import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installHistoryRoutes, LOCAL_BROWSER_INSTANCE, seededHistory } from "./activity-history-mock";
import { FINDER_INSTANCE, type FinderMockOptions, installFinderRoutes, PLAIN_LOCAL_BROWSER_INSTANCE } from "./original-finder-mock";

/**
 * #1616 — the Original Finder: its budget and scope in Settings → Agent, and its queue in Activity → History.
 * Routes are stubbed; the gate is the server's `originalFinder` verdict, never a slug. The status-line states and
 * the panel ordering are vitest's (`lib/originalFinder.test.ts`).
 */
const API = "https://api.proagentstore.online";
const SETTINGS = "/console/instances/inst-1/settings?subtab=agent";
const HISTORY = "/console/instances/inst-1/activity?view=history";

async function setup(page: Page, instance: Record<string, unknown>, finder: FinderMockOptions = {}) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	await page.route(`${API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [instance] });
		if (path === "/v1/triggers") return json({ triggers: [] });
		if (path === "/v1/triggers/actions") return json({ actions: [] });
		if (path === "/v1/triggers/preview") return json({ schedule: null, timezone: null, jitterMinutes: null, runs: [], issues: [], error: null });
		return json({ error: "Not mocked" }, 404);
	});
	await installHistoryRoutes(page, { ...seededHistory(), takeovers: [], deliveries: [], secureInputs: [], runs: [], queue: [], session: null });
	return installFinderRoutes(page, finder);
}

test.describe("who gets the Finder section and panel", () => {
	test("a Finder shows the section and the panel", async ({ page }) => {
		await setup(page, FINDER_INSTANCE);
		await page.goto(SETTINGS);
		await expect(page.getByTestId("settings-original-finder")).toBeVisible();
		await page.goto(HISTORY);
		await expect(page.getByTestId("history-finder")).toBeVisible();
		await expect(page.getByTestId("finder-row")).toHaveCount(4);
	});

	for (const [name, instance] of [["a Gmail Scout", LOCAL_BROWSER_INSTANCE], ["a plain local_browser agent", PLAIN_LOCAL_BROWSER_INSTANCE]] as const) {
		test(`${name} shows neither and never asks for the Finder`, async ({ page }) => {
			const { requests } = await setup(page, instance);
			await page.goto(SETTINGS);
			await expect(page.getByTestId("settings-brain-section")).toBeVisible();
			await page.goto(HISTORY);
			await expect(page.getByTestId("activity-history")).toBeAttached();
			await page.waitForTimeout(1000);
			await expect(page.getByTestId("settings-original-finder")).toHaveCount(0);
			await expect(page.getByTestId("history-finder")).toHaveCount(0);
			expect(requests).toEqual([]);
		});
	}
});

test.describe("Settings → Agent → Original Finder", () => {
	test("the status line says what is left and links to the panel", async ({ page }) => {
		await setup(page, FINDER_INSTANCE);
		await page.goto(SETTINGS);
		const line = page.getByTestId("finder-line");
		await expect(line).toContainText("6 of 10 research runs left today · 1 waiting");
		await line.getByRole("link", { name: "View in Activity" }).click();
		await expect(page).toHaveURL(/activity\?view=history&panel=finder/);
		await expect(page.getByTestId("history-finder")).toBeVisible();
	});

	test("a failed read says Couldn't check, with the link", async ({ page }) => {
		await setup(page, FINDER_INSTANCE, { failOverview: true });
		await page.goto(SETTINGS);
		await expect(page.getByTestId("finder-line")).toContainText("Couldn't check");
		await expect(page.getByTestId("finder-line").getByRole("link", { name: "View in Activity" })).toBeVisible();
	});

	test("empty roles shows the scope in force; typing a role hides it", async ({ page }) => {
		await setup(page, FINDER_INSTANCE);
		await page.goto(SETTINGS);
		const scope = page.getByTestId("finder-scope");
		await expect(scope).toContainText("Follows your Application Runner's auto-submit roles");
		await expect(scope).toContainText("platform engineer, site reliability");
		await page.getByLabel("Roles").fill("designer");
		await expect(scope).toHaveCount(0);
	});

	test("saving the budget sends only { dailyCap }", async ({ page }) => {
		const { puts } = await setup(page, FINDER_INSTANCE);
		await page.goto(SETTINGS);
		await page.getByLabel("Daily research budget").fill("20");
		await page.getByTestId("settings-original-finder").getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Saved.")).toBeVisible();
		expect(puts).toEqual([{ dailyCap: 20 }]);
		await expect(page.getByTestId("finder-line")).toContainText("16 of 20 research runs left today");
	});

	test("a 400 shows the server's text as it is", async ({ page }) => {
		const { puts } = await setup(page, FINDER_INSTANCE, { refusePut: "dailyCap must be a whole number from 0 to 50" });
		await page.goto(SETTINGS);
		await page.getByLabel("Daily research budget").fill("99");
		await page.getByTestId("settings-original-finder").getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("dailyCap must be a whole number from 0 to 50")).toBeVisible();
		expect(puts).toEqual([{ dailyCap: 99 }]);
	});
});

test.describe("Activity → History → Original Finder", () => {
	test("failed rows come first; the url is a link", async ({ page }) => {
		await setup(page, FINDER_INSTANCE);
		await page.goto(HISTORY);
		const rows = page.getByTestId("finder-row");
		await expect(rows.first()).toContainText("failed");
		await expect(rows.first()).toContainText("blocked the research run");
		await expect(page.getByTestId("finder-counts")).toContainText("1 failed · 1 queued");
		await expect(page.getByRole("link", { name: /careers\.acme\.example/ })).toHaveAttribute("href", /^https:\/\/careers\.acme\.example\//);
	});

	test("no leads renders nothing; a failed read shows a compact retry", async ({ page }) => {
		await setup(page, FINDER_INSTANCE, { leads: [], counts: {} });
		await page.goto(HISTORY);
		await expect(page.getByTestId("activity-history")).toBeAttached();
		await page.waitForTimeout(1000);
		await expect(page.getByTestId("history-finder")).toHaveCount(0);
		await page.unroute(`${API}/**`);
		await setup(page, FINDER_INSTANCE, { failOverview: true });
		await page.goto(HISTORY);
		await expect(page.getByTestId("history-failed-finder")).toBeVisible();
	});
});
