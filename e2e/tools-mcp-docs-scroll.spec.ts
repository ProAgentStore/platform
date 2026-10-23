import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1303 — Tools → "What your MCP clients are told": each expanded document used to be a 192px-capped box with its own vertical
 * scrollbar inside the console's scrolling <main>. Geometry is measured in a real browser with long synthetic documents; the
 * surface endpoint is stubbed and nothing is sent anywhere.
 */
const API = "https://api.proagentstore.online";
const INSTRUCTIONS = Array.from({ length: 60 }, (_, n) => `Instruction line ${n + 1}: use platform_guide before any other tool, and ask before anything destructive.`).join("\n");
const GUIDE = Array.from({ length: 80 }, (_, n) => `Guide line ${n + 1}: task-to-tool map entry with enough words to wrap on a narrow phone screen.`).join("\n");

async function open(page: Page, size: { width: number; height: number }) {
	await page.setViewportSize(size);
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	await page.route("https://mcp.proagentstore.online/surface", (route) =>
		route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ version: "1.2.3", toolCount: 42, instructions: INSTRUCTIONS, guide: GUIDE }) }),
	);
	await page.route(`${API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [] });
		if (path === "/v1/notifications") return json({ notifications: [], unreadCount: 0 });
		return json({});
	});
	await page.goto("/console/tools");
	await page.getByRole("button", { name: /What your MCP clients are told/ }).click();
	await expect(page.getByText("Instruction line 60:")).toBeAttached();
	await expect(page.getByText("Guide line 80:")).toBeAttached();
}

const scrollers = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLElement>("*"))
			.filter((el) => {
				const oy = getComputedStyle(el).overflowY;
				return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
			})
			.map((el) => el.tagName.toLowerCase()),
	);

for (const size of [
	{ name: "phone 390×844", width: 390, height: 844 },
	{ name: "small phone 320×568", width: 320, height: 568 },
	{ name: "desktop 1366×768", width: 1366, height: 768 },
]) {
	test(`${size.name} — both documents flow in the page: no scroller but the console's own`, async ({ page }) => {
		await open(page, size);
		const found = await scrollers(page);
		expect(found).toEqual(["main"]); // before: ["main", "pre", "pre"]
		for (const pre of await page.locator("pre").all()) {
			const box = await pre.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
			expect(box.scroll).toBeLessThanOrEqual(box.client + 1);
			expect(box.client).toBeGreaterThan(192); // the whole document is shown, not a 192px window
		}
	});
}

test("every line of both documents is still there, and Copy still works for each", async ({ page }) => {
	await open(page, { width: 390, height: 844 });
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
	const pres = page.locator("pre");
	await expect(pres).toHaveCount(2);
	expect(await pres.nth(0).innerText()).toContain("Instruction line 1:");
	expect(await pres.nth(0).innerText()).toContain("Instruction line 60:");
	expect(await pres.nth(1).innerText()).toContain("Guide line 80:");
	const copies = page.getByRole("button", { name: "Copy", exact: true });
	await copies.nth(1).click();
	await expect(page.getByRole("button", { name: "Copied" })).toHaveCount(1);
});

test("the page reaches the end of the second document by scrolling the one page", async ({ page }) => {
	await open(page, { width: 390, height: 844 });
	await page.getByText("Guide line 80:").scrollIntoViewIfNeeded();
	await expect(page.getByText("Guide line 80:")).toBeInViewport();
});
