import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { type FixtureRule, GMAIL_SCOUT_CAPS, NOTIFICATION_VOCABULARY, notificationsResponse } from "./notification-fixtures";

/**
 * #1595 — the instance Notifications card lists only the rows the agent can raise. Routes are stubbed; the row sets come from the
 * real vocabulary and gate resolution (`notification-fixtures.ts`), so the 17/15 split is the server's, not a hand-kept list.
 */
const API = "https://api.proagentstore.online";
const CODING_CAPS = { surfaces: ["coding"], runtime: "coding" } as never;

function instance(caps: { surfaces?: string[]; runtime?: string | null }) {
	return { id: "inst-1", agent_id: "agent-1", name: "Agent", status: "active", slug: "agent", category: "productivity", icon_bg: "#7c3aed", capabilities: caps };
}

async function mock(page: Page, caps: never, opts: { rules?: FixtureRule[]; hidden?: string[] } = {}) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	let rules = opts.rules ?? [];
	const calls: string[] = [];
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [instance(caps)] });
		if (path === "/v1/instances/notification-vocabulary") return json(NOTIFICATION_VOCABULARY);
		if (path === "/v1/instances/inst-1/notifications") {
			calls.push(req.method());
			if (req.method() === "DELETE") {
				rules = [];
				const { applicability: _a, inherited: _i, ...rest } = notificationsResponse("inst-1", caps, rules);
				return json({ ...rest, restored: true });
			}
			const body = notificationsResponse("inst-1", caps, rules);
			return json(opts.hidden ? { ...body, applicability: { hidden: opts.hidden } } : body);
		}
		if (path === "/v1/preferences") {
			const body = notificationsResponse("", caps);
			return json({ preferences: { voice: { speed: 130, sttMode: "openai" }, notifications: {} }, languages: [{ name: "English", tag: "en-US" }], notificationTypes: NOTIFICATION_VOCABULARY.types, attentionEvents: NOTIFICATION_VOCABULARY.events, notificationEffective: body.effective, notificationChannels: NOTIFICATION_VOCABULARY.channels, notificationSeverities: NOTIFICATION_VOCABULARY.severities });
		}
		if (path === "/v1/connectors") return json({ connectors: [] });
		if (path === "/v1/notifications") return json({ notifications: [], unreadCount: 0 });
		if (path === "/v1/triggers") return json({ triggers: [] });
		if (path === "/v1/triggers/preview") return json({ schedule: null, timezone: null, issues: [] });
		// An unmocked route fails the way an unreachable one would; a bare `{}` 200 crashes cards that read a list off it.
		return json({ error: "not mocked" }, 404);
	});
	return { calls };
}

const card = (page: Page) => page.getByTestId("instance-notification-policy");
const rowCount = (page: Page) => card(page).locator('select[aria-label$="— console"]').count();
const open = async (page: Page) => {
	await page.goto("/console/instances/inst-1/settings?subtab=notifications");
	await expect(card(page)).toBeVisible();
};

test("a Gmail Scout shows the 17 rows it can raise and the line for the other 15", async ({ page }) => {
	await mock(page, GMAIL_SCOUT_CAPS);
	await open(page);
	expect(await rowCount(page)).toBe(17);
	await expect(page.getByTestId("notification-rows-follow-account")).toHaveText("15 more follow your account · Open Preferences");
	for (const hidden of ["Coder", "Deploys", "Job applications", "Spend alerts", "New subscribers"]) await expect(card(page).getByText(hidden)).toHaveCount(0);
	for (const shown of ["Machines", "Browser research", "Approval needed"]) await expect(card(page).getByText(shown).first()).toBeVisible();
});

test("an instance rule on a hidden row shows it with its choice and leaves 14 following the account", async ({ page }) => {
	await mock(page, GMAIL_SCOUT_CAPS, { rules: [{ type: "spend", severity: "update", push: false }] });
	await open(page);
	expect(await rowCount(page)).toBe(18);
	await expect(card(page).getByLabel("Spend alerts — progress — push")).toHaveValue("off");
	await expect(page.getByTestId("notification-rows-follow-account")).toHaveText("14 more follow your account · Open Preferences");
});

test("a coding agent shows the coding rows and Machines, not browser research or applications", async ({ page }) => {
	await mock(page, CODING_CAPS);
	await open(page);
	for (const label of ["Coder — progress", "Coder questions — progress", "Deploys — progress", "Build checks — progress", "Product-owner triage — progress", "Machines — progress"]) {
		await expect(card(page).getByText(label, { exact: true })).toBeVisible();
	}
	for (const label of ["Browser research", "Job applications", "Spend alerts", "New subscribers"]) await expect(card(page).getByText(label)).toHaveCount(0);
});

test("the line is hidden when every row applies", async ({ page }) => {
	await mock(page, CODING_CAPS, { hidden: [] });
	await open(page);
	await expect(page.getByTestId("notification-rows-follow-account")).toHaveCount(0);
	expect(await rowCount(page)).toBe(32);
});

test("Preferences still lists the full vocabulary", async ({ page }) => {
	await mock(page, GMAIL_SCOUT_CAPS);
	await page.goto("/console/preferences");
	await expect(card(page)).toBeVisible();
	await expect(card(page).getByText("Deploys — progress", { exact: true })).toBeVisible();
	await expect(page.getByTestId("notification-rows-follow-account")).toHaveCount(0);
});

test("Restore inherited sends DELETE, and the rule on a hidden row is gone from the next read", async ({ page }) => {
	const { calls } = await mock(page, GMAIL_SCOUT_CAPS, { rules: [{ type: "spend", severity: "update", push: false }] });
	await open(page);
	await expect(card(page).getByLabel("Spend alerts — progress — push")).toBeVisible();
	await card(page).getByRole("button", { name: /Restore inherited/ }).click();
	await expect(page.getByText("Saved.")).toBeVisible();
	expect(calls).toContain("DELETE");
	await page.reload();
	await expect(card(page)).toBeVisible();
	await expect(card(page).getByLabel("Spend alerts — progress — push")).toHaveCount(0);
	await expect(page.getByTestId("notification-rows-follow-account")).toHaveText("15 more follow your account · Open Preferences");
});
