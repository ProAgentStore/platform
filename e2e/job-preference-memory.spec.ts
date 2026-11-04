import { expect, test, type Page } from "@playwright/test";

const API = "https://api.proagentstore.online";
const KEY = "job_application_preferences";
const today = new Date().toISOString().slice(0, 10);
const future = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
function document(salary = "AUD 150,000 per year") {
	return { version: 1, facts: [
		{ field: "employment_type", answer: "Full Time", confirmedAt: today },
		{ field: "salary_expectation", answer: salary, confirmedAt: today },
		{ field: "availability", answer: "Immediately", confirmedAt: today },
		{ field: "planned_holidays_next_6_months", answer: "No", confirmedAt: today, validUntil: future },
		{ field: "recruitment_adjustments_needed", answer: "No", confirmedAt: today },
	], pendingFields: ["salary_super_basis", "disclosures"] };
}
async function mockMemory(page: Page, mode: "valid" | "unsupported" | "expired" = "valid") {
	await page.addInitScript(() => window.localStorage.setItem("pags:session", "test-pags-token"));
	const first = document();
	if (mode === "expired") Object.assign(first.facts.find(fact => fact.field === "planned_holidays_next_6_months")!, { confirmedAt: "2020-01-01", validUntil: "2020-07-01" });
	const rows = new Map([[
		"inst-1", { key: KEY, type: "preference", source: "user", injected: true, content: JSON.stringify(mode === "unsupported" ? { version: 2, facts: [] } : first) },
	], ["inst-2", { key: KEY, type: "preference", source: "user", injected: true, content: JSON.stringify(document("AUD 200,000 per year")) }]]);
	const writes: Array<{ instanceId: string; content: string; source: string }> = [];
	await page.route(`${API}/**`, async route => {
		const path = new URL(route.request().url()).pathname;
		const json = (body: unknown) => route.fulfill({ json: body });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: ["inst-1", "inst-2"].map(id => ({ id, name: id, status: "active", capabilities: { surfaces: ["apply"], runtime: "browser", workflow: "apply" } })) });
		if (path === "/v1/notifications") return json({ notifications: [], unreadCount: 0 });
		const memory = /^\/v1\/instances\/(inst-[12])\/memory$/.exec(path);
		if (memory) {
			if (route.request().method() === "PUT") {
				const body = route.request().postDataJSON();
				writes.push({ instanceId: memory[1], content: body.content, source: body.source });
				rows.set(memory[1], { ...rows.get(memory[1])!, ...body });
				return json({ success: true });
			}
			if (memory[1] === "inst-2") await new Promise(resolve => setTimeout(resolve, 250));
			return json({ memory: [rows.get(memory[1])] });
		}
		if (path.endsWith("/messages")) return json({ messages: [] });
		return json({});
	});
	return { rows, writes };
}
const path = (id = "inst-1") => `/console/instances/${id}/knowledge?subtab=memory`;

test("mobile — instance job preferences display and edit without JSON, preserving unanswered fields (#1508)", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const mock = await mockMemory(page);
	await page.goto(path());
	await expect(page.getByText("AUD 150,000 per year", { exact: true })).toBeVisible();
	await expect(page.getByText("Full Time", { exact: true })).toBeVisible();
	await expect(page.getByText("Still needs your answer")).toBeVisible();
	await expect(page.getByText("Whether salary includes superannuation", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await expect(page.getByRole("textbox", { name: `Content of memory ${KEY}` })).toHaveCount(0);
	await page.getByRole("textbox", { name: "Availability answer", exact: true }).fill("2 weeks");
	await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect.poll(() => mock.writes.length).toBe(1);
	expect(JSON.parse(mock.writes[0].content)).toMatchObject({ version: 1, pendingFields: ["salary_super_basis", "disclosures"] });
	expect(mock.writes[0].source).toBe("user");
	expect(JSON.parse(mock.writes[0].content).facts.find((fact: { field: string }) => fact.field === "planned_holidays_next_6_months")).toMatchObject({ confirmedAt: today, validUntil: future });
	await page.reload();
	await expect(page.getByText("2 weeks", { exact: true })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("switching instances drops the previous memory and unsaved edit (#1508)", async ({ page }) => {
	const mock = await mockMemory(page);
	await page.goto(path());
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await page.getByRole("textbox", { name: "Availability answer", exact: true }).fill("Unsaved first-instance answer");
	await page.evaluate(next => { window.history.pushState({}, "", next); window.dispatchEvent(new PopStateEvent("popstate")); }, path("inst-2"));
	await expect(page.getByText("AUD 150,000 per year", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Availability answer", exact: true })).toHaveCount(0);
	await expect(page.getByText("AUD 200,000 per year", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Availability answer", exact: true })).toHaveValue("Immediately");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect.poll(() => mock.writes.length).toBe(1);
	expect(mock.writes[0].instanceId).toBe("inst-2");
	expect(mock.writes[0].content).not.toContain("Unsaved first-instance answer");
});

test("unsupported job memory remains visible and repairable instead of appearing empty (#1508)", async ({ page }) => {
	await mockMemory(page, "unsupported");
	await page.goto(path());
	await expect(page.getByRole("alert")).toContainText("Expected version 1");
	await expect(page.locator(".msg-md")).toContainText('"version": 2');
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await page.getByRole("textbox", { name: `Content of memory ${KEY}` }).fill(JSON.stringify(document()));
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("AUD 150,000 per year", { exact: true })).toBeVisible();
});

test("expired preferences retain friendly date editing and cannot save until reconfirmed (#1508)", async ({ page }) => {
	const mock = await mockMemory(page, "expired");
	await page.goto(path());
	await expect(page.getByText("Expired — confirm this answer again before using it.")).toBeVisible();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await expect(page.getByRole("textbox", { name: `Content of memory ${KEY}` })).toHaveCount(0);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("expired");
	expect(mock.writes).toHaveLength(0);
	await page.getByLabel("Planned holidays in the next six months confirmed on", { exact: true }).fill(today);
	await page.getByLabel("Planned holidays in the next six months valid through", { exact: true }).fill(future);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect.poll(() => mock.writes.length).toBe(1);
	await expect(page.getByText("Expired — confirm this answer again before using it.")).toHaveCount(0);
});
