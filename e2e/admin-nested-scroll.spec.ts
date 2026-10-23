import { type Page, expect, test } from "@playwright/test";

/**
 * #1309 — the admin portal's long read-only blocks (an error context, a trace context, a terminal tail, a
 * coding-session timeline entry) used to be capped at 224–288px with their own vertical scrollbar, inside
 * a page that scrolls. A wheel over the block moved the block, then the page: two owners of one gesture.
 * The cap is gone; the block grows into the page and the page is the only vertical scroller.
 *
 * Nothing real is reached: every API call is intercepted, and the session token is a literal.
 *
 * Non-vacuous on purpose. A page that never painted would trivially have "no nested scroller", so each
 * case first proves the long block is present, tall (taller than the old cap), and inside a document that
 * itself scrolls — and only then that no block scrolls on its own. Checked at desktop and phone widths.
 */
const API = "/admin/api";
const apiPath = (url: string) => new URL(url).pathname.slice(API.length);
const TEST_TOKEN = "test-pags-admin-token";
const LONG = Array.from({ length: 80 }, (_, i) => `line ${String(i).padStart(2, "0")} ${"x".repeat(60)}`).join("\n");
const LONG_JSON = JSON.stringify({ detail: Array.from({ length: 60 }, (_, i) => `entry ${i} ${"y".repeat(50)}`) });

async function mock(page: Page) {
	await page.addInitScript((token) => window.localStorage.setItem("pags:session", token), TEST_TOKEN);
	await page.route("https://api.proagentstore.online/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
	await page.route(`${API}/**`, async (route) => {
		const path = apiPath(route.request().url());
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/admin/me") return json({ admin: true });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "operator" });
		if (path === "/v1/admin/errors/summary") {
			return json({ signatures: [{ key: "sig-1", source: "api", sample: "boom happened", pattern: "boom happened", count: 3, users: 1, firstSeen: "2026-07-01T00:00:00Z", lastSeen: "2026-07-08T00:00:00Z", lastStatus: 500, lastId: "e-0" }] });
		}
		if (path === "/v1/admin/errors") {
			return json({ errors: Array.from({ length: 3 }, (_, i) => ({ id: `e-${i}`, created_at: "2026-07-08T00:00:00Z", user_id: "user-2", source: "api", status: 500, message: "boom happened", context: LONG_JSON, last_context: LONG_JSON, repeat_count: 2, last_seen_at: "2026-07-08T01:00:00Z" })) });
		}
		if (path.startsWith("/v1/admin/trace/")) {
			return json({ events: Array.from({ length: 4 }, (_, i) => ({ id: `t-${i}`, ts: 1786000000 + i, created_at: "2026-07-08T00:00:00Z", user_id: "user-2", instance_id: "i-1", trace_id: "trace-1", source: "chat", level: "info", event: "tool.call", message: `step ${i}`, context: LONG_JSON })) });
		}
		if (path === "/v1/admin/terminals") {
			return json({
				nodes: [
					{ node: "mac-1", ownerLogin: "operator", runnerVersion: "1.0.0", lastSeenAt: "2026-07-08T00:00:00Z", connected: true, instances: [], sessions: Array.from({ length: 4 }, (_, i) => ({ sessionId: `s-${i}`, repoName: "app", engine: "claude", status: "running", updatedAt: "2026-07-08T00:00:00Z", terminalTail: LONG })) },
				],
			});
		}
		if (path.startsWith("/v1/admin/coding-sessions/")) {
			return json({
				session: { id: "s-1", instanceId: "i-1", repoId: "r-1", userId: "user-2", runnerNode: "mac-1", engine: "claude", status: "running", issueNumber: 1, issueTitle: "t", launchCommand: "claude", startedAt: "2026-07-08T00:00:00Z", updatedAt: "2026-07-08T00:00:00Z", repoName: "app", ownerLogin: "operator" },
				timeline: Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, type: "output", content: LONG, createdAt: "2026-07-08T00:00:00Z" })),
			});
		}
		return json({});
	});
}

const CASES: Array<{ name: string; route: string; open?: (page: Page) => Promise<void> }> = [
	{ name: "error signature occurrences", route: "/admin/errors/sig-1", open: async (p) => { while (await p.getByRole("button", { name: /Show context/ }).count()) await p.getByRole("button", { name: /Show context/ }).first().click(); } },
	{ name: "instance trace", route: "/admin/instances/i-1/trace", open: async (p) => { for (const b of await p.getByRole("button", { name: /^step \d/ }).all()) await b.click(); } },
	{ name: "terminals", route: "/admin/terminals" },
	{ name: "coding session timeline", route: "/admin/coding-sessions/s-1" },
];
const OLD_CAP = 224; // the shortest cap this replaced (max-h-56)

for (const [label, size] of [["desktop 1440x900", { width: 1440, height: 900 }], ["phone 390x844", { width: 390, height: 844 }]] as const) {
	test.describe(`admin long blocks flow in the page (#1309) — ${label}`, () => {
		for (const c of CASES) {
			test(`${c.name}: no block scrolls on its own; the document is the only vertical scroller`, async ({ page }) => {
				await page.setViewportSize(size);
				await mock(page);
				await page.goto(c.route);
				await page.waitForLoadState("networkidle");
				await page.locator("main").waitFor();
				await c.open?.(page);

				const m = await page.evaluate(() => {
					const pres = [...document.querySelectorAll("main pre")] as HTMLElement[];
					const doc = document.scrollingElement as HTMLElement;
					return {
						count: pres.length,
						// Only the long blocks: a short launch command in the same page is not what the cap was about.
						heights: pres.filter((p) => (p.textContent ?? "").length > 1000).map((p) => p.getBoundingClientRect().height),
						// A block owns a scroll gesture iff its content is taller than its box.
						nested: pres.filter((p) => p.scrollHeight - p.clientHeight > 1).length,
						docScrolls: doc.scrollHeight > window.innerHeight + 1,
						text: pres.map((p) => p.textContent ?? "").join("\n"),
					};
				});

				// Non-vacuity: the long blocks painted, are taller than the old cap, and the page itself is long.
				expect(m.heights.length).toBeGreaterThanOrEqual(2);
				expect(Math.min(...m.heights)).toBeGreaterThan(OLD_CAP);
				expect(m.docScrolls).toBe(true);
				// Nothing was clipped or dropped to get there.
				expect(m.text).toMatch(/line 79|entry 59/);
				// The point.
				expect(m.nested).toBe(0);

				// Wheel ownership: scrolling over a block moves the page, never the block.
				const first = page.locator("main pre").first();
				await first.scrollIntoViewIfNeeded();
				const box = await first.boundingBox();
				if (!box) throw new Error("no box");
				const before = await page.evaluate(() => window.scrollY);
				await page.mouse.move(box.x + 10, Math.min(box.y + 20, size.height - 20));
				await page.mouse.wheel(0, 120);
				await page.waitForTimeout(150);
				const after = await page.evaluate(() => ({ y: window.scrollY, inner: (document.querySelector("main pre") as HTMLElement).scrollTop }));
				expect(after.inner).toBe(0);
				expect(after.y).toBeGreaterThanOrEqual(before);
			});
		}
	});
}
