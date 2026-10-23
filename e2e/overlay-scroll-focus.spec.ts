import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * #1308 — a modal overlay owes the page behind it: that page must not scroll (End / PageDown with the
 * opener focused used to move the tab or <main> under the scrim), keyboard focus must be INSIDE the
 * dialog, and closing must hand back both the scroll position and the focus. Routes are stubbed with
 * synthetic data; nothing is uploaded, downloaded, saved or submitted.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Notes Agent", status: "active", slug: "notes-agent", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["chat", "knowledge"], runtime: null, workflow: null } };
const LONG_TEXT = Array.from({ length: 400 }, (_, n) => `Synthetic preview line ${n + 1}`).join("\n");
const FILES = [
	{ id: "file-long", name: "long-notes.txt", mimeType: "text/plain", size: LONG_TEXT.length },
	...Array.from({ length: 40 }, (_, n) => ({ id: `file-${n}`, name: `filler-${n}.txt`, mimeType: "text/plain", size: 10 })),
];
const MESSAGES = Array.from({ length: 30 }, (_, n) => ({ id: `m${n}`, role: n % 2 ? "user" : "assistant", content: `Synthetic message ${n + 1}. `.repeat(12), createdAt: "2026-10-23T00:00:00Z" }));

async function mock(page: Page, instances: unknown[] = [INSTANCE]) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	const writes: string[] = [];
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		if (req.method() !== "GET") writes.push(`${req.method()} ${path}`);
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances });
		if (path === "/v1/instances/inst-1/files") return json({ files: FILES });
		if (path === "/v1/instances/inst-1/files/file-long") return route.fulfill({ status: 200, contentType: "text/plain", body: LONG_TEXT });
		if (path === "/v1/instances/inst-1/messages") return json({ messages: MESSAGES, hasMore: false });
		if (path === "/v1/notifications") return json({ notifications: [], unreadCount: 0 });
		if (path === "/v1/connectors") return json({ connectors: [] });
		return json({});
	});
	return { writes };
}

/**
 * Scroll every overflowing container around the opener to 150px and tag it, so there is a position to
 * lose and the SAME elements can be read while they are frozen (a locked container no longer matches
 * an "overflow: auto" search).
 */
const scrollBackground = (opener: Locator) =>
	opener.evaluate((node) => {
		let n = 0;
		for (let el = node.parentElement; el; el = el.parentElement) {
			if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) {
				el.scrollTop = 150;
				el.setAttribute("data-e2e-owner", String(n++));
			}
		}
		return n;
	});

/** Where each tagged container is scrolled to, plus the document's own scroller. */
const ownerTops = (page: Page) =>
	page.evaluate(() => [...document.querySelectorAll("[data-e2e-owner]")].map((el) => el.scrollTop).concat(document.scrollingElement?.scrollTop ?? 0));

const insideDialog = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));

/**
 * The contract, for any overlay: scroll the page behind to a known place, open the overlay from its
 * opener, and show that End / PageDown leave the page where it was, focus is inside, Tab stays inside,
 * and closing gives back the position and the focus. Returns the dialog for overlay-specific checks.
 */
async function exerciseOverlay(page: Page, opener: Locator, close: (dialog: Locator) => Promise<void>) {
	expect(await scrollBackground(opener)).toBeGreaterThan(0);
	const restored = await ownerTops(page);
	expect(restored[0]).toBe(150);
	// Not `.click()`/`.focus()`: Playwright and the browser scroll the opener back into view, which
	// is itself a scroll of the background and would hide what this test is about.
	await opener.evaluate((el) => { el.setAttribute("data-e2e-opener", "1"); (el as HTMLElement).focus({ preventScroll: true }); });
	await opener.dispatchEvent("click");
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	expect(await insideDialog(page)).toBe(true);
	expect(await ownerTops(page)).toEqual(restored);

	await page.keyboard.press("End");
	await page.keyboard.press("PageDown");
	expect(await ownerTops(page)).toEqual(restored);

	for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
	expect(await insideDialog(page)).toBe(true); // Tab wraps inside; it never reaches the page behind.
	await page.keyboard.press("End");
	expect(await ownerTops(page)).toEqual(restored);

	await close(dialog);
	await expect(dialog).toHaveCount(0);
	expect(await ownerTops(page)).toEqual(restored);
	await expect(opener).toBeFocused();
	expect(await page.evaluate(() => document.querySelectorAll("[data-e2e-owner]").length)).toBeGreaterThan(0);
	expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-e2e-owner]")].map((el) => el.style.overflow + el.style.paddingRight).join(""))).toBe("");
}

