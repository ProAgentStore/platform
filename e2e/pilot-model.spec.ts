import { expect, test, type Page } from "@playwright/test";

const API = "https://api.proagentstore.online";
const SONNET = "claude-sonnet-4-6";
const HAIKU = "claude-haiku-5-5";

type Readback = "legacy" | "invalid" | "haiku";
async function mock(page: Page, coding = true, readback: { load?: Readback } = {}) {
	await page.addInitScript(() => localStorage.setItem("pags:session", "test-pags-token"));
	const writes: Array<{ path: string; body: unknown }> = [];
	const pilot = () => ({ model: SONNET, fallbackModel: SONNET, options: [{ id: SONNET, label: "Sonnet 4.6", hint: "Coding controller; Anthropic when configured, otherwise the inherited Cloudflare route" }] });
	await page.route(`${API}/**`, async (route) => {
		const req = route.request(); const path = new URL(req.url()).pathname;
		const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (req.method() === "PUT") writes.push({ path, body: req.postDataJSON() });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", avatar: "", roles: ["user"] });
		if (path === "/v1/instances/my/instances") return json({ instances: [{ id: "inst-1", agent_id: "agent-1", name: "Coder", status: "active", slug: "repo-coder", capabilities: { surfaces: coding ? ["coding"] : ["repo"], runtime: coding ? "coding" : null, workflow: coding ? "CODING_SESSION" : null } }] });
		if (path.endsWith("/coder-brain")) return json({ settings: null, triggers: [], pilot: pilot() });
		if (path.endsWith("/po-triage/reports")) return json({ settings: null, triggers: [], reports: [], pilot: readback.load === "legacy" ? undefined : readback.load === "invalid" ? { ...pilot(), options: [] } : readback.load === "haiku" ? { ...pilot(), model: HAIKU, options: [...pilot().options, { id: HAIKU, label: "Haiku 5.5 canary", hint: "Legacy coding canary" }] } : pilot() });
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

test("coding Pilot policy is Sonnet-only and leaves Brain and CLI settings independent", async ({ page }) => {
	const writes = await mock(page);
	await page.goto("/console/instances/inst-1/settings");
	const card = page.getByTestId("pilot-model-card");
	await expect(card.getByLabel("Pilot model")).toHaveText("Sonnet 4.6");
	await expect(card).toContainText(SONNET);
	await expect(card).toContainText("Haiku is not used for coding");
	await expect(card).toContainText("Ticket pickup and queueing use rules, with no model calls or model cost");
	await expect(card.getByRole("combobox")).toHaveCount(0);
	await expect(card.getByRole("option", { name: /Haiku/ })).toHaveCount(0);
	await expect(card.getByRole("button")).toHaveCount(0);
	await expect(page.getByLabel("Brain model")).toHaveValue(SONNET);
	await expect(page.getByLabel("Model", { exact: true })).toHaveValue("opus");
	expect(writes).toEqual([]);
});

for (const load of ["legacy", "invalid", "haiku"] as const) {
	test(`Pilot load with ${load} 200 response shows a retryable API version error`, async ({ page }) => {
		const readback: { load?: Readback } = { load };
		const writes = await mock(page, true, readback);
		await page.goto("/console/instances/inst-1/settings");
		const card = page.getByTestId("pilot-model-card");
		await expect(card).toContainText("The API did not return a supported Pilot policy");
		await expect(card).toContainText("Retry after the API is updated");
		await expect(card).not.toContainText("Loading Pilot model");
		await expect(card.getByLabel("Pilot model")).toHaveCount(0);
		readback.load = undefined;
		await card.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(card.getByLabel("Pilot model")).toHaveText("Sonnet 4.6");
		await expect(card.getByTestId("load-failed")).toHaveCount(0);
		await expect(card.getByRole("combobox")).toHaveCount(0);
		expect(writes).toEqual([]);
	});
}

test("a repository chat instance has no coding Pilot policy card", async ({ page }) => {
	await mock(page, false);
	await page.goto("/console/instances/inst-1/settings");
	await expect(page.getByTestId("brain-model-card")).toBeVisible();
	await expect(page.getByTestId("pilot-model-card")).toHaveCount(0);
});

test.describe("Pilot policy on a phone", () => {
	test.use({ viewport: { width: 390, height: 600 } });
	test("mobile — read-only Pilot policy fits the Settings card", async ({ page }) => {
		const writes = await mock(page);
		await page.goto("/console/instances/inst-1/settings");
		const card = page.getByTestId("pilot-model-card");
		await expect(card.getByLabel("Pilot model")).toHaveText("Sonnet 4.6");
		await card.scrollIntoViewIfNeeded();
		const layout = await card.evaluate((el) => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, scrollWidth: el.scrollWidth, width: el.clientWidth }));
		expect(layout.left).toBeGreaterThanOrEqual(0);
		expect(layout.right).toBeLessThanOrEqual(390);
		expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
		await expect(card.getByRole("combobox")).toHaveCount(0);
		expect(writes).toEqual([]);
	});
});
