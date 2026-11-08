import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { LOCAL_BROWSER_INSTANCE } from "./activity-history-mock";
import { installScansRoutes, type ScansMockOptions, seededScans } from "./gmail-scout-mock";

/**
 * #1591 — a Gmail Scout's scans live on a capability-gated Scans tab; Settings → Agent keeps the source config and one line.
 * Routes are stubbed. The states' wording is asserted by the static render (`ScansView.test.ts`); this holds what only a
 * browser shows: the tab's gating, Scan now, Verify now / Verify again, and the load path.
 */
const API = "https://api.proagentstore.online";
const OTHER = { id: "inst-1", agent_id: "agent-1", name: "Job Application Runner", status: "active", slug: "job-application-runner", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["chat", "settings"], runtime: "local_apply" } };

/** The instance tab bar: the one row of buttons that holds Assistant. */
const tabBar = (page: Page) => page.locator("div.overflow-x-auto").filter({ has: page.getByRole("button", { name: "Assistant", exact: true }) });

async function open(page: Page, path: string, opts: ScansMockOptions = seededScans(), instance: Record<string, unknown> = LOCAL_BROWSER_INSTANCE) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	await page.route(`${API}/**`, async (route) => {
		const url = new URL(route.request().url());
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (url.pathname === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (url.pathname === "/v1/instances/my/instances") return json({ instances: [instance] });
		if (url.pathname === "/v1/triggers") return json({ triggers: [] });
		if (url.pathname === "/v1/triggers/actions") return json({ actions: [] });
		if (url.pathname === "/v1/triggers/preview") return json({ schedule: null, timezone: null, jitterMinutes: null, runs: [], issues: [], error: null });
		return json({});
	});
	const mock = await installScansRoutes(page, opts);
	await page.goto(`/console/instances/inst-1/${path}`);
	return mock;
}

test("a Gmail Scout shows Scans between Data and Settings", async ({ page }) => {
	await open(page, "scans");
	await expect(page.getByRole("heading", { name: "Gmail scans" })).toBeVisible();
	const names = (await tabBar(page).locator("button").allTextContents()).map((t) => t.replace(/[^\p{L}]/gu, ""));
	expect(names.indexOf("Scans")).toBeGreaterThan(-1);
	expect(names[names.indexOf("Scans") - 1]).toBe("Data");
	expect(names[names.indexOf("Scans") + 1]).toBe("Settings");
});

test("the Application Runner has no Scans tab, and its /scans lands on the Assistant", async ({ page }) => {
	await open(page, "scans", seededScans(), OTHER);
	await expect(page.getByRole("heading", { name: "Gmail scans" })).toHaveCount(0);
	await expect(tabBar(page).getByRole("button", { name: "Scans", exact: true })).toHaveCount(0);
	await expect(tabBar(page).getByRole("button", { name: "Assistant", exact: true })).toHaveClass(/text-accent/);
});

test("Scan now runs a scan, says what it added and shows the new receipt with its Jobs push", async ({ page }) => {
	const { requests } = await open(page, "scans");
	await expect(page.getByTestId("scans-jobs-warning")).toContainText("Leads are not reaching Jobs · Fix in Permissions");
	await expect(page.getByTestId("gmail-scout-receipts")).toContainText("not sent to Jobs: Jobs is not connected");
	await page.getByRole("button", { name: "Scan now" }).click();
	await expect(page.getByRole("status").filter({ hasText: "Scan complete: 1 lead(s) added" })).toBeVisible();
	await expect(page.getByTestId("gmail-scout-receipts")).toContainText("1 sent to Jobs");
	expect(requests.filter((r) => r === "POST /gmail-scout/scan")).toHaveLength(1);
});

test("Verify now and Verify again dispatch the lead through the verification route, then re-read the queue", async ({ page }) => {
	const { requests } = await open(page, "scans");
	const queue = page.getByTestId("gmail-scout-verifications");
	await expect(queue).toContainText("verified active — ready to triage");
	await expect(queue.getByRole("link", { name: "Triage in Data" })).toHaveAttribute("href", "/console/instances/inst-1/data?lead=lead-active");
	expect(requests.filter((r) => r.startsWith("GET /job-leads/browser-verifications"))).toHaveLength(1);
	await queue.getByRole("button", { name: "Verify now" }).click();
	await expect.poll(() => requests).toContain("POST /job-leads/lead-wait/browser-verification");
	await queue.getByRole("button", { name: "Verify again" }).click();
	await expect.poll(() => requests).toContain("POST /job-leads/lead-closed/browser-verification");
	await expect.poll(() => requests.filter((r) => r.startsWith("GET /job-leads/browser-verifications")).length).toBeGreaterThanOrEqual(3);
	expect(requests.some((r) => r.startsWith("GET /job-leads/browser-verifications?limit=20"))).toBe(true);
});

test("load path: loading, then a failure with Retry, then the scans", async ({ page }) => {
	await open(page, "scans", { ...seededScans(), statusFailures: 1 });
	const failed = page.getByTestId("scans-load-failed");
	await expect(failed).toContainText("Couldn't load the Gmail scans.");
	await expect(failed).toContainText("Gmail status unavailable");
	await failed.getByRole("button", { name: "Retry" }).click();
	await expect(page.getByTestId("gmail-scout-receipts")).toBeVisible();
	await expect(page.getByTestId("scans-load-failed")).toHaveCount(0);
});

test("empty: 'No scans yet' offers the one Scan now, and a scan fills the tab", async ({ page }) => {
	await open(page, "scans", { receipts: [], lastScanAt: null, verifications: [] });
	await expect(page.getByTestId("scans-empty")).toContainText("No scans yet");
	await page.getByTestId("scans-empty").getByRole("button", { name: "Scan now" }).click();
	await expect(page.getByTestId("gmail-scout-receipts")).toBeVisible();
});

test("source off: Turn on in Settings opens Settings → Agent, and there is no Scan now", async ({ page }) => {
	await open(page, "scans", { ...seededScans(), enabled: false });
	await expect(page.getByTestId("scans-source-off")).toContainText("Gmail source is off");
	await expect(page.getByRole("button", { name: "Scan now" })).toHaveCount(0);
	await page.getByRole("link", { name: "Turn on in Settings" }).click();
	await expect(page).toHaveURL(/\/settings\?subtab=agent$/);
	await expect(page.getByRole("button", { name: "Save Gmail source" })).toBeVisible();
});

test("Settings → Agent keeps the source config and one line that leads to the tab, hiding neither a failed scan nor Jobs", async ({ page }) => {
	await open(page, "settings?subtab=agent", { ...seededScans(), failureCount: 1, lastFailureAt: "2026-11-07T06:00:00.000Z" });
	await expect(page.getByRole("button", { name: "Save Gmail source" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Scan now" })).toHaveCount(0);
	await expect(page.getByTestId("gmail-scout-receipts")).toHaveCount(0);
	await expect(page.getByTestId("gmail-scout-summary")).toContainText("Last scan failed");
	await page.getByRole("link", { name: "View scans" }).click();
	await expect(page.getByRole("heading", { name: "Gmail scans" })).toBeVisible();
});
