import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1233 — brain-free auto-pickup in a coder's Settings: the switch, its rules, and what it last did.
 * The routes are stubbed; this asserts what the card SENDS and what it shows.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Repo Coder", status: "active", slug: "repo-coder", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } };
const BUILTIN = ["needs-human", "blocked-on-serge", "blocked", "question", "wontfix"];

async function mock(page: Page) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	let settings = { enabled: false, priorityLabels: ["P0", "P1", "P2", "P3"], excludeLabels: [] as string[], maxPerDay: 10, maxIterations: 30 };
	const puts: Array<Record<string, unknown>> = [];
	const view = () => ({ settings, builtinExcludeLabels: BUILTIN, activeWhenQueueEmpties: "auto_pickup", recent: settings.enabled ? [{ repo: "acme/app", issue: 9, outcome: "started", detail: "issue #9: Login crash", at: Date.parse("2026-10-19T09:00:00Z") }] : [] });
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/auto-pickup") {
			if (req.method() === "PUT") {
				const body = req.postDataJSON() as Record<string, unknown>;
				puts.push(body);
				settings = { ...settings, ...body };
			}
			return json(view());
		}
		// The coder brain card beside it, with its real shapes.
		if (path === "/v1/instances/inst-1/po-triage/reports") return json({ settings: null, triggers: [], reports: [] });
		if (path === "/v1/instances/inst-1/coder-questions") return json({ settings: null, questions: [] });
		if (path === "/v1/instances/inst-1/operator-manual") return json({ manual: "", inherited: "", sections: { inherited: null, instance: null }, combined: "", rules: "", context: "" });
		// Every coding instance's Settings tab reads its engine choice (#792); a bare {} crashes that card.
		if (path === "/v1/instances/inst-1/coding/engine-choice") return json({ defaultEngineId: "claude", engines: [{ id: "claude", label: "Claude Code", command: "claude", clientType: "claude", model: null, modelSelectable: true, suggestions: [] }], lastObserved: null, appliesTo: "" });
		// The triggers card reads these two lists; a bare {} crashes it (and the error boundary takes the tab).
		if (path === "/v1/triggers") return json({ triggers: [] });
		if (path === "/v1/triggers/actions") return json({ actions: [] });
		if (path === "/v1/triggers/preview") return json({ schedule: null, timezone: null, jitterMinutes: null, runs: [], issues: [], error: null });
		return json({});
	});
	return { puts };
}

test.describe("auto-pickup in Settings (#1233)", () => {
	test("off by default; turning it on sends enabled, and the card shows what it last started", async ({ page }) => {
		const { puts } = await mock(page);
		await page.goto("/console/instances/inst-1/settings");
		const card = page.getByTestId("auto-pickup");
		await expect(card).toContainText("no AI, no tokens");
		await expect(card).toContainText("needs-human");
		const toggle = card.getByRole("checkbox", { name: "Auto-pickup on" });
		await expect(toggle).not.toBeChecked();
		await toggle.click(); // a controlled input flips after the save round-trip, so check() would not see it at once
		await expect(toggle).toBeChecked();
		await expect.poll(() => puts).toEqual([{ enabled: true }]);
		await expect(card.getByTestId("auto-pickup-recent")).toContainText("Started — acme/app#9: issue #9: Login crash");
	});

	test("the label rules save as lists", async ({ page }) => {
		const { puts } = await mock(page);
		await page.goto("/console/instances/inst-1/settings");
		const card = page.getByTestId("auto-pickup");
		await card.getByRole("checkbox", { name: "Auto-pickup on" }).click();
		await expect(card.getByRole("checkbox", { name: "Auto-pickup on" })).toBeChecked();
		const exclude = card.getByRole("textbox", { name: "Also never pick (labels)" });
		await exclude.fill("design, later");
		await exclude.blur();
		await expect.poll(() => puts.at(-1)).toEqual({ excludeLabels: ["design", "later"] });
	});
});
