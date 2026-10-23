import { expect, test, type Page } from "@playwright/test";

const API = "https://api.proagentstore.online";
const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-5-5";

async function mock(page: Page, failSave = false, coding = true) {
	await page.addInitScript(() => localStorage.setItem("pags:session", "test-pags-token"));
	let model = SONNET;
	const writes: Array<{ path: string; body: unknown }> = [];
	const pilot = () => ({ model, fallbackModel: SONNET, options: [{ id: SONNET, label: "Sonnet 4.6", hint: "Default controller; Anthropic when configured, otherwise the inherited Cloudflare route" }, { id: HAIKU, label: "Haiku 5.5 canary", hint: "Experimental routine decisions; Sonnet checks endings and owner decisions. Both require an Anthropic API key" }] });
	await page.route(`${API}/**`, async (route) => {
		const req = route.request(); const path = new URL(req.url()).pathname;
		const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (req.method() === "PUT") writes.push({ path, body: req.postDataJSON() });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", avatar: "", roles: ["user"] });
		if (path === "/v1/instances/my/instances") return json({ instances: [{ id: "inst-1", agent_id: "agent-1", name: "Coder", status: "active", slug: "repo-coder", capabilities: { surfaces: coding ? ["coding"] : ["repo"], runtime: coding ? "coding" : null, workflow: coding ? "CODING_SESSION" : null } }] });
		if (path.endsWith("/coder-brain")) {
			if (req.method() === "PUT") {
				if (failSave) return json({ error: "Pilot model is unavailable" }, 400);
				model = req.postDataJSON().pilotModel;
			}
			return json({ settings: null, triggers: [], pilot: pilot() });
		}
		if (path.endsWith("/po-triage/reports")) return json({ settings: null, triggers: [], reports: [], pilot: pilot() });
		if (path.endsWith("/coder-questions")) return json({ settings: null, questions: [] });
		if (path.endsWith("/coding/engine-choice")) return json({ defaultEngineId: "claude", engines: [{ id: "claude", label: "Claude Code", command: "claude --model opus", model: "opus", modelSelectable: true, suggestions: [] }], lastObserved: null, appliesTo: "" });
		if (path.endsWith("/state")) return json({ model: SONNET, modelChosen: true });
		if (path === "/v1/keys/status") return json({ providers: [{ id: "anthropic", hasKey: true }] });
		if (path === "/v1/triggers") return json({ triggers: [] });
		if (path === "/v1/triggers/actions") return json({ actions: [] });
		if (path === "/v1/triggers/preview") return json({ schedule: null, runs: [], issues: [], error: null });
		return json({ error: "Not mocked" }, 404);
	});
	return writes;
}

test("Pilot selection confirms API billing and fallback before writing, independently of Brain and CLI", async ({ page }) => {
	const writes = await mock(page);
	await page.goto("/console/instances/inst-1/settings");
	const card = page.getByTestId("pilot-model-card"); const picker = card.getByLabel("Pilot model");
	await expect(picker).toHaveValue(SONNET);
	await picker.selectOption(HAIKU);
	const dialog = page.getByRole("dialog", { name: "Use Haiku 5.5 canary as this coder's Pilot?" });
	await expect(dialog).toContainText("your own Anthropic API key");
	await expect(dialog).toContainText("fixed fallback");
	await expect(dialog).toContainText(SONNET);
	expect(writes).toEqual([]);
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(picker).toHaveValue(SONNET);
	expect(writes).toEqual([]);
	await picker.selectOption(HAIKU);
	await page.getByRole("button", { name: "Use this Pilot", exact: true }).click();
	await expect(picker).toHaveValue(HAIKU);
	expect(writes).toEqual([{ path: "/v1/instances/inst-1/coder-brain", body: { pilotModel: HAIKU } }]);
	await expect(page.getByLabel("Brain model")).toHaveValue(SONNET);
	await expect(page.getByLabel("Model", { exact: true })).toHaveValue("opus");
	await picker.selectOption(SONNET);
	await expect(page.getByRole("dialog")).toContainText("otherwise keeps the inherited Cloudflare route");
	await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(picker).toHaveValue(HAIKU);
	expect(writes).toHaveLength(1);
});

test("a refused Pilot choice retains the saved policy and reports failure", async ({ page }) => {
	await mock(page, true);
	await page.goto("/console/instances/inst-1/settings");
	const card = page.getByTestId("pilot-model-card");
	await card.getByLabel("Pilot model").selectOption(HAIKU);
	await page.getByRole("button", { name: "Use this Pilot", exact: true }).click();
	await expect(card.getByLabel("Pilot model")).toHaveValue(SONNET);
	await expect(card).toContainText("Pilot model is unavailable");
	await expect(card).not.toContainText("Saved —");
});

test("a repository chat instance has no coding Pilot selector", async ({ page }) => {
	await mock(page, false, false);
	await page.goto("/console/instances/inst-1/settings");
	await expect(page.getByTestId("brain-model-card")).toBeVisible();
	await expect(page.getByTestId("pilot-model-card")).toHaveCount(0);
});

test.describe("Pilot confirmation on a phone", () => {
	test.use({ viewport: { width: 390, height: 600 } });
	test("mobile — confirmation fits and freezes the Settings background until cancellation", async ({ page }, testInfo) => {
		const writes = await mock(page);
		await page.goto("/console/instances/inst-1/settings");
		const picker = page.getByTestId("pilot-model-card").getByLabel("Pilot model");
		await picker.scrollIntoViewIfNeeded(); await picker.focus();
		const count = await picker.evaluate((el) => {
			let n = 0;
			for (let p = el.parentElement; p; p = p.parentElement) {
				if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) { p.setAttribute("data-pilot-background", "1"); n++; }
			}
			return n;
		});
		expect(count).toBeGreaterThan(0);
		const tops = () => page.locator("[data-pilot-background]").evaluateAll((els) => els.map((el) => el.scrollTop));
		const before = await tops();
		await picker.selectOption(HAIKU);
		const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
		const box = await dialog.boundingBox();
		expect(box?.y).toBeGreaterThanOrEqual(0);
		expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(600);
		await page.keyboard.press("End"); await page.keyboard.press("PageDown");
		expect(await tops()).toEqual(before);
		expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
		await page.screenshot({ path: testInfo.outputPath("pilot-confirm-390.png") });
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(picker).toBeFocused();
		expect(await tops()).toEqual(before);
		expect(writes).toEqual([]);
	});
});
