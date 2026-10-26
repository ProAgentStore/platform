import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1136 — an application notification opens THAT application: the Applications tab with
 * `?application=<id>` selects its row and shows its decisions, instead of the whole Board. The API is
 * mocked; the link's server half is held by `console-links.test.ts`.
 */
const API = "https://api.proagentstore.online";

const row = (id: string, title: string, status: string) => ({
	key: `app:${id}`, kind: "application", status, title, company: "Globex", location: "Sydney",
	url: "https://jobs.example.com/1", source: "SEEK", postedDate: null, matchRationale: null, scoutInstanceId: "scout-1", leadId: `lead-${id}`, leadVersion: 1,
	applicationId: id, tailorInstanceId: "tailor-1", stateVersion: 3, blockReason: null, questions: [],
	artifacts: null, profileVersion: null, tailoringRunId: null, fillRunId: null, fillRun: null,
	submittedAt: null, submittedUrl: null, submitAttempted: false, submitPolicy: null, fillProgress: null,
	execution: null, diagnostic: null, queue: null, submitAuthorization: null, updatedAt: "2026-10-18T00:00:00Z", actions: ["defer", "archive"],
});
// Enough rows that the requested one is not where a page opens.
const ROWS = [
	...Array.from({ length: 14 }, (_, n) => row(`app-${n}`, `Filler role ${n}`, "awaiting_review")),
	row("app-target", "Engineering Manager - Data & AI", "blocked"),
];

async function mockQueue(page: Page, targetRationale?: string) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	await page.route(`${API}/**`, (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [{ id: "runner-1", name: "Job Application Runner", slug: "job-application-runner", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: "local_apply", workflow: null } }] });
		if (path === "/v1/instances/runner-1/application-queue") return json({ pipeline: { scouts: [], tailors: [], runners: [] }, items: targetRationale ? ROWS.map(item => item.applicationId === "app-target" ? { ...item, matchRationale: targetRationale } : item) : ROWS, counts: { blocked: 1, awaiting_review: 14 }, limits: [], connections: [], notes: [] });
		if (path.includes("/connections/deliveries")) return json({ deliveries: [] });
		return json({});
	});
}

test.describe("an application notification opens that application (#1136)", () => {
	test("?application=<id> selects its row and shows its decisions, scrolled into view", async ({ page }) => {
		await mockQueue(page);
		await page.goto("/console/instances/runner-1/applications?application=app-target");
		const actions = page.getByRole("group", { name: /^Actions for Engineering Manager - Data & AI/ });
		await expect(actions).toBeVisible();
		await expect(actions).toBeInViewport();
		// Only the requested one is open — not the first row, not every row.
		await expect(page.getByRole("group", { name: /^Actions for / })).toHaveCount(1);
		await expect(page.getByTestId("application-focus-missing")).toHaveCount(0);
	});

	test("an application no longer in the queue is said to be gone, not silently ignored", async ({ page }) => {
		await mockQueue(page);
		await page.goto("/console/instances/runner-1/applications?application=app-deleted");
		await expect(page.getByTestId("application-focus-missing")).toBeVisible();
		await expect(page.getByRole("group", { name: /^Actions for / })).toHaveCount(0);
	});

	test("without the parameter the tab opens as before — nothing selected", async ({ page }) => {
		await mockQueue(page);
		await page.goto("/console/instances/runner-1/applications");
		await expect(page.getByRole("button", { name: /Engineering Manager - Data & AI/ })).toBeVisible();
		await expect(page.getByRole("group", { name: /^Actions for / })).toHaveCount(0);
	});

	test("mobile — the focused application's decisions are in view on a phone", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await mockQueue(page);
		await page.goto("/console/instances/runner-1/applications?application=app-target");
		await expect(page.getByRole("group", { name: /^Actions for Engineering Manager - Data & AI/ })).toBeInViewport();
	});

	test("mobile — long application details still bring the decisions into view (#1377)", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await mockQueue(page, "This role matches the applicant's engineering leadership and data platform experience. ".repeat(80));
		await page.goto("/console/instances/runner-1/applications?application=app-target");
		await expect(page.getByRole("group", { name: /^Actions for Engineering Manager - Data & AI/ })).toBeInViewport();
	});
});
