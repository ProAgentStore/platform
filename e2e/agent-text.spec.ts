import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1129 — agent-written text on the ticket page is rendered as markdown, and a question's options are
 * always buttons. The question below is the reported shape: three numbered decisions written inline,
 * with bold labels. The options carry a comma and one is long — the two things the old `from:` text
 * parse lost, which is how a question with options came to show only a free-text box.
 */
const API = "https://api.proagentstore.online";
const TOKEN = "test-pags-token";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Repo Coder", status: "active", slug: "repo-coder", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["coding"], runtime: "coding", workflow: null } };
const QUESTION = "Three decisions: 1. **Notification channel** — email or push? 2. **Threshold** for alerts? 3. Retry automatically?";
const LONG = "Use the platform default notification channel, which is email to the owner, and nothing else";
const OPTIONS = ["Email, then push", "Push only", LONG];

async function mockTicket(page: Page, opts: { options?: string[]; data?: Record<string, unknown>; noEvents?: boolean } = {}) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), TOKEN);
	const answers: string[] = [];
	const eventQueries: string[] = [];
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user", "creator"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/tasks/t1") {
			return json({ id: "t1", type: "coding.session", status: "needs_human", createdAt: "2026-10-17T00:00:00Z", description: "Configure **alerts** for the deploy", reasoning: "1. Read the issue\n2. **Stopped** to ask — the owner decides the channel" });
		}
		if (path === "/v1/instances/inst-1/task-events") {
			eventQueries.push(new URL(req.url()).search);
			if (opts.noEvents) return json({ events: [] });
			return json({
				events: [
					{ id: "e1", taskId: "t1", type: "agent.needs_input", createdAt: "2026-10-17T00:01:00Z", message: `Needs your input — ${QUESTION}`, data: { field: QUESTION, why: "the alert config needs it", options: opts.options ?? OPTIONS, ...opts.data } },
				],
			});
		}
		if (path === "/v1/instances/inst-1/tasks/t1/thread") return json({ turns: [{ id: "a1", role: "assistant", text: "It **stopped** because:\n\n- the channel is the owner's call", at: "2026-10-17T00:02:00Z" }] });
		if (path === "/v1/instances/inst-1/input" && req.method() === "POST") {
			answers.push((req.postDataJSON() as { value: string }).value);
			return json({ ok: true });
		}
		if (path === "/v1/instances/inst-1/tasks/t1/actions") {
			return json({ entries: [{ id: "x1", ts: "2026-10-17T00:01:30Z", actor: "pilot", actionType: "ask", summary: "Asked the owner about the **channel**", status: "ok", artifacts: [] }], hasMore: false, nextCursor: null, tail: "x1", total: 1 });
		}
		if (path === "/v1/instances/inst-1/browser-takeovers") return json({ takeovers: [] });
		if (path === "/v1/instances/inst-1/browser-artifacts") return json({ artifacts: [] });
		if (path === "/v1/instances/inst-1/board") return json({ items: [] });
		return json({});
	});
	return { answers, eventQueries };
}

