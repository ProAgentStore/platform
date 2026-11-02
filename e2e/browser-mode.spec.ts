import { expect, test, type Page } from "@playwright/test";

// Browser interaction against the real console, with all API traffic answered locally.
// The API's validation/inheritance is tested separately; this proves the controls persist the
// requested patch, render the saved answer, and keep inherited state on reload.
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Browser QA", status: "active", slug: "browser-qa", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: "browser", workflow: "BROWSER_TASK" } };
type Mode = "headed" | "headless" | null;

async function mock(page: Page, refuse = false) {
	await page.addInitScript(() => window.localStorage.setItem("pags:session", "test-pags-token"));
	let mode: Mode = null;
	let agentDefault: Mode = "headless";
	const instancePuts: unknown[] = [];
	const agentPuts: unknown[] = [];
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", roles: ["user", "creator"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/agents/agent-1") return json({ id: "agent-1", name: "Browser QA", description: "Browser test", category: "productivity", visibility: "draft", status: "active" });
		if (path === "/v1/agents/agent-1/capabilities") {
			if (req.method() === "PUT") {
				const body = req.postDataJSON();
				agentPuts.push(body);
				agentDefault = body.browserMode;
			}
			return json({ ...INSTANCE.capabilities, browserMode: agentDefault });
		}
		if (path === "/v1/instances/inst-1/browser-mode") {
			if (req.method() === "PUT") {
				const body = req.postDataJSON();
				instancePuts.push(body);
				if (refuse) return json({ error: "Mode change refused for this test" }, 400);
				mode = body.mode;
			}
			return json({ mode, agentDefault, effective: mode ?? agentDefault, source: mode ? "instance" : agentDefault ? "agent" : "runner", explained: "Visible mode needs a desktop session. Screenshot replay works in either mode." });
		}
		if (path === "/v1/instances/inst-1/browser-screenshots") return json({ enabled: true, explained: "Capture screenshots for replay." });
		if (path === "/v1/agents/agent-1/messages") return json({ messages: [] });
		if (path === "/v1/agents/agent-1/versions") return json({ versions: [] });
		if (path === "/v1/agents/agent-1/state") return json({});
		if (path === "/v1/agents/agent-1/settings-schema") return json({ settingsSchema: [] });
		return json({ error: "Not mocked" }, 404);
	});
	return { instancePuts, agentPuts };
}

test("mobile — instance browser mode persists, clears to inherited, and fits at 375px", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { instancePuts } = await mock(page);
	await page.goto("/console/instances/inst-1/settings");
	const card = page.getByTestId("browser-mode-settings");
	const select = card.getByRole("combobox", { name: "Browser mode", exact: true });
	await expect(card).toContainText("Effective setting: Headless browser (from agent)");
	await select.selectOption("headed");
	await expect(card).toContainText("Effective setting: Visible browser (instance override)");
	expect(instancePuts).toEqual([{ mode: "headed" }]);
	await page.reload();
	await expect(select).toHaveValue("headed");
	await expect(card).toContainText("Effective setting: Visible browser (instance override)");
	await select.selectOption("");
	await expect(card).toContainText("Effective setting: Headless browser (from agent)");
	expect(instancePuts).toEqual([{ mode: "headed" }, { mode: null }]);
	await page.reload();
	await expect(select).toHaveValue("");
	await expect(card).toContainText("Effective setting: Headless browser (from agent)");
	await card.scrollIntoViewIfNeeded();
	const box = await card.boundingBox();
	expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
	expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

test("a refused mode change keeps the stored choice and displays the error", async ({ page }) => {
	const { instancePuts } = await mock(page, true);
	await page.goto("/console/instances/inst-1/settings");
	const card = page.getByTestId("browser-mode-settings");
	await card.getByRole("combobox", { name: "Browser mode", exact: true }).selectOption("headed");
	await expect(card).toContainText("Mode change refused for this test");
	await expect(card.getByRole("combobox", { name: "Browser mode", exact: true })).toHaveValue("");
	await expect(card).toContainText("Effective setting: Headless browser (from agent)");
	expect(instancePuts).toEqual([{ mode: "headed" }]);
	await page.reload();
	await expect(card.getByRole("combobox", { name: "Browser mode", exact: true })).toHaveValue("");
});

test("template browser mode saves only its capability and can return to runner default", async ({ page }) => {
	const { agentPuts } = await mock(page);
	const openSettings = async () => {
		await page.goto("/console/agents/agent-1");
		await page.getByRole("button", { name: "Settings", exact: true }).click();
	};
	await openSettings();
	const card = page.getByTestId("browser-mode-default");
	const select = card.getByRole("combobox", { name: "Browser mode", exact: true });
	await expect(select).toHaveValue("headless");
	await select.selectOption("headed");
	await expect(card.getByRole("status")).toContainText("Saved");
	expect(agentPuts).toEqual([{ browserMode: "headed" }]);
	await openSettings();
	await expect(select).toHaveValue("headed");
	await select.selectOption("");
	await expect(card.getByRole("status")).toContainText("Saved");
	expect(agentPuts).toEqual([{ browserMode: "headed" }, { browserMode: null }]);
	await openSettings();
	await expect(select).toHaveValue("");
});
