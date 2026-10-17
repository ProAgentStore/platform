import { expect, test } from "@playwright/test";

/**
 * #1129 — the coding-run ticket page at phone width (390px): the reported page with the content that
 * breaks narrow layouts — a long objective holding a path, a URL and a session id with no spaces, a
 * long task URL, a commit artifact — and the page's controls sized to be tapped.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Repo Coder", status: "active", slug: "repo-coder", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["coding"], runtime: "coding", workflow: null } };
const OBJECTIVE =
	"Implement GitHub issue #1129 in HeartFull-online/platform: workers/api/src/lib/very/long/path/to/some/deeply/nested/module-with-a-long-name.ts and https://github.com/HeartFull-online/platform/issues/1129#issuecomment-6240473632 then csess_3b310a48-f90a-47e1-934b-352385e7ab6e-7abd4b5c-0bdf-4dc3-8470-3ddc40c8f9c7";
const COMMIT = "5dd541e4bb4b5c793f32600104a398fea31f167a";

test.describe("the coding-run ticket page on a phone (#1129)", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.addInitScript(() => window.localStorage.setItem("pags:session", "test-pags-token"));
		await page.route(`${API}/**`, async (route) => {
			const path = new URL(route.request().url()).pathname;
			const json = (d: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(d) });
			if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
			if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
			if (path === "/v1/instances/inst-1/tasks/t1") {
				return json({ id: "t1", type: "coding.session", title: "Coding: HeartFull-online/platform", status: "running", createdAt: "2026-10-17T00:00:00Z", description: OBJECTIVE, reasoning: OBJECTIVE, input: { url: "https://github.com/HeartFull-online/platform/issues/1129?very=long&query=string&with=many&parameters=that&never=break" } });
			}
			if (path === "/v1/instances/inst-1/task-events") return json({ events: [{ id: "e1", taskId: "t1", type: "agent.decision", createdAt: "2026-10-17T00:01:00Z", message: OBJECTIVE, data: { thought: OBJECTIVE } }] });
			if (path === "/v1/instances/inst-1/tasks/t1/thread") return json({ turns: [{ id: "a1", role: "assistant", text: OBJECTIVE, at: "2026-10-17T00:02:00Z" }] });
			if (path === "/v1/instances/inst-1/tasks/t1/actions") {
				return json({ entries: [{ id: "x1", ts: "2026-10-17T00:01:30Z", actor: "coding-engine", instanceId: "inst-1", actionType: "checkpoint", summary: `Coding run started — ${OBJECTIVE}`, status: "running", artifacts: [{ kind: "commit", label: COMMIT, url: `https://github.com/HeartFull-online/platform/commit/${COMMIT}` }] }], hasMore: false, nextCursor: null, tail: "x1", total: 1 });
			}
			if (path.endsWith("/browser-takeovers")) return json({ takeovers: [] });
			if (path.endsWith("/browser-artifacts")) return json({ artifacts: [] });
			return json({});
		});
		await page.goto("/console/instances/inst-1/tasks/t1");
		await expect(page.getByText("Action log — each step, in order")).toBeVisible();
	});

	test("mobile — nothing scrolls sideways: every long objective, URL and id wraps inside the screen", async ({ page }) => {
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		const outside = await page.evaluate(() =>
			Array.from(document.querySelectorAll("body *"))
				.map((el) => el.getBoundingClientRect())
				.filter((r) => r.width > 0 && (r.right > 391 || r.left < -1)).length,
		);
		expect(outside).toBe(0);
		await expect(page.getByText("No screenshots for this run yet")).toBeVisible();
	});

	test("mobile — the page's controls are tap-sized: Back, Ask, the action log's commit link", async ({ page }) => {
		const height = async (name: string, role: "button" | "link") => (await page.getByRole(role, { name, exact: true }).boundingBox())?.height ?? 0;
		expect(await height("Back", "button")).toBeGreaterThanOrEqual(44);
		expect(await height("Ask", "button")).toBeGreaterThanOrEqual(40);
		expect(await height(COMMIT, "link")).toBeGreaterThanOrEqual(44);
		// The header bell's tap area reaches past its 18px icon: a tap 6px above it still lands on the link.
		const bell = await page.getByTitle("Notifications").boundingBox();
		const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("a")?.getAttribute("title") ?? null, [bell ? bell.x + bell.width / 2 : 0, bell ? bell.y - 6 : 0]);
		expect(hit).toBe("Notifications");
	});

	test("mobile — an activity row puts its time above the message, so the message gets the screen's width", async ({ page }) => {
		const row = page.locator("div", { has: page.getByText("Activity — everything the agent did") }).last();
		const stamp = row.locator("span.font-mono").first(); // the time, whatever the locale prints
		const stampBox = await stamp.boundingBox();
		const messageBox = await row.getByText(/Implement GitHub issue #1129/).first().boundingBox();
		expect(stampBox && messageBox && messageBox.y >= stampBox.y + stampBox.height - 1).toBe(true);
		expect(messageBox?.width ?? 0).toBeGreaterThan(280);
	});
});
