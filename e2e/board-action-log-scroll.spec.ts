import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1307 — a board card's expanded Action log used to be a max-h-72 box with its own vertical scrollbar inside the board that
 * already scrolls. Geometry is measured in a real browser with a long board and a 50-entry log served in two pages; routes are
 * stubbed and nothing on the board is moved, run or changed.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Repo Coder", status: "active", slug: "repo-coder", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: null, workflow: null } };
const base = { subtitle: "", description: "", url: "", runStatus: "", userStatus: null, attempts: [], updatedAt: "2026-10-16T00:00:00Z" };
const CARDS = [
	{ ...base, jobKey: "job-log", title: "Card with a long log", status: "done", latestTaskId: "task-1" },
	...Array.from({ length: 12 }, (_, n) => ({ ...base, jobKey: `job-${n}`, title: `Filler card ${n}`, status: "queued", latestTaskId: "" })),
];
const ENTRIES = Array.from({ length: 50 }, (_, n) => ({
	id: `a${n}`,
	ts: `2026-10-16T00:${String(n).padStart(2, "0")}:00Z`,
	actor: "coding-engine",
	instanceId: "inst-1",
	actionType: "checkpoint",
	summary: `Step ${n + 1} of the run`,
	status: "ok",
	artifacts: n === 0 ? [{ kind: "commit", label: "5dd541e4bb4b", url: "https://github.com/acme/repo/commit/5dd541e4bb4b" }] : [],
}));
const writes: string[] = [];

async function open(page: Page, size: { width: number; height: number }) {
	writes.length = 0;
	await page.setViewportSize(size);
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname;
		if (req.method() !== "GET") writes.push(`${req.method()} ${path}`);
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user", "creator"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/board") return json({ items: CARDS, view: "kanban" });
		if (path === "/v1/instances/inst-1/tasks/task-1/actions") {
			const second = url.searchParams.get("cursor") === "a29";
			return json(second
				? { entries: ENTRIES.slice(30), hasMore: false, nextCursor: null, tail: "a49", total: 50 }
				: { entries: ENTRIES.slice(0, 30), hasMore: true, nextCursor: "c30", tail: "a29", total: 50 });
		}
		if (path === "/v1/instances/inst-1/loop/queue") return json({ scope: "pending", entries: [], activeRun: null, inFlightStarts: [], handoff: null });
		if (path === "/v1/instances/inst-1/loop") return json({ runs: [] });
		return json({});
	});
	await page.goto("/console/instances/inst-1/board");
	await page.getByRole("button", { name: /Action log/ }).click();
	await expect(page.getByText("Step 30 of the run")).toBeAttached();
}

/** Every vertical scroller that holds a log entry: there must be none inside the board. */
const logScrollers = (page: Page) =>
	page.evaluate(() => {
		const li = Array.from(document.querySelectorAll("li")).find((el) => el.textContent?.includes("Step 1 of the run"));
		const out: string[] = [];
		for (let el = li?.parentElement ?? null; el && el !== document.body; el = el.parentElement) {
			const oy = getComputedStyle(el).overflowY;
			if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) out.push(`${el.tagName.toLowerCase()}:${Math.round(el.clientHeight)}/${Math.round(el.scrollHeight)}`);
		}
		return out;
	});

for (const size of [
	{ name: "phone 390×844", width: 390, height: 844 },
	{ name: "desktop 1280×800", width: 1280, height: 800 },
]) {
	test(`${size.name} — the log has no scroller of its own: its only scrolling ancestor is the board's`, async ({ page }) => {
		await open(page, size);
		const ancestors = await logScrollers(page);
		expect(ancestors).toHaveLength(1); // before: the 288px log box AND the board
		// ...and it is the instance tab/page itself (a full-height container), not a box around the log.
		const [client, scroll] = ancestors[0].split(":")[1].split("/").map(Number);
		expect(client).toBeGreaterThan(Math.min(size.height - 150, 600));
		expect(scroll).toBeGreaterThan(client);
		const log = page.locator("ol").filter({ hasText: "Step 1 of the run" });
		expect((await log.boundingBox())?.height ?? 0).toBeGreaterThan(288);
	});
}

test("order, link, Load more and collapse are unchanged", async ({ page }) => {
	await open(page, { width: 390, height: 844 });
	const items = page.locator("ol li");
	await expect(items.first()).toContainText("Step 1 of the run");
	await expect(items.nth(29)).toContainText("Step 30 of the run");
	await expect(page.getByRole("link", { name: "5dd541e4bb4b" })).toHaveAttribute("href", "https://github.com/acme/repo/commit/5dd541e4bb4b");
	await page.getByRole("button", { name: /Load more \(30 of 50\)/ }).click();
	await expect(items).toHaveCount(50);
	await expect(items.last()).toContainText("Step 50 of the run");
	await page.getByRole("button", { name: /Hide log/ }).click();
	await expect(page.locator("ol li")).toHaveCount(0);
	// The console's own preference sync is not the board's: nothing on the board or its tasks was written.
	expect(writes.filter((w) => /\/board|\/tasks|\/loop/.test(w))).toEqual([]);
});