test.describe("agent text is markdown, and options are buttons (#1129)", () => {
	test("the question renders bold and a real numbered list — no raw asterisks — and each option is a button", async ({ page }) => {
		const mock = await mockTicket(page);
		await page.goto("/console/instances/inst-1/tasks/t1");
		const card = page.locator("div", { has: page.getByText("The agent needs one answer to continue"), hasText: "Tap your answer" }).last();
		await expect(card.locator("strong", { hasText: "Notification channel" })).toBeVisible();
		await expect(card.locator("ol > li")).toHaveCount(3);
		await expect(card).not.toContainText("**");

		for (const opt of OPTIONS) await expect(card.getByRole("button", { name: opt })).toBeVisible();
		// Options ARE the answer: no free-text box until the owner asks for one.
		await expect(card.getByRole("textbox")).toHaveCount(0);
		await card.getByRole("button", { name: "Email, then push" }).click();
		await expect.poll(() => mock.answers).toEqual(["Email, then push"]);
	});

	test("free text is an explicit escape when options exist, and the only control when there are none", async ({ page }) => {
		await mockTicket(page);
		await page.goto("/console/instances/inst-1/tasks/t1");
		await page.getByRole("button", { name: "None of these — type a different answer" }).click();
		await expect(page.getByRole("textbox", { name: /Three decisions/ })).toBeVisible();
	});

	test("with no options, the box is there at once", async ({ page }) => {
		await mockTicket(page, { options: [] });
		await page.goto("/console/instances/inst-1/tasks/t1");
		await expect(page.getByRole("textbox", { name: /Three decisions/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /None of these/ })).toHaveCount(0);
	});

	test("the ticket's description, its reasoning, and the agent's thread answer render as markdown", async ({ page }) => {
		await mockTicket(page);
		await page.goto("/console/instances/inst-1/tasks/t1");
		await expect(page.locator("strong", { hasText: "alerts" }).first()).toBeVisible();
		await expect(page.locator("ol > li", { hasText: "Read the issue" })).toBeVisible();
		await expect(page.locator("strong", { hasText: "stopped" }).first()).toBeVisible();
		await expect(page.locator("ul > li", { hasText: "the channel is the owner's call" })).toBeVisible();
		await expect(page.locator("strong", { hasText: "channel" }).first()).toBeVisible();
		await expect(page.getByText("**", { exact: false })).toHaveCount(0);
	});

	test("mobile — at phone width (390px) the long option wraps inside the screen and nothing scrolls sideways", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await mockTicket(page);
		await page.goto("/console/instances/inst-1/tasks/t1");
		const long = page.getByRole("button", { name: LONG });
		await expect(long).toBeVisible();
		const box = await long.boundingBox();
		expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	});

	test("a cut question opens to its full text, one tap away (#1129)", async ({ page }) => {
		const full = `${QUESTION} Also: the **escalation** contact is the on-call owner, and the rest of this sentence was past the cut.`;
		await mockTicket(page, { data: { field: `${QUESTION.slice(0, 60)}… [cut: showing the first 60 of ${full.length} characters]`, fullQuestion: full } });
		await page.goto("/console/instances/inst-1/tasks/t1");
		await expect(page.getByText("[cut: showing the first 60")).toBeVisible();
		await page.getByRole("button", { name: "Show the full question" }).click();
		await expect(page.locator("strong", { hasText: "escalation" })).toBeVisible();
		await expect(page.getByText("past the cut")).toBeVisible();
		await expect(page.getByText("[cut:")).toHaveCount(0);
		await page.getByRole("button", { name: "Show less" }).click();
		await expect(page.getByText("[cut: showing the first 60")).toBeVisible();
	});

	const PARTS = [
		{ question: "**Notification channel**?", options: ["Email", "Push"] },
		{ question: "Threshold?", options: ["5 failures", "10 failures"] },
		{ question: "Retry automatically?", options: ["Yes", "No"] },
	];

	test("a question holding several decisions gets one button group per decision, then one Send (#1129)", async ({ page }) => {
		const mock = await mockTicket(page, { options: [], data: { field: "Three settings for the alerts:", parts: PARTS } });
		await page.goto("/console/instances/inst-1/tasks/t1");
		const groups = page.getByTestId("question-parts").locator("fieldset");
		await expect(groups).toHaveCount(3);
		await expect(groups.first().locator("strong", { hasText: "Notification channel" })).toBeVisible();
		// No free-text box while the decisions have options.
		await expect(page.getByRole("textbox", { name: /Three settings/ })).toHaveCount(0);
		const send = page.getByRole("button", { name: "Send", exact: true });
		await groups.nth(0).getByRole("button", { name: "Push" }).click();
		await groups.nth(1).getByRole("button", { name: "10 failures" }).click();
		await expect(send).toBeDisabled(); // every decision is answered before it sends
		await groups.nth(2).getByRole("button", { name: "No" }).click();
		await expect(groups.nth(2).getByRole("button", { name: "No" })).toHaveAttribute("aria-pressed", "true");
		await send.click();
		await expect.poll(() => mock.answers).toEqual(["1. **Notification channel**: Push\n2. Threshold: 10 failures\n3. Retry automatically: No"]);
	});

	test("mobile — at phone width the decision groups wrap inside the screen and nothing scrolls sideways (#1129)", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await mockTicket(page, { options: [], data: { field: "Three settings for the alerts:", parts: [...PARTS, { question: "Where should a failure that repeats overnight be escalated?", options: [LONG, "Nowhere"] }] } });
		await page.goto("/console/instances/inst-1/tasks/t1");
		const long = page.getByRole("button", { name: LONG });
		await expect(long).toBeVisible();
		const box = await long.boundingBox();
		expect(box && box.x >= 0 && box.x + box.width <= 390 && box.height >= 44).toBe(true);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	});
});

test.describe("a coding card waiting on you can always be answered (#1231)", () => {
	test("its events are read for THIS ticket, so an older question cannot fall out of the instance's newest 500", async ({ page }) => {
		const mock = await mockTicket(page);
		await page.goto("/console/instances/inst-1/tasks/t1");
		await expect(page.getByText("The agent needs one answer to continue")).toBeVisible();
		expect(mock.eventQueries.some((q) => new URLSearchParams(q).get("task_id") === "t1")).toBe(true);
	});

	test("with its question event out of reach, the card still offers a text box — never the browser take-over prompt", async ({ page }) => {
		const mock = await mockTicket(page, { noEvents: true });
		await page.goto("/console/instances/inst-1/tasks/t1");
		await expect(page.getByText("The agent needs one answer to continue")).toBeVisible();
		await expect(page.getByText("The agent is stuck on one step")).toHaveCount(0);
		const box = page.getByRole("textbox", { name: "your answer" });
		await box.fill("Deploy it, then close #350");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect.poll(() => mock.answers).toEqual(["Deploy it, then close #350"]);
	});
});
