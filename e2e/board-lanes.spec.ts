import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1698 — the board's Lanes view: the server's shared card projection in four lanes (Queued, In Progress, Blocked, Done). The mock
 * answers `GET /board/projection` as the API does; what is under test is what the page shows for each card, that a recorded answer the
 * run has not applied yet reads Waiting to Resume rather than Needs you (and keeps its one card), and that the lanes fit a phone.
 */
const API = "https://api.proagentstore.online";
const TOKEN = "test-pags-token";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Repo Coder", status: "active", slug: "repo-coder", category: "developer", icon_bg: "#0f766e", capabilities: { surfaces: ["coding"], runtime: "coding", workflow: null } };

type Card = Record<string, unknown>;
const base = { needsYou: false, waitingToResume: false, nativeStatus: "running", updatedAt: 1, instanceId: "inst-1" };
const session = (id: string, over: Card = {}): Card => ({ ...base, cardId: `csess-${id}`, kind: "coding-session", lane: "in_progress", title: `Session ${id}`, native: { status: "active", sessionId: id }, ...over });

async function mockBoard(page: Page, state: { cards: Card[]; view?: string }) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), TOKEN);
	await page.route(`${API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/board") return json({ columns: [], items: [], view: state.view ?? "kanban", truncated: false });
		if (path === "/v1/instances/inst-1/board/projection") return json({ lanes: [], cards: state.cards });
		if (path === "/v1/triggers/preview") return json({ issues: [] });
		return json({});
	});
}

const open = async (page: Page) => {
	await page.goto("/console/instances/inst-1/board");
	await page.getByTitle("Runs and sessions by lane").click();
	await expect(page.getByTestId("execution-lanes")).toBeVisible();
};
const lane = (page: Page, id: string) => page.getByTestId(`lane-${id}`);

test.describe("the four-lane board (#1698)", () => {
	test("places mixed records in Queued, In Progress, Blocked and Done, each with what it needs", async ({ page }) => {
		await mockBoard(page, {
			cards: [
				{ ...base, cardId: "objective:e1", kind: "queued-objective", lane: "queued", nativeStatus: "pending", title: "Add a health check", native: { status: "pending", queueEntryId: "e1" } },
				session("s1"),
				session("s2", { lane: "blocked", needsYou: true, blocker: { what: "Waiting for your answer: Which branch?", nextOwner: "owner" } }),
				{ ...base, cardId: "app-attempt-fill-f1", kind: "application-attempt", lane: "done", outcome: "failed", nativeStatus: "failed", title: "Application attempt", native: { status: "failed", runId: "f1", applicationId: "app-1", runKind: "fill" } },
			],
		});
		await open(page);
		await expect(page.getByTestId("execution-lanes").locator('[data-testid^="lane-"]')).toHaveCount(4);
		await expect(lane(page, "queued").locator('[data-card-id="objective:e1"]')).toBeVisible();
		await expect(lane(page, "in_progress").locator('[data-card-id="csess-s1"]')).toBeVisible();
		const blocked = lane(page, "blocked").locator('[data-card-id="csess-s2"]');
		await expect(blocked.getByTestId("badge-needs-you")).toBeVisible();
		await expect(blocked.getByTestId("blocker")).toContainText("Which branch? · Next: you");
		const done = lane(page, "done").locator('[data-card-id="app-attempt-fill-f1"]');
		await expect(done.getByTestId("badge-outcome")).toHaveText("Failed");
		// A session and an application open their own pages; a queued objective has none.
		await expect(blocked.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/console/instances/inst-1/coding/s2");
		await expect(done.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/console/instances/inst-1/applications/app-1");
		await expect(lane(page, "queued").locator('[data-card-id="objective:e1"]').getByRole("link")).toHaveCount(0);
	});

	test("a recorded answer the run has not applied is Waiting to Resume, not Needs you, and stays one card", async ({ page }) => {
		const state = { cards: [session("s1", { lane: "blocked", needsYou: true, blocker: { what: "Waiting for your answer: Ship it?", nextOwner: "owner" } })] };
		await mockBoard(page, state);
		await open(page);
		await expect(lane(page, "blocked").locator('[data-card-id="csess-s1"]').getByTestId("badge-needs-you")).toBeVisible();

		// The owner answers; the run has not applied it yet: the same card, now waiting on the RUN.
		state.cards = [session("s1", { lane: "queued", waitingToResume: true })];
		const queuedCard = lane(page, "queued").locator('[data-card-id="csess-s1"]');
		await expect(queuedCard.getByTestId("badge-waiting-to-resume")).toBeVisible({ timeout: 15_000 });
		await expect(queuedCard.getByTestId("badge-needs-you")).toHaveCount(0);
		await expect(page.locator('[data-card-id="csess-s1"]')).toHaveCount(1); // never a duplicate owner action
		await expect(lane(page, "blocked").locator('[data-card-id="csess-s1"]')).toHaveCount(0);
	});

	test("the four lanes are the default board: no click, and Board stays one click away", async ({ page }) => {
		await mockBoard(page, { view: "lanes", cards: [session("s1")] });
		await page.goto("/console/instances/inst-1/board");
		await expect(page.getByTestId("execution-lanes")).toBeVisible();
		await expect(page.getByTitle("Runs and sessions by lane")).toHaveAttribute("aria-pressed", "true");
		await page.getByTitle("Board view").click();
		await expect(page.getByTestId("execution-lanes")).toHaveCount(0);
		await page.getByTitle("Runs and sessions by lane").click();
		await expect(page.getByTestId("execution-lanes")).toBeVisible();
	});

	test("unstarted tickets are Queued in the picker's order with a rank, and a deferred question keeps its one card", async ({ page }) => {
		await mockBoard(page, {
			view: "lanes",
			cards: [
				{ ...base, cardId: "ticket:b", kind: "queued-ticket", lane: "queued", queueRank: 1, title: "Second ticket", nativeStatus: "unstarted", native: { status: "unstarted", ticketId: "b", pickup: "agent" } },
				{ ...base, cardId: "ticket:a", kind: "queued-ticket", lane: "queued", queueRank: 0, title: "First ticket", nativeStatus: "unstarted", native: { status: "unstarted", ticketId: "a", pickup: "agent" } },
				session("s9", {
					lane: "blocked",
					needsYou: true,
					blocker: { what: "Waiting for your answer: Which branch?", nextOwner: "owner" },
					ownerAction: { itemId: "coder_question:q9", triage: { status: "deferred", needsComputer: true, deferUntil: null } },
				}),
			],
		});
		await page.goto("/console/instances/inst-1/board");
		await expect(lane(page, "queued").getByTestId("execution-card")).toHaveCount(2);
		const titles = await lane(page, "queued").locator('[data-testid="execution-card"] .font-semibold').allTextContents();
		expect(titles).toEqual(["First ticket", "Second ticket"]);
		await expect(lane(page, "queued").getByTestId("badge-queue-rank").first()).toHaveText("Next to run");
		const blocked = lane(page, "blocked").locator('[data-card-id="csess-s9"]');
		await expect(blocked.getByTestId("badge-needs-you")).toBeVisible();
		await expect(blocked.getByTestId("badge-triage")).toHaveText(["Deferred", "Needs computer"]);
		await expect(page.locator('[data-card-id="csess-s9"]')).toHaveCount(1);
	});

	test("a projection answer without cards shows the failure, and the page does not crash", async ({ page }) => {
		await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), TOKEN);
		await page.route(`${API}/**`, async (route) => {
			const path = new URL(route.request().url()).pathname;
			const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
			if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
			if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
			if (path === "/v1/instances/inst-1/board") return json({ columns: [], items: [], view: "lanes", truncated: false });
			return json({}); // the projection included: {}
		});
		await page.goto("/console/instances/inst-1/board");
		await expect(page.getByText(/the lanes/i).first()).toBeVisible();
		await expect(page.getByTestId("execution-lanes")).toHaveCount(0);
		await page.getByTitle("Board view").click(); // the rest of the board still works
		await expect(page.getByTitle("Board view")).toHaveAttribute("aria-pressed", "true");
	});

	test("a task held for approval is Blocked on you, and Approve posts to the endpoint the Board already uses", async ({ page }) => {
		const posts: string[] = [];
		const state = {
			view: "lanes",
			cards: [{ ...base, cardId: "task:t1", kind: "task", lane: "blocked", needsYou: true, nativeStatus: "needs_approval", title: "Apply to Acme", blocker: { what: "Waiting for your approval", nextOwner: "owner" }, native: { status: "needs_approval", taskId: "t1" } }] as Card[],
		};
		await mockBoard(page, state);
		await page.route(`${API}/v1/instances/inst-1/tasks/t1/approve`, async (route) => {
			posts.push(route.request().method());
			state.cards = [{ ...state.cards[0], lane: "in_progress", needsYou: false, blocker: undefined, nativeStatus: "running", native: { status: "running", taskId: "t1" } }];
			await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
		});
		await page.goto("/console/instances/inst-1/board");
		const card = lane(page, "blocked").locator('[data-card-id="task:t1"]');
		await expect(card.getByTestId("badge-needs-you")).toBeVisible();
		await card.getByTestId("approve").click();
		await expect.poll(() => posts).toEqual(["POST"]);
		await expect(lane(page, "in_progress").locator('[data-card-id="task:t1"]')).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('[data-card-id="task:t1"]')).toHaveCount(1);
	});

	test("an unreadable projection shows its failure with Retry, not an empty board", async ({ page }) => {
		await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), TOKEN);
		await page.route(`${API}/**`, async (route) => {
			const path = new URL(route.request().url()).pathname;
			const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
			if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
			if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
			if (path === "/v1/instances/inst-1/board") return json({ columns: [], items: [], view: "kanban", truncated: false });
			if (path === "/v1/instances/inst-1/board/projection") return json({ error: "boom" }, 500);
			return json({});
		});
		await page.goto("/console/instances/inst-1/board");
		await page.getByTitle("Runs and sessions by lane").click();
		await expect(page.getByText(/the lanes/i).first()).toBeVisible();
		await expect(page.getByTestId("execution-lanes")).toHaveCount(0);
	});

	for (const width of [320, 375, 390]) {
		test(`mobile — the lanes fit at ${width}px and every Open link clears 24px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockBoard(page, {
				cards: [
					session("s1", { title: "A long session title that has to wrap on a very narrow phone without pushing the page sideways" }),
					session("s2", { lane: "blocked", needsYou: true, blocker: { what: "Waiting for your answer: a fairly long question about which branch to merge into?", nextOwner: "owner" } }),
					{ ...base, cardId: "scan-r1", kind: "scan", lane: "done", outcome: "succeeded", title: "Scan", native: { status: "completed", runId: "r1" } },
				],
			});
			await open(page);
			for (const link of await page.getByTestId("execution-lanes").getByRole("link", { name: "Open" }).all()) {
				const box = await link.boundingBox();
				expect(box?.height ?? 0, "an Open link is under 24px").toBeGreaterThanOrEqual(24);
			}
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
			expect(overflow, `the page overflows by ${overflow}px at ${width}px`).toBeLessThanOrEqual(1);
		});
	}
});
