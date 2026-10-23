import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1310 — the public agent page's trial Chat used to be a fixed 520/470/430px box with its own scrolling
 * transcript inside the scrolling detail page: two vertical scrollbars, two owners of one wheel. The
 * transcript now flows in the page and the composer sticks to the bottom edge, so the page is the only
 * vertical scroller and the input stays reachable. Measured in a real browser with a long conversation
 * driven through the real send path; every API call is intercepted and nothing leaves the machine.
 */
const API = "https://api.proagentstore.online";
const AGENT = { id: "agent-1", name: "Notes", slug: "notes", description: "Short.", category: "productivity", visibility: "published", model: "", icon_bg: "#7c3aed", store_type: "agent", created_at: "2026-07-01T00:00:00Z", subscriber_count: 2 };
const REPLY = "A long synthetic reply that keeps going so the transcript outgrows any fixed box. ".repeat(12);

async function open(page: Page, size: { width: number; height: number }) {
	await page.setViewportSize(size);
	const sent: string[] = [];
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/public/agents/notes") return json(AGENT);
		if (path === "/v1/public/agents/notes/try") {
			sent.push(String((req.postDataJSON() as { message?: string }).message));
			return json({ sessionId: "s1", message: { content: REPLY } });
		}
		return json({}, 404);
	});
	await page.route("https://mcp.proagentstore.online/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
	await page.goto("/agents/notes");
	await page.locator("#content").waitFor({ state: "visible" });
	await page.locator('.tab[data-tab="chat"]').click();
	for (let i = 1; i <= 8; i++) {
		await page.locator("#chat-input").fill(`question ${i}`);
		await page.locator("#chat-form button").click();
		await expect(page.locator("#chat-msgs .msg.assistant")).toHaveCount(i + 1); // the greeting + i replies
	}
	return sent;
}

/** Every element that scrolls vertically and actually has something to scroll. */
const scrollers = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLElement>("body *"))
			.filter((el) => {
				const oy = getComputedStyle(el).overflowY;
				return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
			})
			.map((el) => el.id || el.className || el.tagName.toLowerCase()),
	);

const SIZES = [
	{ name: "desktop 1440x900", width: 1440, height: 900 },
	{ name: "tablet 820x1100", width: 820, height: 1100 },
	{ name: "phone 390x844", width: 390, height: 844 },
	{ name: "landscape phone 844x390", width: 844, height: 390 },
];

for (const size of SIZES) {
	test.describe(`public trial Chat has one vertical scroller (#1310) — ${size.name}`, () => {
		test("the transcript flows in the page; the page is the only scroller", async ({ page }) => {
			const sent = await open(page, size);
			expect(sent).toHaveLength(8);

			const m = await page.evaluate(() => {
				const t = document.getElementById("chat-msgs") as HTMLElement;
				const doc = document.scrollingElement as HTMLElement;
				return { transcriptHeight: t.getBoundingClientRect().height, transcriptOverflow: t.scrollHeight - t.clientHeight, docScrolls: doc.scrollHeight > window.innerHeight + 1, count: t.querySelectorAll(".msg").length, last: t.querySelector(".msg.assistant:last-child")?.textContent?.length ?? 0 };
			});
			// Non-vacuity: a conversation taller than the old fixed 430-520px box, in a page that scrolls.
			expect(m.transcriptHeight).toBeGreaterThan(520);
			expect(m.docScrolls).toBe(true);
			// Nothing was dropped to get there: the greeting, 8 questions and 8 replies.
			expect(m.count).toBe(17);
			expect(m.last).toBeGreaterThan(500);
			// The point: the transcript owns no scroll, and nothing else on the page does either.
			expect(m.transcriptOverflow).toBeLessThanOrEqual(1);
			expect(await scrollers(page)).toEqual([]);
		});

		test("a wheel over the transcript moves the page, never the transcript", async ({ page }) => {
			await open(page, size);
			await page.evaluate(() => window.scrollTo(0, 0));
			const box = await page.locator("#chat-msgs").boundingBox();
			if (!box) throw new Error("no transcript box");
			await page.mouse.move(box.x + 20, Math.min(Math.max(box.y, 0) + 40, size.height - 20));
			await page.mouse.wheel(0, 150);
			await page.waitForTimeout(200);
			const after = await page.evaluate(() => ({ y: window.scrollY, inner: (document.getElementById("chat-msgs") as HTMLElement).scrollTop }));
			expect(after.inner).toBe(0);
			expect(after.y).toBeGreaterThan(0);
		});

		test("the composer stays on screen over a long transcript, and the newest reply is in view after sending", async ({ page }) => {
			await open(page, size);
			const inView = await page.evaluate(() => {
				const r = (document.getElementById("chat-input") as HTMLElement).getBoundingClientRect();
				const newest = (document.querySelector("#chat-msgs .msg:last-child") as HTMLElement).getBoundingClientRect();
				return { inputVisible: r.top >= 0 && r.bottom <= window.innerHeight, newestVisible: newest.bottom > 0 && newest.top < window.innerHeight };
			});
			expect(inView).toEqual({ inputVisible: true, newestVisible: true });
			// Reading from the top of the conversation: the chat's first message is at the viewport's top edge.
			await page.evaluate(() => (document.querySelector(".chat") as HTMLElement).scrollIntoView({ block: "start" }));
			const atTop = await page.evaluate(() => {
				const r = (document.getElementById("chat-input") as HTMLElement).getBoundingClientRect();
				return r.top >= 0 && r.bottom <= window.innerHeight;
			});
			expect(atTop).toBe(true); // sticky: reachable wherever in the transcript the reader is (once the chat is on screen)
		});

		test("the other detail tabs remain usable", async ({ page }) => {
			await open(page, size);
			await page.locator(".tab").first().click();
			await expect(page.locator(".tab.active")).toHaveCount(1);
			await expect(page.locator("#tab-chat")).toBeHidden();
			await page.locator('.tab[data-tab="chat"]').click();
			await expect(page.locator("#tab-chat")).toBeVisible();
			expect(await scrollers(page)).toEqual([]);
		});
	});
}
