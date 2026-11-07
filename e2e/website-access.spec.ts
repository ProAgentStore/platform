import { expect, test, type Page } from "@playwright/test";

const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Job application agent", status: "active", slug: "browser-qa", category: "productivity", capabilities: { surfaces: [], runtime: "browser", workflow: "BROWSER_TASK" } };
type WebsiteAccess = { mode: "allow_all" | "allowlist" | "ask_once"; domains: string[] };

async function mock(page: Page, current = true) {
	await page.addInitScript(() => window.localStorage.setItem("pags:session", "test-pags-token"));
	let access: WebsiteAccess | null = null;
	let decisions = [{ hostname: "jobs.example.com", decision: "allow" }, { hostname: "blocked.example.com", decision: "deny" }];
	const writes: Array<{ path: string; method: string; body: unknown }> = [];
	const request = { id: "request-1", instanceId: "inst-1", instanceName: INSTANCE.name, hostname: "login.jobs.example.com", subjectKind: "local_apply_run", subjectId: "run-1", subjectLink: "/console/instances/inst-1/tasks/run-1", status: "pending", createdAt: "2026-11-04T00:00:00Z", decidedAt: null as string | null, link: "/console/instances/inst-1/website-requests/request-1" };
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (path === "/v1/auth/me") return json({ id: "owner", login: "owner", name: "Owner", roles: ["user", "creator"] });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/agents/agent-1/capabilities") return json(INSTANCE.capabilities);
		if (path === "/v1/instances/inst-1/browser-settings") {
			if (req.method() === "PUT") { const body = req.postDataJSON(); writes.push({ path, method: req.method(), body }); access = body.websiteAccess; }
			const defaults = { mode: null, engine: null, profile: null, websiteAccess: { mode: "ask_once", domains: [] } };
			return json({ mode: null, engine: null, profile: null, websiteAccess: access, agentDefaults: defaults, effective: { ...defaults, websiteAccess: access ?? defaults.websiteAccess }, sources: { mode: "runner", engine: "runner", profile: "runner", websiteAccess: access ? "instance" : "agent" }, requiredCli: "0.4.209", explained: "Website choices apply to this agent." });
		}
		if (path === "/v1/instances/inst-1/website-grants") return json({ domains: decisions.filter((d) => d.decision === "allow").map((d) => d.hostname), decisions });
		if (path.startsWith("/v1/instances/inst-1/website-grants/") && req.method() === "DELETE") {
			writes.push({ path, method: req.method(), body: null }); decisions = decisions.filter((d) => d.hostname !== decodeURIComponent(path.split("/").at(-1)!)); return json({ ok: true });
		}
		if (path === "/v1/instances/inst-1/website-requests/request-1") return json({ request, current });
		if (path === "/v1/instances/inst-1/website-requests/request-1/answer" && req.method() === "POST") {
			const body = req.postDataJSON(); writes.push({ path, method: req.method(), body });
			request.status = body.decision === "approve" ? "approved" : "denied"; request.decidedAt = "2026-11-04T00:01:00Z";
			return json({ request, recorded: true, resumed: current && body.decision === "approve", ...(current ? {} : { resumeError: "The original run ended. No run was started." }) });
		}
		if (path === "/v1/instances/inst-1/browser-settings/session") return json({ status: "disconnected", launch: null, launches: [] });
		if (path === "/v1/instances/inst-1/browser-screenshots") return json({ enabled: true, explained: "Replay enabled." });
		return json({ error: "Not mocked" }, 404);
	});
	return { writes };
}

test("mobile — website question uses the real shell and only the owner's explicit answer mutates", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { writes } = await mock(page);
	await page.goto("/console/instances/inst-1/website-requests/request-1");
	await expect(page.getByRole("heading", { name: "Website access", exact: true })).toBeVisible();
	await expect(page.getByTestId("requested-website")).toHaveText("login.jobs.example.com");
	await expect(page.getByRole("link", { name: "View originating run" })).toHaveAttribute("href", "/console/instances/inst-1/tasks/run-1");
	expect(writes).toEqual([]);
	await page.getByRole("button", { name: "Menu", exact: true }).click();
	await expect(page.getByRole("navigation")).toHaveCount(1);
	await expect(page.getByRole("navigation").getByRole("link", { name: "Instances", exact: true })).toHaveAttribute("aria-current", "page");
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Allow and remember", exact: true }).click();
	await expect(page.getByText("Website remembered. The run has resumed.", { exact: true })).toBeVisible();
	expect(writes).toEqual([{ path: "/v1/instances/inst-1/website-requests/request-1/answer", method: "POST", body: { decision: "approve" } }]);
	await expect(page.getByRole("button", { name: "Allow and remember", exact: true })).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("an ended run's question remembers permission without claiming it resumed", async ({ page }) => {
	const { writes } = await mock(page, false);
	await page.goto("/console/instances/inst-1/website-requests/request-1");
	await expect(page.getByText(/will not restart the run/)).toBeVisible();
	await page.getByRole("button", { name: "Allow and remember", exact: true }).click();
	await expect(page.getByText(/Website remembered. The run has not resumed/)).toBeVisible();
	expect(writes).toHaveLength(1);
	await page.reload();
	await expect(page.getByText("This request was allowed.", { exact: true })).toBeVisible();
	expect(writes).toHaveLength(1);
});

test("denying a website is an explicit saved choice, never an approval", async ({ page }) => {
	const { writes } = await mock(page);
	await page.goto("/console/instances/inst-1/website-requests/request-1");
	await page.getByRole("button", { name: "Deny", exact: true }).click();
	await expect(page.getByText("This request was denied.", { exact: true })).toBeVisible();
	expect(writes[0].body).toEqual({ decision: "deny" });
});

test("mobile — agent website settings save exact hosts and show revocable allow and deny decisions", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const { writes } = await mock(page);
	await page.goto("/console/instances/inst-1/settings?subtab=browser");
	const card = page.getByTestId("browser-mode-settings");
	await expect(card).toContainText("Effective access: Ask once for each new website (from agent)");
	const select = card.getByRole("combobox", { name: "Website access", exact: true });
	await select.selectOption("allowlist");
	await card.getByRole("textbox", { name: "Allowed websites" }).fill("Jobs.Example.com\nlogin.example.com");
	await card.getByRole("button", { name: "Save website list" }).click();
	await expect(card).toContainText("Saved");
	expect(writes.at(-1)?.body).toEqual({ websiteAccess: { mode: "allowlist", domains: ["jobs.example.com", "login.example.com"] } });
	await page.reload();
	await expect(select).toHaveValue("allowlist");
	await expect(card.getByRole("textbox", { name: "Allowed websites" })).toHaveValue("jobs.example.com\nlogin.example.com");
	await expect(card).toContainText("jobs.example.com — Allowed");
	await expect(card).toContainText("blocked.example.com — Denied");
	await card.getByRole("button", { name: "Forget decision for blocked.example.com", exact: true }).click();
	await expect(card.getByRole("button", { name: "Forget decision for blocked.example.com", exact: true })).toHaveCount(0);
	expect(writes.at(-1)?.method).toBe("DELETE");
	await select.selectOption("");
	await expect(card).toContainText("Effective access: Ask once for each new website (from agent)");
	expect(writes.at(-1)?.body).toEqual({ websiteAccess: null });
	expect(await card.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
});
