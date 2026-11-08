import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { FLEET_NODES, FLEET_PIN, installFleetRoutes } from "./runner-fleet-mock";

/**
 * #1594 — the Runner card is this instance's, not the account's fleet. Routes are stubbed; the pure selection
 * is unit-tested in lib/runnerPanel.test.ts, so this asserts the screen: one machine in detail, the count, and
 * the "Change machine" disclosure (pin request, keyboard, focus), plus the Check machines rows.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Job Assistant", status: "active", slug: "job-assistant", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["apply"], runtime: "local_browser", workflow: "apply" } };

async function mock(page: Page, runtime: "pinned" | "any_eligible" = "pinned") {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	await page.route(`${API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/browser-verification") return json({ settings: { enabled: true, runtime, fallback: "wait", waitLimitMinutes: 60, takeover: "prompt", allowMobile: false }, capability: { declared: true, engine: "chrome" }, runnerNode: FLEET_PIN, notificationEvents: [] });
		if (path === "/v1/instances/inst-1/browser-verification/runtimes")
			return json({ runtime, runnerNode: FLEET_PIN, selected: FLEET_PIN, machines: FLEET_NODES.map((node) => ({ node, pinned: node === FLEET_PIN, heartbeat: { lastSeenAt: null, fresh: true }, attached: true, health: { state: "ok" }, runnerVersion: null, eligible: true })) });
		if (path === "/v1/instances/inst-1/operator-manual") return json({ manual: "", account: "", inherited: "", sections: { account: null, inherited: null, instance: null }, combined: "", rules: "", context: "" });
		if (path === "/v1/triggers") return json({ triggers: [] });
		if (path === "/v1/triggers/actions") return json({ actions: [] });
		if (path === "/v1/triggers/preview") return json({ schedule: null, timezone: null, jitterMinutes: null, runs: [], issues: [], error: null });
		return json({});
	});
}

test("Runner card: the pinned machine in detail, 4 others as a count, no other machine's warnings", async ({ page }) => {
	await mock(page);
	await installFleetRoutes(page);
	await page.goto("/console/instances/inst-1/settings?subtab=automation");
	const pinned = page.getByTestId("runner-pinned-machine");
	await expect(pinned).toContainText(FLEET_PIN);
	await expect(pinned).toContainText(`Crash loop on ${FLEET_PIN}`);
	await expect(pinned).toContainText("CLI out of date");
	await expect(page.getByTestId("runner-machine-link")).toHaveAttribute("href", "/console/terminals/machines/machine-0");
	await expect(page.getByTestId("runner-other-machines")).toHaveText("4 other machines · Manage machines");
	await expect(page.getByTestId("runner-other-machines").getByRole("link")).toHaveAttribute("href", "/console/terminals");
	await expect(page.getByText("Crash loop on Air.local")).toHaveCount(0);
	await expect(page.getByText("CLI out of date")).toHaveCount(1);
});

test("Change machine: keyboard-operable, focus enters the list, pins with the same request", async ({ page }) => {
	await mock(page);
	const pins: unknown[] = [];
	await installFleetRoutes(page, { onPin: (b) => pins.push(b) });
	await page.goto("/console/instances/inst-1/settings?subtab=automation");
	const toggle = page.getByTestId("runner-change-machine");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.focus();
	await page.keyboard.press("Enter");
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	const choices = page.getByTestId("runner-machine-choice");
	await expect(choices).toHaveCount(5);
	await expect(choices.first()).toBeFocused();
	await expect(page.getByTestId("runner-machine-choices")).not.toContainText("Crash loop");
	await page.keyboard.press("Tab");
	await page.keyboard.press("Enter");
	await expect.poll(() => pins).toEqual([{ runnerNode: FLEET_NODES[1] }]);
	await expect(page.getByTestId("runner-move-outcome")).toContainText(FLEET_NODES[1]);
	await expect(page.getByTestId("runner-pinned-machine")).toContainText(FLEET_NODES[1]);
});

test("no pin: the prompt and the compact list are shown directly", async ({ page }) => {
	await mock(page);
	await installFleetRoutes(page, { pin: null });
	await page.goto("/console/instances/inst-1/settings?subtab=automation");
	await expect(page.getByTestId("runner-machine-choice")).toHaveCount(5);
	await expect(page.getByText("Pick a machine above to run this agent on.")).toBeVisible();
	await expect(page.getByTestId("runner-change-machine")).toHaveCount(0);
});

test("Check machines: one row for runtime=pinned, every machine for any_eligible", async ({ page }) => {
	await mock(page, "pinned");
	await installFleetRoutes(page);
	await page.goto("/console/instances/inst-1/settings?subtab=browser");
	await page.getByTestId("bv-check").click();
	await expect(page.getByTestId("bv-machines").locator("li")).toHaveCount(2); // the pinned row + "Would run on"
	await expect(page.getByTestId("bv-machines")).toContainText(FLEET_PIN);
	await expect(page.getByTestId("bv-machines")).not.toContainText("Air.local");

	const any = await page.context().newPage();
	await mock(any, "any_eligible");
	await installFleetRoutes(any);
	await any.goto("/console/instances/inst-1/settings?subtab=browser");
	await any.getByTestId("bv-check").click();
	await expect(any.getByTestId("bv-machines").locator("li")).toHaveCount(6);
});

for (const width of [320, 390]) {
	test(`Change machine fits at ${width}px, with every choice at least 24px tall`, async ({ page }) => {
		await page.setViewportSize({ width, height: 812 });
		await mock(page);
		await installFleetRoutes(page);
		await page.goto("/console/instances/inst-1/settings?subtab=automation");
		await page.getByTestId("runner-change-machine").click();
		await expect(page.getByTestId("runner-machine-choice")).toHaveCount(5);
		const m = await page.evaluate(() => {
			const els = [...document.querySelectorAll('[data-testid="runner-machine-choice"]')];
			return {
				over: document.documentElement.scrollWidth - window.innerWidth,
				heights: els.map((e) => e.getBoundingClientRect().height),
				right: Math.max(...els.map((e) => e.getBoundingClientRect().right)),
			};
		});
		expect(m.over).toBeLessThanOrEqual(1);
		expect(m.right).toBeLessThanOrEqual(width);
		expect(Math.min(...m.heights)).toBeGreaterThanOrEqual(24);
	});
}
