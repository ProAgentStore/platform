import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1589 — Settings sub-tabs. Routes are stubbed; this asserts the URL state, that drafts survive switching
 * (a sub-tab mounts once and stays mounted, hidden), that `SettingsTab` loads once, and that the load-failed
 * banner is visible on every sub-tab.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Job Assistant", status: "active", slug: "job-assistant", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["apply"], runtime: "browser", workflow: "apply" } };
const SUBTABS = ["agent", "browser", "automation", "notifications", "instructions", "general"];
/** The requests SettingsTab.loadAll makes that nothing else on the page makes (the shell also reads voice-settings, so it is not counted). */
const LOAD_ALL = [
	"/v1/instances/inst-1/settings",
	"/v1/instances/inst-1/translation",
	"/v1/drive/instances/inst-1/grants",
	"/v1/workdrive/instances/inst-1/grants",
];

async function mock(page: Page, opts: { fail?: string } = {}) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	const counts = new Map<string, number>();
	await page.route(`${API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		counts.set(path, (counts.get(path) ?? 0) + 1);
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === opts.fail) return json({ error: "boom" }, 500);
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/operator-manual") return json({ manual: "", account: "", inherited: "", sections: { account: null, inherited: null, instance: null }, combined: "", rules: "", context: "" });
		if (path === "/v1/triggers") return json({ triggers: [] });
		if (path === "/v1/triggers/actions") return json({ actions: [] });
		if (path === "/v1/triggers/preview") return json({ schedule: null, timezone: null, jitterMinutes: null, runs: [], issues: [], error: null });
		return json({});
	});
	return counts;
}

test("?subtab= survives a reload, and the selected button says so", async ({ page }) => {
	await mock(page);
	await page.goto("/console/instances/inst-1/settings?subtab=browser");
	await expect(page.getByTestId("settings-subtab-browser")).toHaveAttribute("aria-current", "true");
	await page.reload();
	await expect(page.getByTestId("settings-subtab-browser")).toHaveAttribute("aria-current", "true");
	expect(new URL(page.url()).searchParams.get("subtab")).toBe("browser");
});

test("no subtab opens Agent, and the Danger zone is not there", async ({ page }) => {
	await mock(page);
	await page.goto("/console/instances/inst-1/settings");
	await expect(page.getByTestId("settings-subtab-agent")).toHaveAttribute("aria-current", "true");
	await expect(page.getByText("Danger zone")).toHaveCount(0);
});

test("drafts survive switching sub-tabs and nothing is loaded twice", async ({ page }) => {
	const counts = await mock(page);
	await page.goto("/console/instances/inst-1/settings?subtab=general");
	await expect(page.getByRole("textbox", { name: "Instance name" })).toHaveValue("Job Assistant"); // loaded, so the fill is not overwritten
	await page.getByRole("textbox", { name: "Instance name" }).fill("My renamed agent");

	await page.getByTestId("settings-subtab-instructions").click();
	await page.getByRole("textbox", { name: "This instance's operator manual" }).fill("Stash lives at ~/dev/stash.");

	await page.getByTestId("settings-subtab-automation").click();
	await page.getByLabel("Event that triggers this connection").fill("lead.created");

	await page.getByTestId("settings-subtab-general").click();
	await expect(page.getByRole("textbox", { name: "Instance name" })).toHaveValue("My renamed agent");
	await page.getByTestId("settings-subtab-instructions").click();
	await expect(page.getByRole("textbox", { name: "This instance's operator manual" })).toHaveValue("Stash lives at ~/dev/stash.");
	await page.getByTestId("settings-subtab-automation").click();
	await expect(page.getByLabel("Event that triggers this connection")).toHaveValue("lead.created");

	// A hidden sub-tab leaves the accessibility tree and the tab order.
	await expect(page.getByRole("textbox", { name: "Instance name" })).toHaveCount(0);
	for (const path of LOAD_ALL) expect(counts.get(path), path).toBe(1);
});

test.describe("the load-failed banner shows on every sub-tab", () => {
	for (const subtab of SUBTABS) {
		test(subtab, async ({ page }) => {
			await mock(page, { fail: "/v1/instances/inst-1/translation" });
			await page.goto(`/console/instances/inst-1/settings?subtab=${subtab}`);
			const banner = page.getByTestId("settings-load-failed");
			await expect(banner).toBeVisible();
			await expect(banner).toContainText("some settings may show defaults instead of yours");
		});
	}
});

test("an old /settings?focus=permissions link still lands on Permissions", async ({ page }) => {
	await mock(page);
	await page.goto("/console/instances/inst-1/settings?focus=permissions");
	await expect(page).toHaveURL(/\/instances\/inst-1\/permissions\?focus=permissions/);
});

test("a bare ?takeover= opens Browser", async ({ page }) => {
	await mock(page);
	await page.goto("/console/instances/inst-1/settings?takeover=t1");
	await expect(page.getByTestId("settings-subtab-browser")).toHaveAttribute("aria-current", "true");
});
