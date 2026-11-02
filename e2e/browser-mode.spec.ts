import { expect, test, type Page } from "@playwright/test";

// Browser interaction against the real console, with all API traffic answered locally.
// The API's validation/inheritance is tested separately; this proves the controls persist the
// requested patch, render the saved answer, and keep inherited state on reload.
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Browser QA", status: "active", slug: "browser-qa", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: "browser", workflow: "BROWSER_TASK" } };
type Settings = { mode: "headed" | "headless" | null; engine: "chrome" | "msedge" | "chromium" | "firefox" | "webkit" | null; profile: "persistent" | "ephemeral" | null };
const LAST_LAUNCH = { engine: "chrome", browserType: "chromium", channel: "chrome", version: "142.0.0", executable: null, mode: "headless", profilePolicy: "persistent", profileId: "browser-qa/chrome/profile", transport: "playwright", launchedAt: "2026-11-03T01:00:00Z", active: true };

async function mock(page: Page, refuse = false) {
	await page.addInitScript(() => window.localStorage.setItem("pags:session", "test-pags-token"));
	const stored: Settings = { mode: null, engine: null, profile: null };
	const defaults: Settings = { mode: "headless", engine: "chrome", profile: null };
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
				if ("browserMode" in body) defaults.mode = body.browserMode;
				if ("browserEngine" in body) defaults.engine = body.browserEngine;
				if ("browserProfilePolicy" in body) defaults.profile = body.browserProfilePolicy;
			}
			return json({ ...INSTANCE.capabilities, browserMode: defaults.mode, browserEngine: defaults.engine, browserProfilePolicy: defaults.profile });
		}
		if (path === "/v1/instances/inst-1/browser-settings") {
			if (req.method() === "PUT") {
				const body = req.postDataJSON();
				instancePuts.push(body);
				if (refuse) return json({ error: "Mode change refused for this test" }, 400);
				Object.assign(stored, body);
			}
			const keys = ["mode", "engine", "profile"] as const;
			return json({ ...stored, agentDefaults: defaults, effective: Object.fromEntries(keys.map((key) => [key, stored[key] ?? defaults[key]])), sources: Object.fromEntries(keys.map((key) => [key, stored[key] ? "instance" : defaults[key] ? "agent" : "runner"])), requiredCli: "0.4.198", explained: "Visible mode needs a desktop session. Screenshot replay works in either mode." });
		}
		if (path === "/v1/instances/inst-1/browser-settings/session") return json({ status: "connected", launch: LAST_LAUNCH, launches: [LAST_LAUNCH] });
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

test("mobile — browser and profile persist independently at 375px while actual launch stays truthful", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { instancePuts } = await mock(page);
	await page.goto("/console/instances/inst-1/settings");
	const card = page.getByTestId("browser-mode-settings");
	const engine = card.getByRole("combobox", { name: "Browser", exact: true });
	const profile = card.getByRole("combobox", { name: "Browser profile", exact: true });
	await expect(card.getByTestId("browser-effective-profile")).toContainText("Workflow default (chosen by workflow)");
	await engine.selectOption("firefox");
	await expect(card.getByTestId("browser-effective-engine")).toContainText("Playwright Firefox (instance override)");
	await profile.selectOption("ephemeral");
	await expect(card.getByTestId("browser-effective-profile")).toContainText("Ephemeral");
	expect(instancePuts).toEqual([{ engine: "firefox" }, { profile: "ephemeral" }]);
	const receipt = page.getByTestId("browser-launch-receipt");
	await expect(receipt).toContainText("Installed Google Chrome (142.0.0)");
	await expect(receipt).toContainText("Headless browser");
	await expect(receipt).not.toContainText("Playwright Firefox");
	await page.reload();
	await expect(engine).toHaveValue("firefox");
	await expect(profile).toHaveValue("ephemeral");
	await engine.selectOption("");
	await expect(card.getByTestId("browser-effective-engine")).toContainText("Installed Google Chrome (from agent)");
	await expect(profile).toHaveValue("ephemeral");
	await profile.selectOption("");
	await expect(card.getByTestId("browser-effective-profile")).toContainText("Workflow default (chosen by workflow)");
	expect(instancePuts).toEqual([{ engine: "firefox" }, { profile: "ephemeral" }, { engine: null }, { profile: null }]);
	for (const panel of [card, receipt]) {
		await panel.scrollIntoViewIfNeeded();
		const box = await panel.boundingBox();
		expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
		expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
	}
});

test("template browser and profile save only their own capability fields", async ({ page }) => {
	const { agentPuts } = await mock(page);
	await page.goto("/console/agents/agent-1");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const card = page.getByTestId("browser-mode-default");
	await card.getByRole("combobox", { name: "Browser", exact: true }).selectOption("firefox");
	await expect(card.getByRole("status")).toContainText("Saved");
	await card.getByRole("combobox", { name: "Browser profile", exact: true }).selectOption("persistent");
	await expect(card.getByRole("status")).toContainText("Saved");
	expect(agentPuts).toEqual([{ browserEngine: "firefox" }, { browserProfilePolicy: "persistent" }]);
	await page.reload();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(card.getByRole("combobox", { name: "Browser", exact: true })).toHaveValue("firefox");
	await expect(card.getByRole("combobox", { name: "Browser profile", exact: true })).toHaveValue("persistent");
	await expect(card.getByRole("combobox", { name: "Browser mode", exact: true })).toHaveValue("headless");
});
