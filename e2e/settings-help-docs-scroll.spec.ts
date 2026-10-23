import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1304 — Settings help documents (the inherited operator manual and the connection guide) used to be capped boxes
 * (max-h-60 / max-h-[28rem]) with their own vertical scrollbars inside the tab that already scrolls. Geometry is measured in a
 * real browser with long synthetic documents; routes are stubbed and nothing is saved.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Repo Coder", status: "active", slug: "repo-coder", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } };
const INHERITED = Array.from({ length: 100 }, (_, n) => `Manual line ${n + 1}: checkouts are home-relative and delivery goes straight to main.`).join("\n");
const GUIDE = Array.from({ length: 100 }, (_, n) => `Guide line ${n + 1}: paste this into the assistant's system instructions. ${"x".repeat(n === 50 ? 300 : 0)}`).join("\n");

async function open(page: Page, size: { width: number; height: number }) {
	await page.setViewportSize(size);
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	await page.route(`${API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/operator-manual") return json({ manual: "", inherited: INHERITED, sections: { inherited: INHERITED, instance: null }, combined: "", rules: "", context: "" });
		if (path === "/v1/instances/inst-1/connection-guide") return json({ guide: GUIDE });
		if (path === "/v1/instances/inst-1/po-triage/reports") return json({ settings: null, triggers: [], reports: [] });
		if (path === "/v1/instances/inst-1/coder-questions") return json({ settings: null, questions: [] });
		if (path === "/v1/instances/inst-1/auto-pickup") return json({ settings: null, builtinExcludeLabels: [], activeWhenQueueEmpties: "auto_pickup", recent: [] });
		if (path === "/v1/instances/inst-1/coding/engine-choice") return json({ defaultEngineId: "claude", engines: [{ id: "claude", label: "Claude Code", command: "claude", clientType: "claude", model: null, modelSelectable: true, suggestions: [] }], lastObserved: null, appliesTo: "" });
		if (path === "/v1/triggers") return json({ triggers: [] });
		if (path === "/v1/triggers/actions") return json({ actions: [] });
		if (path === "/v1/triggers/preview") return json({ schedule: null, timezone: null, jitterMinutes: null, runs: [], issues: [], error: null });
		return json({});
	});
	await page.goto("/console/instances/inst-1/settings");
	await expect(page.getByTestId("operator-manual-inherited")).toBeVisible();
	await expect(page.getByText("Guide line 100:")).toBeAttached();
}

/** Scrollers that are not the tab/page container: any element with a vertical scrollbar that is a document box. */
const docScrollers = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLElement>("pre"))
			.filter((el) => {
				const oy = getComputedStyle(el).overflowY;
				return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
			})
			.map((el) => el.closest("[data-testid]")?.getAttribute("data-testid") ?? "pre"),
	);

for (const size of [
	{ name: "phone 390×844", width: 390, height: 844 },
	{ name: "desktop 1280×800", width: 1280, height: 800 },
]) {
	test(`mobile — ${size.name} — neither help document has a scrollbar of its own; each is shown whole`, async ({ page }) => {
		await open(page, size);
		expect(await docScrollers(page)).toEqual([]); // before: the manual (238px cap) and the guide (446px cap)
		const manual = page.getByTestId("operator-manual-inherited").locator("pre");
		const guide = page.locator("pre").filter({ hasText: "Guide line 1:" });
		const m = await manual.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
		const g = await guide.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
		expect(m.client).toBeGreaterThan(240);
		expect(g.client).toBeGreaterThan(450);
		expect(m.scroll).toBeLessThanOrEqual(m.client + 1);
		expect(g.scroll).toBeLessThanOrEqual(g.client + 1);
		await expect(manual).toContainText("Manual line 100:");
		await expect(guide).toContainText("Guide line 100:");
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
	});
}

test("the full guide text is copied, and Refresh and Copy still work", async ({ page, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await open(page, { width: 390, height: 844 });
	await expect(page.getByRole("button", { name: "Refresh" }).first()).toBeVisible();
	await page.getByRole("button", { name: "Copy", exact: true }).click();
	await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(GUIDE);
});
