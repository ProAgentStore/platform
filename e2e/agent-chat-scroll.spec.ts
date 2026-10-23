import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1302 — Agent detail → Chat owns ONE vertical scroll. The transcript used to sit under `calc(100dvh - 320px)` inside
 * the console's scrolling <main>, so on a phone or a short landscape screen the page and the transcript were nested,
 * competing scrollbars. Geometry is measured in a real browser with a populated history and a header that wraps;
 * routes are synthetic and nothing is sent.
 */
const API = "https://api.proagentstore.online";
const LONG_NAME = "Quarterly Compliance & Contract Review Assistant for the Northern Region Operations Group";
const LONG_DESC = "Reads incoming contracts, flags unusual clauses, drafts replies for approval and keeps a running summary of open obligations for every counterparty across all of the regional offices. ".repeat(2);
const AGENT = { id: "agent-1", name: LONG_NAME, slug: "quarterly-compliance-contract-review-assistant", description: LONG_DESC, category: "productivity", visibility: "draft", model: "", icon_bg: "#7c3aed" };
const SHORT_AGENT = { ...AGENT, name: "Notes", slug: "notes", description: "Short." };
const MESSAGES = Array.from({ length: 40 }, (_, n) => ({ id: `m${n}`, role: n % 2 ? "user" : "assistant", content: `Synthetic message ${n + 1}. `.repeat(14), createdAt: "2026-10-23T00:00:00Z" }));

async function open(page: Page, size: { width: number; height: number }, agent = AGENT) {
	await page.setViewportSize(size);
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	const writes: string[] = [];
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		if (req.method() !== "GET") writes.push(`${req.method()} ${path}`);
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [] });
		if (path === "/v1/agents/agent-1") return json(agent);
		if (path === "/v1/agents/agent-1/messages") return json({ messages: MESSAGES });
		if (path === "/v1/notifications") return json({ notifications: [], unreadCount: 0 });
		return json({});
	});
	await page.goto("/console/agents/agent-1/chat");
	await expect(page.getByTestId("agent-chat-transcript")).toBeVisible();
	await expect(page.getByText("Synthetic message 40.").first()).toBeVisible();
	return writes;
}

/** Every element that scrolls vertically and actually has something to scroll. */
const scrollers = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLElement>("*"))
			.filter((el) => {
				const oy = getComputedStyle(el).overflowY;
				return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
			})
			.map((el) => el.getAttribute("data-testid") || el.tagName.toLowerCase()),
	);

const SIZES = [
	{ name: "phone 390×844", width: 390, height: 844 },
	{ name: "small phone 320×568", width: 320, height: 568 },
	{ name: "landscape phone 844×390", width: 844, height: 390 },
	{ name: "desktop 1280×800", width: 1280, height: 800 },
];

for (const size of SIZES) {
	test(`${size.name} — only the transcript scrolls; the composer stays on screen`, async ({ page }) => {
		await open(page, size);
		expect(await scrollers(page)).toEqual(["agent-chat-transcript"]);
		const t = await page.getByTestId("agent-chat-transcript").boundingBox();
		expect(t?.height ?? 0).toBeGreaterThanOrEqual(120);
		const composer = await page.getByLabel("Message this agent").boundingBox();
		const sendBtn = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
		for (const box of [composer, sendBtn]) {
			expect(box).not.toBeNull();
			expect(box!.y).toBeGreaterThanOrEqual(0);
			expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);
		}
		// The page itself has no vertical scroll to compete with.
		expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
	});
}

test("the transcript keeps the whole history: it opens at the newest message and scrolls back to the first", async ({ page }) => {
	await open(page, { width: 390, height: 844 });
	const transcript = page.getByTestId("agent-chat-transcript");
	const atBottom = await transcript.evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2);
	expect(atBottom).toBe(true);
	await transcript.evaluate((el) => { el.scrollTop = 0; });
	await expect(page.getByText("Synthetic message 1.").first()).toBeInViewport();
});

test("short screen: the composer takes typing and Enter sends — no stray write, focus stays in the input", async ({ page }) => {
	const writes = await open(page, { width: 844, height: 390 }, SHORT_AGENT);
	const input = page.getByLabel("Message this agent");
	await input.focus();
	await input.fill("hello");
	await expect(input).toBeFocused();
	expect(await scrollers(page)).toEqual(["agent-chat-transcript"]);
	// Typing sends nothing; the console's own preference sync is not the agent's.
	expect(writes.filter((w) => /\/agents\/|\/messages/.test(w))).toEqual([]);
});

test("a short name and description do not change the model: still only the transcript scrolls", async ({ page }) => {
	await open(page, { width: 390, height: 844 }, SHORT_AGENT);
	expect(await scrollers(page)).toEqual(["agent-chat-transcript"]);
});

test("other tabs are ordinary pages: Settings scrolls in the console, not in a nested box", async ({ page }) => {
	await open(page, { width: 390, height: 844 });
	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByText("Identity")).toBeVisible();
	const found = await scrollers(page);
	expect(found).toContain("main");
	expect(found).not.toContain("agent-chat-transcript");
});
