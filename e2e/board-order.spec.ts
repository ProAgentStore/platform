import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1099 — board order is run order (#1097) in the console: drag a Waiting card to the top (pointer events, so
 * touch works too), Top / Up / Down without dragging, a refused move snaps back with the server's reason, and
 * "Run next" on the queue. The mock board answers `POST /board/order` the way the API does — it reorders the
 * column, marks the new top `next`, and refuses a card in another column with 409 — so what the page shows
 * after a move is the server's order, not just the optimistic one.
 */
const API = "https://api.proagentstore.online";
const TOKEN = "test-pags-token";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Repo Coder", status: "active", slug: "repo-coder", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: null, workflow: null } };

type Card = { jobKey: string; title: string; status: string; runQueue?: unknown };
const card = (jobKey: string, title: string, status = "queued"): Card => ({ jobKey, title, status });

async function mockBoard(page: Page, opts: { refuse?: number } = {}) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), TOKEN);
	let waiting = [card("objective:objq-a", "Fix the login"), card("objective:objq-b", "Ship the docs"), card("objective:objq-c", "URGENT: leads dropped")];
	const running = [card("job-run", "Working now", "running")];
	const orders: Array<Record<string, unknown>> = [];
	const marked = () => waiting.map((c, i) => ({ ...c, runQueue: { queue: "objective", next: i === 0 } }));
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user", "creator"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/board") {
			const base = { latestTaskId: "", subtitle: "", description: "", url: "", runStatus: "", userStatus: null, attempts: [], updatedAt: "2026-10-16T00:00:00Z" };
			return json({ items: [...marked(), ...running].map((c) => ({ ...base, ...c })), view: "kanban" });
		}
		if (path === "/v1/instances/inst-1/board/order" && req.method() === "POST") {
			const body = req.postDataJSON() as { jobKey: string; to?: string; before?: string; after?: string };
			orders.push(body);
			if (opts.refuse) return json({ error: opts.refuse === 409 ? "job-run is in another column (Running) than this card (Waiting) — move the card first" : `No card ${body.jobKey} on this board` }, opts.refuse);
			const moving = waiting.find((c) => c.jobKey === body.jobKey);
			if (!moving) return json({ error: `No card ${body.jobKey} on this board` }, 404);
			const rest = waiting.filter((c) => c !== moving);
			const ref = body.before ?? body.after;
			const at = body.to === "top" ? 0 : body.to === "bottom" ? rest.length : rest.findIndex((c) => c.jobKey === ref) + (body.after ? 1 : 0);
			waiting = [...rest.slice(0, at), moving, ...rest.slice(at)];
			return json({ column: { id: "waiting", title: "Waiting" }, items: marked() });
		}
		if (path === "/v1/instances/inst-1/loop/queue") {
			return json({ scope: "pending", entries: marked().map((c, i) => ({ id: c.jobKey.replace("objective:", ""), objective: c.title, jobKey: c.jobKey, next: i === 0 })), activeRun: null, inFlightStarts: [], handoff: null });
		}
		if (path === "/v1/instances/inst-1/loop") return json({ runs: [] });
		// The Settings page's other sections read these in their real shape: `{}` crashes the page
		// into its error boundary (the trigger form reads `preview.issues.length`).
		if (path === "/v1/triggers/preview") return json({ issues: [] });
		return json({});
	});
	return { orders, waitingTitles: () => waiting.map((c) => c.title) };
}

/** The Waiting column's card titles, top to bottom, as the page shows them. */
const waitingColumn = (page: Page) => page.locator("div.rounded-xl", { has: page.getByText("Waiting", { exact: true }) }).first();
const titles = (page: Page) => waitingColumn(page).locator("[data-board-card] h3").allTextContents();

test.describe("board order is run order in the console (#1099)", () => {
	test("dragging a Waiting card to the top makes it the one marked Next to run", async ({ page }) => {
		const mock = await mockBoard(page);
		await page.goto("/console/instances/inst-1/board");
		await expect.poll(() => titles(page)).toEqual(["Fix the login", "Ship the docs", "URGENT: leads dropped"]);
		await expect(waitingColumn(page).locator("[data-board-card]").first().getByTestId("run-marker-next")).toBeVisible();

		// Drag by the handle with real pointer events, onto the top half of the first card.
		const urgent = waitingColumn(page).locator("[data-board-card]", { hasText: "URGENT: leads dropped" });
		const handle = urgent.getByRole("button", { name: "Drag to reorder" });
		const first = await waitingColumn(page).locator("[data-board-card]").first().boundingBox();
		const from = await handle.boundingBox();
		if (!first || !from) throw new Error("cards not laid out");
		await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
		await page.mouse.down();
		await page.mouse.move(first.x + first.width / 2, first.y + 8, { steps: 8 });
		await page.mouse.up();

		await expect.poll(() => mock.orders).toEqual([{ jobKey: "objective:objq-c", before: "objective:objq-a" }]);
		await expect.poll(() => titles(page)).toEqual(["URGENT: leads dropped", "Fix the login", "Ship the docs"]);
		await expect(waitingColumn(page).locator("[data-board-card]", { hasText: "URGENT: leads dropped" }).getByTestId("run-marker-next")).toBeVisible();
	});

	test("Top / Up / Down do the same without dragging", async ({ page }) => {
		const mock = await mockBoard(page);
		await page.goto("/console/instances/inst-1/board");
		const cardNamed = (t: string) => waitingColumn(page).locator("[data-board-card]", { hasText: t });
		await cardNamed("URGENT: leads dropped").getByRole("button", { name: "Move to top" }).click();
		await expect.poll(() => titles(page)).toEqual(["URGENT: leads dropped", "Fix the login", "Ship the docs"]);
		await cardNamed("Ship the docs").getByRole("button", { name: "Move up" }).click();
		await expect.poll(() => titles(page)).toEqual(["URGENT: leads dropped", "Ship the docs", "Fix the login"]);
		// The top card has nowhere further up to go.
		await expect(cardNamed("URGENT: leads dropped").getByRole("button", { name: "Move up" })).toBeDisabled();
		expect(mock.orders[0]).toEqual({ jobKey: "objective:objq-c", to: "top" });
		expect(mock.orders[1]).toEqual({ jobKey: "objective:objq-b", before: "objective:objq-a" });
	});

	test("a refused move snaps back and shows the server's reason", async ({ page }) => {
		await mockBoard(page, { refuse: 409 });
		await page.goto("/console/instances/inst-1/board");
		await waitingColumn(page).locator("[data-board-card]", { hasText: "Ship the docs" }).getByRole("button", { name: "Move to top" }).click();
		await expect(page.getByRole("alert")).toContainText("in another column");
		await expect.poll(() => titles(page)).toEqual(["Fix the login", "Ship the docs", "URGENT: leads dropped"]);
	});

	test("Run next moves a queued objective to the top of the queue it shows", async ({ page }) => {
		const mock = await mockBoard(page);
		await page.goto("/console/instances/inst-1/settings");
		const queue = page.getByTestId("loop-queue");
		await expect(queue.getByTestId("loop-queue-entry").first()).toContainText("Fix the login");
		await queue.getByTestId("loop-queue-entry").filter({ hasText: "URGENT: leads dropped" }).getByRole("button", { name: "Run next" }).click();
		await expect.poll(() => mock.orders).toEqual([{ jobKey: "objective:objq-c", to: "top" }]);
		await expect(queue.getByTestId("loop-queue-entry").first()).toContainText("URGENT: leads dropped");
		await expect(queue.getByTestId("loop-queue-entry").first()).toContainText("Next to run");
	});
});
