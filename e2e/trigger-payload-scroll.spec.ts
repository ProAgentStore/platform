import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1305 — an expanded trigger event payload (Settings → Triggers → History → payload) used to sit in a max-h-56 box with its own
 * vertical scrollbar inside the tab that already scrolls. Geometry is measured in a real browser with a long multi-line JSON
 * payload; routes are stubbed and no trigger is run, changed or deleted.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Repo Coder", status: "active", slug: "repo-coder", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } };
const TRIGGER = { id: "trg-1", name: "Lead webhook", type: "webhook", action: "create_task", enabled: true, schedule: null, config: {}, webhookUrl: "https://api.proagentstore.online/v1/hooks/trg-1", failureCount: 0 };
// Pretty-printed this is dozens of short lines, well past the old 224px cap, and under truncatePayload's 600-character bound.
const PAYLOAD = JSON.stringify(Object.fromEntries(Array.from({ length: 24 }, (_, n) => [`field${n}`, n])));
const EVENT = { id: "evt-1", trigger_id: "trg-1", type: "webhook", status: "succeeded", message: "Task created", payload: PAYLOAD, error: null, created_at: "2026-10-23T00:00:00Z" };
const writes: string[] = [];

async function open(page: Page, size: { width: number; height: number }) {
	writes.length = 0;
	await page.setViewportSize(size);
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		if (req.method() !== "GET") writes.push(`${req.method()} ${path}`);
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/triggers") return json({ triggers: [TRIGGER] });
		if (path === "/v1/triggers/actions") return json({ actions: [] });
		if (path === "/v1/triggers/trg-1/events") return json({ events: [EVENT] });
		if (path === "/v1/triggers/preview") return json({ schedule: null, timezone: null, jitterMinutes: null, runs: [], issues: [], error: null });
		if (path === "/v1/instances/inst-1/operator-manual") return json({ manual: "", inherited: "", sections: { inherited: null, instance: null }, combined: "", rules: "", context: "" });
		if (path === "/v1/instances/inst-1/po-triage/reports") return json({ settings: null, triggers: [], reports: [] });
		if (path === "/v1/instances/inst-1/coder-questions") return json({ settings: null, questions: [] });
		if (path === "/v1/instances/inst-1/auto-pickup") return json({ settings: null, builtinExcludeLabels: [], activeWhenQueueEmpties: "auto_pickup", recent: [] });
		if (path === "/v1/instances/inst-1/coding/engine-choice") return json({ defaultEngineId: "claude", engines: [{ id: "claude", label: "Claude Code", command: "claude", clientType: "claude", model: null, modelSelectable: true, suggestions: [] }], lastObserved: null, appliesTo: "" });
		return json({});
	});
	await page.goto("/console/instances/inst-1/settings");
	await page.getByRole("button", { name: "History" }).click();
	await page.getByRole("button", { name: "payload", exact: true }).click();
	await expect(page.locator("pre").filter({ hasText: "field23" })).toBeVisible();
}

for (const size of [
	{ name: "phone 390×844", width: 390, height: 844 },
	{ name: "desktop 1280×800", width: 1280, height: 800 },
]) {
	test(`mobile — ${size.name} — the expanded payload has no vertical scrollbar of its own and is shown whole`, async ({ page }) => {
		await open(page, size);
		const pre = page.locator("pre").filter({ hasText: "field23" });
		const box = await pre.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, overflowY: getComputedStyle(el).overflowY }));
		expect(box.client).toBeGreaterThan(224); // before: capped at 224px with the rest behind its scrollbar
		expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
		expect(["auto", "scroll"].includes(box.overflowY) && box.scroll > box.client + 1).toBe(false);
		await expect(pre).toContainText("field0");
		await expect(pre).toContainText("field23");
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
	});
}

test("the payload control collapses it again, and nothing was run or changed", async ({ page }) => {
	await open(page, { width: 390, height: 844 });
	await page.getByRole("button", { name: "hide payload" }).click();
	await expect(page.locator("pre").filter({ hasText: "field23" })).toHaveCount(0);
	expect(writes.filter((w) => /triggers/.test(w))).toEqual([]);
});