const openFilesTab = async (page: Page) => {
	await page.goto("/console/instances/inst-1/knowledge?subtab=files");
	const opener = page.getByRole("button", { name: /^Preview/ }).first();
	await expect(opener).toBeVisible();
	return opener;
};

for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 600 }]) {
	test.describe(`file preview (${viewport.name})`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } });

		test("End leaves the background where it was, focus is inside, and closing restores both", async ({ page }) => {
			const { writes } = await mock(page);
			const opener = await openFilesTab(page);
			await exerciseOverlay(page, opener, async (dialog) => {
				await expect(dialog.locator("pre")).toContainText("Synthetic preview line 400");
				await dialog.getByRole("button", { name: "Close preview" }).click();
			});
			expect(writes.filter((w) => !w.endsWith("/v1/preferences"))).toEqual([]);
		});
	});
}

test.describe("feedback composer (desktop)", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("the chat behind it stays put, focus is inside, the typed words survive, and nothing is submitted", async ({ page }) => {
		const { writes } = await mock(page);
		await page.goto("/console/instances/inst-1");
		const opener = page.locator('[data-msg-action="feedback"]').nth(10);
		await expect(opener).toBeAttached();
		await exerciseOverlay(page, opener, async (dialog) => {
			await dialog.getByRole("textbox", { name: "What went wrong" }).fill("synthetic words");
			await page.keyboard.press("End"); // a scrollable textarea is not the defect; typing and End still work inside.
			await expect(dialog.getByRole("textbox", { name: "What went wrong" })).toHaveValue("synthetic words");
			await dialog.getByRole("button", { name: "Cancel" }).click();
		});
		expect(writes.filter((w) => !w.endsWith("/v1/preferences"))).toEqual([]);
	});
});

test.describe("two overlays in sequence (desktop)", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("each open/close restores the original lock state, not the previous overlay's", async ({ page }) => {
		await mock(page);
		const opener = await openFilesTab(page);
		const settle = (dialog: Locator) => dialog.getByRole("button", { name: "Close preview" }).click();
		await exerciseOverlay(page, opener, settle);
		await exerciseOverlay(page, opener, settle);
		// Nothing is left frozen after the second close: the page scrolls again.
		await opener.evaluate((node) => {
			for (let el = node.parentElement; el; el = el.parentElement) if (el.hasAttribute("data-e2e-owner")) el.scrollTop = 40;
		});
		expect((await ownerTops(page))[0]).toBe(40);
	});
});

const REPOS = Array.from({ length: 25 }, (_, n) => ({ id: `repo-${n}`, name: `synthetic-repo-${n}`, githubRepo: `Example/synthetic-repo-${n}`, provider: "github", cloneStatus: "ready" }));
const CODER = { id: "inst-coder", agent_id: "agent-coder", name: "Repo Coder", status: "active", slug: "repo-coder", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } };

test.describe("coder dialogs (desktop and mobile)", () => {
	for (const viewport of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 390, height: 700 }]) {
		for (const dialogCase of [
			{ name: "Repo settings", opener: "Repo settings" as string | RegExp },
			{ name: "CLI engines", opener: /engines/i },
		]) {
			test(`${dialogCase.name} (${viewport.name}) locks the repo list and gives focus back`, async ({ page }) => {
				await page.setViewportSize({ width: viewport.width, height: viewport.height });
				const { writes } = await mock(page, [CODER]);
				await page.route(`${API}/v1/instances/inst-coder/**`, async (route) => {
					const url = route.request().url();
					const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
					if (route.request().method() !== "GET") writes.push(`${route.request().method()} ${new URL(url).pathname}`);
					if (url.includes("/repos")) return json({ repos: REPOS });
					if (url.includes("/engines")) return json({ engines: [{ id: "claude", label: "Claude Code", command: "claude", clientType: "claude" }], defaultEngineId: "claude" });
					if (url.includes("/sessions")) return json({ sessions: [] });
					if (url.includes("/loop-presets")) return json({ presets: [] });
					return json({});
				});
				await page.goto("/console/instances/inst-coder/coding");
				await expect(page.getByText("synthetic-repo-24")).toBeAttached();
				const opener = page.getByRole("button", { name: dialogCase.opener }).first();
				await expect(opener).toBeVisible();
				await exerciseOverlay(page, opener, async (dialog) => {
					await dialog.getByRole("button", { name: /^✕$|Close/ }).first().click();
				});
				expect(writes.filter((w) => !w.endsWith("/v1/preferences"))).toEqual([]);
			});
		}
	}
});
