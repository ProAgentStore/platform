import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1498 — a canonical application page renders just that application. Legacy
 * `?application=<id>` links redirect to the same standalone destination. The API is
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
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [{ id: "runner-1", name: "Job Application Runner", slug: "job-application-runner", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: "local_apply", workflow: null } }] });
		if (path === "/v1/instances/runner-1/application-queue/item") {
			const id = new URL(route.request().url()).searchParams.get("application_id");
			const item = ROWS.find((entry) => entry.applicationId === id);
			return item ? json({ item: targetRationale && id === "app-target" ? { ...item, matchRationale: targetRationale } : item }) : json({ error: "No such application in this pipeline." }, 404);
		}
		if (path === "/v1/instances/runner-1/application-queue") return json({ pipeline: { scouts: [], tailors: [], runners: [] }, items: targetRationale ? ROWS.map(item => item.applicationId === "app-target" ? { ...item, matchRationale: targetRationale } : item) : ROWS, counts: { blocked: 1, awaiting_review: 14 }, limits: [], connections: [], notes: [] });
		if (path.endsWith("/application-handoffs/handoff-1")) return json({ id: "handoff-1", runId: "run-1", applicationId: "app-target", state: "active", expiresAt: null, reason: "login_required" });
		if (path.includes("/connections/deliveries")) return json({ deliveries: [] });
		return json({});
	});
}

test.describe("standalone application destinations (#1498)", () => {
	test("legacy application link redirects to one detail page without mounting the queue", async ({ page }) => {
		await mockQueue(page);
		await page.goto("/console/instances/runner-1/applications?application=app-target");
		await expect(page).toHaveURL(/\/applications\/app-target$/);
		await expect(page.getByRole("group", { name: "Filter by status" })).toHaveCount(0);
		await expect(page.getByText("Filler role 0", { exact: true })).toHaveCount(0);
		const actions = page.getByRole("group", { name: /^Actions for Engineering Manager - Data & AI/ });
		await expect(actions).toBeVisible();
		await expect(actions).toBeInViewport();
		// Only the requested application is mounted.
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
		await expect(page.getByRole("link", { name: /Engineering Manager - Data & AI/ })).toBeVisible();
		await expect(page.getByRole("group", { name: /^Actions for / })).toHaveCount(0);
	});

	test("mobile — the standalone application decisions are visible on a phone", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await mockQueue(page);
		await page.goto("/console/instances/runner-1/applications?application=app-target");
		await expect(page.getByRole("group", { name: /^Actions for Engineering Manager - Data & AI/ })).toBeInViewport();
	});

	test("mobile — long standalone details remain readable and decisions remain reachable", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await mockQueue(page, "This role matches the applicant's engineering leadership and data platform experience. ".repeat(80));
		await page.goto("/console/instances/runner-1/applications?application=app-target");
		await expect(page.getByRole("heading", { name: "Application details", exact: true })).toBeInViewport();
		const actions = page.getByRole("group", { name: /^Actions for Engineering Manager - Data & AI/ });
		await actions.scrollIntoViewIfNeeded();
		await expect(actions).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
	});
});


test("canonical application page survives reload and its back link returns to the queue", async ({ page }) => {
	await mockQueue(page);
	await page.goto("/console/instances/runner-1/applications/app-target");
	await expect(page.getByRole("heading", { name: "Engineering Manager - Data & AI", exact: true })).toBeVisible();
	await expect(page.getByRole("group", { name: "Filter by status" })).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole("heading", { name: "Engineering Manager - Data & AI", exact: true })).toBeVisible();
	await page.getByRole("link", { name: "Back to applications", exact: true }).click();
	await expect(page).toHaveURL(/\/instances\/runner-1\/applications$/);
	await expect(page.getByRole("group", { name: "Filter by status" })).toBeVisible();
	const target = page.getByRole("link", { name: /Engineering Manager - Data & AI/ });
	await expect(target).toHaveAttribute("href", "/console/instances/runner-1/applications/app-target");
	await target.click();
	await expect(page).toHaveURL(/\/applications\/app-target$/);
	await expect(page.getByText("Filler role 0", { exact: true })).toHaveCount(0);
});

test("legacy application redirect preserves handoff query context", async ({ page }) => {
	await mockQueue(page);
	await page.goto("/console/instances/runner-1/applications?application=app-target&handoff=handoff-1");
	await expect(page).toHaveURL(/\/applications\/app-target\?handoff=handoff-1$/);
	await expect(page.getByTestId("application-handoff")).toBeVisible();
});

test("mobile — standalone application uses the real shell menu and stays scoped", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await mockQueue(page);
	await page.goto("/console/instances/runner-1/applications/app-target");
	await expect(page.getByRole("heading", { name: "Application details", exact: true })).toBeVisible();
	const menu = page.getByRole("button", { name: "Menu", exact: true });
	await menu.click();
	await expect(page.getByRole("navigation")).toHaveCount(1);
	await expect(page.getByRole("link", { name: "Instances", exact: true })).toHaveAttribute("aria-current", "page");
	await page.keyboard.press("Escape");
	await expect(menu).toHaveAttribute("aria-expanded", "false");
	await expect(page.getByRole("link", { name: "Back to applications", exact: true })).toHaveAttribute("href", "/console/instances/runner-1/applications");
});


test("standalone exact application remains available outside the bounded queue window", async ({ page }) => {
	await mockQueue(page);
	await page.route(`${API}/v1/instances/runner-1/application-queue`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pipeline: { scouts: [], tailors: [], runners: [] }, items: [], counts: {}, limits: [], connections: [], notes: [] }) }));
	await page.goto("/console/instances/runner-1/applications/app-target");
	await expect(page.getByRole("heading", { name: "Engineering Manager - Data & AI", exact: true })).toBeVisible();
	await expect(page.getByTestId("application-focus-missing")).toHaveCount(0);
	await expect(page.getByRole("group", { name: /^Actions for Engineering Manager/ })).toBeVisible();
});
