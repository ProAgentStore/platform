import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1304, #1596 — Settings help documents. The inherited operator manual is one collapsed line until Show is pressed; the
 * connection guide is a Copy button that fetches only when pressed and is shown only if the clipboard refuses. #1304's rule
 * still holds for whatever is shown: no capped box with a scrollbar of its own, no sideways overflow. Routes are stubbed and
 * nothing is saved.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Repo Coder", status: "active", slug: "repo-coder", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } };
const INHERITED = Array.from({ length: 100 }, (_, n) => `Manual line ${n + 1}: checkouts are home-relative and delivery goes straight to main.`).join("\n");
const GUIDE = Array.from({ length: 100 }, (_, n) => `Guide line ${n + 1}: paste this into the assistant's system instructions. ${"x".repeat(n === 50 ? 300 : 0)}`).join("\n");

type Opts = { size?: { width: number; height: number }; guideDelay?: number; guideStatus?: number; clipboard?: "reject" };

async function open(page: Page, opts: Opts = {}) {
	await page.setViewportSize(opts.size ?? { width: 390, height: 844 });
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	if (opts.clipboard === "reject") {
		await page.addInitScript(() => {
			const reject = () => Promise.reject(new Error("denied"));
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: reject, writeText: reject, readText: () => Promise.resolve("") } });
		});
	}
	const guideRequests: string[] = [];
	await page.route(`${API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/operator-manual") return json({ manual: "", account: INHERITED, inherited: INHERITED, sections: { account: INHERITED, inherited: INHERITED, instance: null }, combined: "", rules: "", context: "" });
		if (path === "/v1/instances/inst-1/connection-guide") {
			guideRequests.push(path);
			if (opts.guideDelay) await new Promise((r) => setTimeout(r, opts.guideDelay));
			return opts.guideStatus ? json({ error: "boom" }, opts.guideStatus) : json({ guide: GUIDE });
		}
		if (path === "/v1/instances/inst-1/po-triage/reports") return json({ settings: null, triggers: [], reports: [] });
		if (path === "/v1/instances/inst-1/coder-questions") return json({ settings: null, questions: [] });
		if (path === "/v1/instances/inst-1/auto-pickup") return json({ settings: null, builtinExcludeLabels: [], activeWhenQueueEmpties: "auto_pickup", recent: [] });
		if (path === "/v1/instances/inst-1/coding/engine-choice") return json({ defaultEngineId: "claude", engines: [{ id: "claude", label: "Claude Code", command: "claude", clientType: "claude", model: null, modelSelectable: true, suggestions: [] }], lastObserved: null, appliesTo: "" });
		if (path === "/v1/triggers") return json({ triggers: [] });
		if (path === "/v1/triggers/actions") return json({ actions: [] });
		if (path === "/v1/triggers/preview") return json({ schedule: null, timezone: null, jitterMinutes: null, runs: [], issues: [], error: null });
		return json({});
	});
	await page.goto("/console/instances/inst-1/settings?subtab=instructions");
	await expect(page.getByTestId("operator-manual-inherited-toggle")).toBeVisible();
	await expect(page.getByRole("button", { name: "Copy guide" })).toBeVisible();
	return { guideRequests };
}

test("first render: one collapsed line, the editor, then the Copy guide row; no document is shown and no guide is fetched", async ({ page }) => {
	const { guideRequests } = await open(page);
	await expect(page.getByTestId("operator-manual-inherited-toggle")).toHaveText("Also follows your account manual and this agent's template manual · Show");
	await expect(page.getByTestId("operator-manual-inherited-toggle")).toHaveAttribute("aria-expanded", "false");
	await expect(page.locator("pre")).toHaveCount(0);
	const y = (id: string) => page.getByTestId(id).evaluate((el) => el.getBoundingClientRect().top);
	const toggle = await y("operator-manual-inherited-toggle");
	const editor = await page.getByRole("textbox", { name: "This instance's operator manual" }).evaluate((el) => el.getBoundingClientRect().top);
	const guide = await page.getByRole("button", { name: "Copy guide" }).evaluate((el) => el.getBoundingClientRect().top);
	expect(toggle).toBeLessThan(editor);
	expect(editor).toBeLessThan(guide);
	await page.waitForTimeout(300);
	expect(guideRequests).toHaveLength(0);
});

test("one press fetches once and copies the full guide; a second press while pending is ignored", async ({ page, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const { guideRequests } = await open(page, { guideDelay: 600 });
	const button = page.getByRole("button", { name: "Copy guide" });
	await button.click();
	await expect(page.getByRole("button", { name: "Copying…" })).toBeDisabled();
	await page.getByRole("button", { name: "Copying…" }).click({ force: true }).catch(() => {});
	await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
	expect(guideRequests).toHaveLength(1);
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(GUIDE);
	await expect(page.locator("pre")).toHaveCount(0);
});

test("a clipboard failure shows the guide in a pre with a message", async ({ page }) => {
	await open(page, { clipboard: "reject" });
	await page.getByRole("button", { name: "Copy guide" }).click();
	const fallback = page.getByTestId("connection-guide-fallback");
	await expect(fallback).toContainText("Couldn't copy automatically");
	await expect(fallback.locator("pre")).toContainText("Guide line 100:");
});

test("a fetch failure shows the load-failed state, not the fallback", async ({ page }) => {
	await open(page, { guideStatus: 500 });
	await page.getByRole("button", { name: "Copy guide" }).click();
	await expect(page.getByTestId("connection-guide-load-failed")).toBeVisible();
	await expect(page.getByTestId("connection-guide-fallback")).toHaveCount(0);
});

/** Scrollers that are not the tab/page container: any <pre> with a vertical scrollbar of its own. */
const docScrollers = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLElement>("pre"))
			.filter((el) => {
				const oy = getComputedStyle(el).overflowY;
				return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
			})
			.map((el) => el.closest("[data-testid]")?.getAttribute("data-testid") ?? "pre"),
	);

for (const width of [320, 375, 390]) {
	test(`mobile — ${width}px — with Show pressed and a long guide shown, nothing overflows sideways, no document has a scrollbar of its own, and every control is at least 24px`, async ({ page }) => {
		await open(page, { size: { width, height: 844 }, clipboard: "reject" });
		await page.getByTestId("operator-manual-inherited-toggle").click();
		await page.getByRole("button", { name: "Copy guide" }).click();
		await expect(page.getByTestId("operator-manual-account")).toContainText("Manual line 100:");
		await expect(page.getByTestId("connection-guide-fallback").locator("pre")).toContainText("Guide line 100:");
		expect(await docScrollers(page)).toEqual([]);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
		const m = await page.evaluate(() => {
			const vw = window.innerWidth;
			const boxes = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="operator-manual"], [data-testid="settings-section-connection-guide"]'));
			const past: string[] = [];
			const small: string[] = [];
			for (const root of boxes) {
				for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
					if (el.closest("pre")) continue;
					const r = el.getBoundingClientRect();
					if (r.width && r.right > vw + 1) past.push(`${el.tagName}.${el.className}`);
				}
				for (const b of Array.from(root.querySelectorAll<HTMLElement>("button, a, textarea"))) {
					const r = b.getBoundingClientRect();
					if (Math.min(r.width, r.height) < 24) small.push(`${b.textContent?.slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`);
				}
			}
			return { cards: boxes.length, past, small };
		});
		expect(m.cards).toBe(2);
		expect(m.past).toEqual([]);
		expect(m.small).toEqual([]);
	});
}
