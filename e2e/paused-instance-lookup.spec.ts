import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * PR839 / #826 — a PAUSED instance is still yours. Browse and the agent page decide "Open" vs
 * "Subscribe" from the owner's roster; the default roster hides paused instances (the API does, by
 * design, for working lists), so an owner whose only instance of an agent was paused was offered
 * Subscribe again — a second instance made by accident.
 *
 * The mock answers `/v1/instances/my/instances` exactly as the API does: paused instances only with
 * `includePaused`. So "Open" appears here only if the page actually asks for them.
 */
const API = "https://api.proagentstore.online";
const TOKEN = "test-pags-token";
const AGENT = { id: "agent-scout", name: "Job Search Scout", description: "Finds jobs", category: "productivity", visibility: "published", creator_login: "tester", subscriber_count: 3 };
const PAUSED = { id: "inst-paused", agent_id: "agent-scout", name: "Job Search Scout", status: "paused", slug: "job-search-scout", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: null, workflow: null } };

async function mockOwnerWithPausedInstance(page: Page): Promise<{ rosterQueries: string[] }> {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), TOKEN);
	const rosterQueries: string[] = [];
	await page.route(`${API}/**`, async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user", "creator"], boardConfig: null });
		if (path === "/v1/instances/my/instances") {
			rosterQueries.push(url.search);
			const withPaused = ["1", "true", "yes"].includes(url.searchParams.get("includePaused") ?? "");
			return json({ instances: withPaused ? [PAUSED] : [] });
		}
		if (path === "/v1/agents") return json({ agents: [AGENT] });
		if (path === `/v1/agents/${AGENT.id}`) return json({ ...AGENT, owner_id: "someone-else", config: {} });
		if (path === `/v1/agents/${AGENT.id}/messages`) return json({ messages: [] });
		return json({});
	});
	return { rosterQueries };
}

test.describe("a paused instance still counts as yours (PR839, #826)", () => {
	test("Browse offers Open — not Subscribe — for an agent whose only instance is paused", async ({ page }) => {
		const { rosterQueries } = await mockOwnerWithPausedInstance(page);
		await page.goto("/console/browse");
		const card = page.locator("div", { has: page.getByRole("heading", { name: "Job Search Scout" }) }).last();
		await expect(card.getByRole("button", { name: "Open →" })).toBeVisible();
		await expect(card.getByRole("button", { name: "Subscribe" })).toHaveCount(0);
		await expect(card.getByRole("button", { name: "+ New" })).toBeVisible();
		expect(rosterQueries.some((q) => q.includes("includePaused"))).toBe(true);
		await card.getByRole("button", { name: "Open →" }).click();
		await expect(page).toHaveURL(/\/console\/instances\/inst-paused/);
	});

	test("the agent page offers 'Open my instance' — not 'Use this agent' — when that instance is paused", async ({ page }) => {
		await mockOwnerWithPausedInstance(page);
		await page.goto(`/console/agents/${AGENT.id}`);
		// The control sits with the creator's settings (#797).
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(page.getByRole("button", { name: "Open my instance" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Use this agent" })).toHaveCount(0);
	});
});
