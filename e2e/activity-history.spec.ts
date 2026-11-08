import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { CODING_INSTANCE, installHistoryRoutes, LAUNCH, LOCAL_BROWSER_INSTANCE, seededHistory, type HistoryMockOptions } from "./activity-history-mock";

/**
 * #1590 — Activity's History area: the panels that moved out of Settings (loop runs and queue, takeovers, last
 * browser launch, secure inputs, the delivery log) and the one-liners Settings kept. Routes are stubbed
 * (`activity-history-mock.ts`); pure ordering and parsing are vitest's (`lib/activityView.test.ts`).
 */
const API = "https://api.proagentstore.online";
const ACTIVITY = "/console/instances/inst-1/activity";
const HISTORY = `${ACTIVITY}?view=history`;

type Instance = typeof LOCAL_BROWSER_INSTANCE | typeof CODING_INSTANCE;

async function setup(page: Page, opts: { instance?: Instance; history?: HistoryMockOptions } = {}) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	const instance = opts.instance ?? LOCAL_BROWSER_INSTANCE;
	await page.route(`${API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [instance, { id: "inst-2", name: "Site Builder", slug: "site-builder", status: "active", capabilities: { surfaces: [] } }] });
		if (path === "/v1/instances/inst-1/browser-verification") return json({ settings: { enabled: true, runtime: "pinned", fallback: "wait", waitLimitMinutes: 60, takeover: "prompt", allowMobile: false }, capability: { declared: true, engine: "chrome" }, runnerNode: null, notificationEvents: [] });
		if (path === "/v1/instances/inst-1/browser-settings") {
			const effective = { mode: "headless", engine: "firefox", profile: "persistent" };
			return json({ ...effective, agentDefaults: effective, effective, launchPath: "managed", sources: { mode: "agent", engine: "instance", profile: "agent" }, requiredCli: "0.4.198", explained: "" });
		}
		if (path === "/v1/instances/inst-1/website-grants") return json({ domains: [], decisions: [] });
		if (path === "/v1/instances/inst-1/browser-screenshots") return json({ enabled: true, blurFormFields: false, explained: "" });
		if (path === "/v1/triggers") return json({ triggers: [] });
		if (path === "/v1/triggers/actions") return json({ actions: [] });
		if (path === "/v1/triggers/preview") return json({ schedule: null, timezone: null, jitterMinutes: null, runs: [], issues: [], error: null });
		// Not `{}`: the Gmail Scout section on the Agent sub-tab mounts before the instance list lands, and reads a real shape.
		return json({ error: "Not mocked" }, 404);
	});
	return installHistoryRoutes(page, opts.history ?? seededHistory());
}

const panelOrder = (page: Page) => page.locator('[data-testid^="history-panel-"]:not(:empty)').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));

test.describe("History above the timeline", () => {
	test("renders above the timeline, panels in order, the ones holding something for the owner first", async ({ page }) => {
		await setup(page);
		await page.goto(ACTIVITY);
		await expect(page.getByTestId("history-loop-runs")).toBeVisible();
		await expect(page.getByTestId("history-deliveries")).toBeVisible();
		await expect(page.getByTestId("bv-takeovers")).toBeVisible();
		await expect(page.getByTestId("browser-launch-receipt")).toBeVisible();
		await expect(page.getByTestId("secure-input-history")).toBeVisible();
		// loop-runs and takeovers both hold something for the owner, so they keep the lead; the rest follow in order.
		expect(await panelOrder(page)).toEqual(["history-panel-loop-runs", "history-panel-takeovers", "history-panel-browser-launch", "history-panel-secure-inputs", "history-panel-deliveries"]);
		const history = await page.getByTestId("activity-history").boundingBox();
		const timeline = await page.getByRole("heading", { name: "Activity", exact: true }).boundingBox();
		expect(history && timeline && history.y + history.height <= timeline.y + 1).toBe(true);
		// Plain /activity does not move the view: no scroll-to, no empty line.
		await expect(page.getByTestId("history-empty")).toHaveCount(0);
	});

	test("a panel with something for the owner moves ahead, and a needs-input run leads its list", async ({ page }) => {
		const history = seededHistory();
		history.runs = (history.runs as Array<{ status: string }>).filter((r) => r.status !== "needs_human");
		history.takeovers = (history.takeovers as Array<{ id: string }>).filter((t) => t.id === "t-consent");
		history.deliveries = [];
		await setup(page, { history });
		await page.goto(ACTIVITY);
		await expect(page.getByTestId("bv-takeovers")).toBeVisible();
		await expect(page.getByTestId("history-loop-runs")).toBeVisible();
		// Only the takeovers panel needs the owner now, so it moves in front of loop-runs.
		expect((await panelOrder(page))[0]).toBe("history-panel-takeovers");

		// And within loop-runs, with the needs-input run back, it is the first row although it is the oldest.
		await page.unroute(`${API}/**`);
		await setup(page);
		await page.goto(ACTIVITY);
		const rows = page.getByTestId("history-loop-runs").locator("> div.border");
		await expect(rows.first()).toContainText("Rotate the signing keys");
	});

	test("?view=history with nothing shows one line, never a blank area; plain /activity shows none", async ({ page }) => {
		await setup(page, { history: { runs: [], queue: [], takeovers: [], session: null, secureInputs: [], deliveries: [] } });
		await page.goto(HISTORY);
		await expect(page.getByTestId("history-empty")).toHaveText("Nothing waiting and no recent history");
		await page.goto(ACTIVITY);
		await expect(page.getByText("tool.called").or(page.getByText("Called tool: search_knowledge"))).toBeVisible();
		await expect(page.getByTestId("history-empty")).toHaveCount(0);
	});

	test("mobile — ?panel= scrolls to and focuses that panel", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 500 });
		await setup(page);
		await page.goto(`${HISTORY}&panel=deliveries`);
		await expect(page.getByTestId("history-panel-deliveries")).toBeFocused();
		await expect(page.getByTestId("history-panel-deliveries")).toBeInViewport();
	});
});

test.describe("capabilities decide which panels ask for data", () => {
	test("a coding agent makes no takeover or launch-receipt request on Activity", async ({ page }) => {
		const { requests } = await setup(page, { instance: CODING_INSTANCE });
		await page.goto(HISTORY);
		await expect(page.getByTestId("history-loop-runs")).toBeVisible();
		await expect(page.getByTestId("history-deliveries")).toBeVisible();
		expect(requests.filter((r) => /browser-takeovers|browser-settings/.test(r))).toEqual([]);
		expect(requests.some((r) => r.startsWith("GET /loop"))).toBe(true);
	});

	test("a local_browser agent asks for both", async ({ page }) => {
		const { requests } = await setup(page);
		await page.goto(HISTORY);
		await expect(page.getByTestId("bv-takeovers")).toBeVisible();
		await expect(page.getByTestId("browser-launch-receipt")).toBeVisible();
		expect(requests).toContain("GET /browser-takeovers?limit=10");
		expect(requests).toContain("GET /browser-settings/session");
	});

	test("the launch receipt renders nothing when the runner reports no launch", async ({ page }) => {
		await setup(page, { history: { ...seededHistory(), session: null } });
		await page.goto(HISTORY);
		await expect(page.getByTestId("bv-takeovers")).toBeVisible();
		await expect(page.getByTestId("browser-launch-receipt")).toHaveCount(0);
		await expect(page.getByText("No browser launch has been reported")).toHaveCount(0);
	});
});

test.describe("a failed panel", () => {
	test("shows its own LoadFailed with Retry and leaves the timeline and the other panels", async ({ page }) => {
		await setup(page, { history: { ...seededHistory(), fail: ["/browser-takeovers"] } });
		await page.goto(HISTORY);
		const failed = page.getByTestId("history-failed-takeovers");
		await expect(failed).toBeVisible();
		await expect(failed.getByRole("button", { name: "Retry" })).toBeVisible();
		await expect(page.getByTestId("history-loop-runs")).toBeVisible();
		await expect(page.getByTestId("history-deliveries")).toBeVisible();
		await expect(page.getByText("Called tool: search_knowledge")).toBeVisible();
		// It is not the empty line: a failure is not "nothing waiting".
		await expect(page.getByTestId("history-empty")).toHaveCount(0);
	});
});

test.describe("takeovers", () => {
	test("legacy /settings?takeover=<id> redirects to History with that row highlighted", async ({ page }) => {
		await setup(page);
		await page.goto("/console/instances/inst-1/settings?takeover=t-consent");
		await expect(page).toHaveURL(/\/instances\/inst-1\/activity\?view=history&takeover=t-consent/);
		await expect(page.locator('[data-testid="takeover-row"][data-highlighted="true"]')).toContainText("www.seek.com.au wants to be opened");
		await expect(page.getByTestId("takeover-not-listed")).toHaveCount(0);
	});

	test("an id that is gone lands on the takeovers panel with a notice and no error", async ({ page }) => {
		await setup(page);
		await page.goto("/console/instances/inst-1/settings?takeover=t-gone");
		await expect(page).toHaveURL(/activity\?view=history&takeover=t-gone/);
		await expect(page.getByTestId("takeover-not-listed")).toHaveText("This takeover is no longer listed");
		await expect(page.getByTestId("history-panel-takeovers")).toBeFocused();
		await expect(page.getByTestId("history-failed-takeovers")).toHaveCount(0);
		await expect(page.getByRole("alert")).toHaveCount(0);
	});

	test("the notice shows even when no takeover is listed at all", async ({ page }) => {
		await setup(page, { history: { ...seededHistory(), takeovers: [] } });
		await page.goto(`${HISTORY}&takeover=t-gone`);
		await expect(page.getByTestId("takeover-not-listed")).toBeVisible();
	});

	test("focus=permissions still redirects to Permissions", async ({ page }) => {
		await setup(page);
		await page.goto("/console/instances/inst-1/settings?focus=permissions");
		await expect(page).toHaveURL(/\/instances\/inst-1\/permissions\?focus=permissions/);
	});

	test("a live site-consent row offers Allow, which sends exactly the consent request, and Decline", async ({ page }) => {
		const { calls } = await setup(page);
		await page.goto(HISTORY);
		const row = page.getByTestId("takeover-row").filter({ hasText: "wants to be opened" });
		await expect(row).toContainText("www.seek.com.au wants to be opened");
		await expect(row.getByRole("button", { name: "Decline" })).toBeVisible();
		await row.getByRole("button", { name: "Allow" }).click();
		await expect.poll(() => calls.filter((c) => c.path === "/local-browser/consent")).toEqual([{ method: "PUT", path: "/local-browser/consent", body: { scope: "navigate", domain: "www.seek.com.au", decision: "allow" } }]);
		// The panel refreshed: the verification pass closed it, so it no longer offers Allow.
		await expect(page.getByRole("button", { name: "Allow" })).toHaveCount(0);
	});

	test("Decline moves a live takeover to ended", async ({ page }) => {
		const { calls } = await setup(page);
		await page.goto(HISTORY);
		await page.getByTestId("takeover-row").filter({ hasText: "wants to be opened" }).getByRole("button", { name: "Decline" }).click();
		await expect.poll(() => calls.filter((c) => c.method === "PATCH")).toEqual([{ method: "PATCH", path: "/browser-takeovers/t-consent", body: { state: "ended" } }]);
		await expect(page.getByRole("button", { name: "Decline" })).toHaveCount(0);
	});

	test("a live takeover is listed before an ended one", async ({ page }) => {
		await setup(page);
		await page.goto(HISTORY);
		const rows = page.getByTestId("takeover-row");
		await expect(rows.first()).toContainText("wants to be opened");
		await expect(rows.last()).toContainText("Takeover ended");
	});
});

test.describe("loop runs and the queue keep their controls", () => {
	test("Stop cancels the run and the row reads Stopping…", async ({ page }) => {
		const { calls } = await setup(page);
		await page.goto(HISTORY);
		const row = page.getByTestId("history-loop-runs").locator("div.border", { hasText: "Ship the docs" }).first();
		await row.getByRole("button", { name: "Stop", exact: true }).click();
		await expect.poll(() => calls.map((c) => `${c.method} ${c.path}`)).toContain("POST /loop/run-live/cancel");
		await expect(row.getByRole("button", { name: "Stopping…" })).toBeDisabled();
	});

	test("Continue starts a new run on a run that hit its step limit", async ({ page }) => {
		const { calls } = await setup(page);
		await page.goto(HISTORY);
		const row = page.getByTestId("history-loop-runs").locator("div.border", { hasText: "Migrate the schema" }).first();
		await row.getByRole("button", { name: "Continue" }).click();
		await expect.poll(() => calls.map((c) => `${c.method} ${c.path}`)).toContain("POST /loop/run-limit/continue");
	});

	test("Run next moves a queued objective to the front, Cancel withdraws one", async ({ page }) => {
		const { calls } = await setup(page);
		await page.goto(HISTORY);
		const queue = page.getByTestId("loop-queue");
		await expect(queue.getByTestId("loop-queue-entry").first()).toContainText("Fix the login");
		await queue.getByTestId("loop-queue-entry").filter({ hasText: "URGENT: leads dropped" }).getByRole("button", { name: "Run next" }).click();
		await expect.poll(() => calls.filter((c) => c.path === "/board/order")).toEqual([{ method: "POST", path: "/board/order", body: { jobKey: "objective:q-2", to: "top" } }]);
		await expect(queue.getByTestId("loop-queue-entry").first()).toContainText("URGENT: leads dropped");
		await queue.getByTestId("loop-queue-entry").first().getByRole("button", { name: "Cancel" }).click();
		await expect.poll(() => calls.map((c) => `${c.method} ${c.path}`)).toContain("DELETE /loop/queue/q-2");
		await expect(queue.getByTestId("loop-queue-entry")).toHaveCount(1);
	});
});

test.describe("the delivery log", () => {
	test("Replay refreshes only the deliveries, and trace drills into the run", async ({ page }) => {
		const { requests, calls } = await setup(page);
		await page.goto(`${HISTORY}&panel=deliveries`);
		await expect(page.getByText("builder MCP unreachable")).toBeVisible();
		// Every panel has loaded once, so what follows is only what Replay asked for.
		await expect(page.getByTestId("bv-takeovers")).toBeVisible();
		await expect(page.getByTestId("browser-launch-receipt")).toBeVisible();
		await expect(page.getByTestId("history-loop-runs")).toBeVisible();
		const before = requests.length;
		await page.getByRole("button", { name: "Replay", exact: true }).click();
		await expect.poll(() => calls.map((c) => c.path)).toContain("/connections/deliveries/del-dead/replay");
		await expect.poll(() => requests.slice(before).filter((r) => r.startsWith("GET /connections/deliveries")).length).toBe(1);
		await page.waitForTimeout(300);
		expect(requests.slice(before).filter((r) => /^GET \/(loop|supervision|connections(\?|$)|tools|browser|secure-inputs)/.test(r))).toEqual([]);
		// The replayed row is no longer undelivered.
		await expect(page.getByText("Nothing stuck — every event reached its agent.")).toBeVisible();
	});

	test("status filters and the run trace", async ({ page }) => {
		await setup(page);
		await page.goto(HISTORY);
		await expect(page.getByRole("button", { name: /^Undelivered 1$/ })).toBeVisible();
		await page.getByRole("button", { name: /^All 2$/ }).click();
		await expect(page.getByTestId("delivery-row")).toHaveCount(2);
		await page.getByRole("button", { name: /^Delivered 1$/ }).click();
		await expect(page.getByTestId("delivery-row")).toHaveCount(1);
		await page.getByRole("button", { name: /^Undelivered 1$/ }).click();
		await page.getByRole("button", { name: "Run", exact: true }).click();
		await expect(page.getByText("started the child run")).toBeVisible();
	});
});

test.describe("Settings keeps one line for each moved panel", () => {
	test("Automation: runs waiting and undelivered events, each linking to its panel, and no list", async ({ page }) => {
		await setup(page);
		await page.goto("/console/instances/inst-1/settings?subtab=automation");
		const runs = page.getByTestId("loop-runs-line");
		await expect(runs).toContainText("1 waiting for you");
		await expect(runs.getByRole("link", { name: "View in Activity" })).toHaveAttribute("href", /\/activity\?view=history&panel=loop-runs$/);
		await expect(page.getByTestId("deliveries-line")).toContainText("1 undelivered");
		await expect(page.getByTestId("loop-queue")).toHaveCount(0);
		await expect(page.getByRole("button", { name: /delivery log/ })).toHaveCount(0);
		await expect(page.getByRole("heading", { name: "Autonomous runs" })).toHaveCount(0);
		await runs.getByRole("link", { name: "View in Activity" }).click();
		await expect(page).toHaveURL(/activity\?view=history&panel=loop-runs/);
		await expect(page.getByTestId("history-panel-loop-runs")).toBeFocused();
	});

	test("Automation: nothing waiting reads No runs waiting, and no undelivered line", async ({ page }) => {
		await setup(page, { history: { ...seededHistory(), runs: [], deliveries: [] } });
		await page.goto("/console/instances/inst-1/settings?subtab=automation");
		await expect(page.getByTestId("loop-runs-line")).toContainText("No runs waiting");
		await expect(page.getByTestId("deliveries-line")).toHaveCount(0);
	});

	test("Browser: a takeover waiting, a launch that differs, and no takeover list or receipt card", async ({ page }) => {
		await setup(page);
		await page.goto("/console/instances/inst-1/settings?subtab=browser");
		await expect(page.getByTestId("takeovers-line")).toContainText("1 waiting for you");
		await expect(page.getByTestId("takeovers-line").getByRole("link", { name: "View in Activity" })).toHaveAttribute("href", /panel=takeovers$/);
		// Saved engine is firefox; the runner last launched chrome.
		await expect(page.getByTestId("browser-launch-line")).toContainText("Differs from last launch");
		await expect(page.getByTestId("bv-takeovers")).toHaveCount(0);
		await expect(page.getByTestId("browser-launch-receipt")).toHaveCount(0);
	});

	test("Browser: a launch that matches the setting has no line", async ({ page }) => {
		await setup(page, { history: { ...seededHistory(), session: { status: "connected", launch: { ...LAUNCH, engine: "firefox" } } } });
		await page.goto("/console/instances/inst-1/settings?subtab=browser");
		await expect(page.getByTestId("browser-mode-settings")).toBeVisible();
		await expect(page.getByTestId("takeovers-line")).toBeVisible();
		await expect(page.getByTestId("browser-launch-line")).toHaveCount(0);
	});

	test("a failed check reads Couldn't check · View in Activity, never a verdict", async ({ page }) => {
		await setup(page, { history: { ...seededHistory(), fail: ["/browser-takeovers", "/loop"] } });
		await page.goto("/console/instances/inst-1/settings?subtab=browser");
		const line = page.getByTestId("takeovers-line");
		await expect(line).toContainText("Couldn't check");
		await expect(line.getByRole("link", { name: "View in Activity" })).toBeVisible();
		await page.goto("/console/instances/inst-1/settings?subtab=automation");
		await expect(page.getByTestId("loop-runs-line")).toContainText("Couldn't check");
		await expect(page.getByTestId("loop-runs-line")).not.toContainText("No runs waiting");
	});

	test("General no longer holds the secure-input history", async ({ page }) => {
		await setup(page);
		await page.goto("/console/instances/inst-1/settings?subtab=general");
		await expect(page.getByTestId("settings-section-instance-info")).toBeVisible();
		await expect(page.getByTestId("secure-input-history")).toHaveCount(0);
	});
});
