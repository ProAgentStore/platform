import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1306 — the Repo tab's "Show files" list used to be a max-h-56 box with its own vertical scrollbar inside the tab that already
 * scrolls. Geometry is measured in a real browser with several indexed repos and a long path list; routes are stubbed and no
 * repository is indexed, re-indexed or removed.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Code Reader", status: "active", slug: "code-reader", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["chat", "repo"], runtime: null, workflow: null } };
const PATHS = Array.from({ length: 100 }, (_, n) => `src/module-${String(n).padStart(3, "0")}/index.ts`);
const REPOS = Array.from({ length: 6 }, (_, n) => ({
	key: `acme/repo-${n}`,
	repoUrl: `https://github.com/acme/repo-${n}`,
	status: "done",
	total: n === 0 ? PATHS.length : 3,
	language: "TypeScript",
	description: `Repository number ${n}.`,
	paths: n === 0 ? PATHS : ["README.md", "package.json", "src/index.ts"],
}));
const writes: string[] = [];

async function open(page: Page, size: { width: number; height: number }) {
	writes.length = 0;
	await page.setViewportSize(size);
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		if (req.method() !== "GET") writes.push(`${req.method()} ${path}`);
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/ingest-repo/status") return json({ repos: REPOS });
		return json({});
	});
	await page.goto("/console/instances/inst-1/repo");
	await page.getByRole("button", { name: /Show files \(100\)/ }).click();
	await expect(page.getByText("src/module-099/index.ts")).toBeAttached();
}

for (const size of [
	{ name: "phone 390×844", width: 390, height: 844 },
	{ name: "desktop 1280×800", width: 1280, height: 800 },
]) {
	test(`${size.name} — the file list has no vertical scrollbar of its own; all 100 paths are on the page`, async ({ page }) => {
		await open(page, size);
		const list = page.locator("div.font-mono").filter({ hasText: "src/module-000/index.ts" });
		const box = await list.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, overflowY: getComputedStyle(el).overflowY }));
		expect(box.client).toBeGreaterThan(224); // before: capped at 224px, the rest behind its scrollbar
		expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
		expect(["auto", "scroll"].includes(box.overflowY) && box.scroll > box.client + 1).toBe(false);
		expect(await list.locator("div").count()).toBe(100);
		await expect(list).toContainText("src/module-000/index.ts");
		await expect(list).toContainText("src/module-099/index.ts");
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
	});
}

test("counts and collapse are unchanged: the count is on the button, Hide removes the list, other repos stay below", async ({ page }) => {
	await open(page, { width: 390, height: 844 });
	await expect(page.getByText("acme/repo-5")).toBeAttached();
	await page.getByRole("button", { name: /Hide files \(100\)/ }).click();
	await expect(page.getByText("src/module-050/index.ts")).toHaveCount(0);
	await expect(page.getByRole("button", { name: /Show files \(100\)/ })).toBeVisible();
	expect(writes.filter((w) => /ingest-repo/.test(w))).toEqual([]);
});
