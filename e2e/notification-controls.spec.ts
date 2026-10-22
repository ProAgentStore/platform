import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1283 — the Preferences notification controls, clicked in a real browser against a stub that stores the section the way the real
 * route does: a `notifications` write REPLACES the whole section. The logic is unit-tested in lib/notificationsStore.test.ts and
 * against the real route in workers/api; what only a browser can show is that the controls on the page are wired to that one store —
 * that a switch click carries the rules, a rule change carries the mutes and the scope, and the page shows what is stored.
 */
const API = "https://api.proagentstore.online";
const TYPES = [
	{ id: "deploy", label: "Deployments", description: "A build finished.", alerts: false },
	{ id: "apply", label: "Applications", description: "An application moved.", alerts: false },
];
const INSTANCES = ["inst-a", "inst-b", "inst-c"].map((id) => ({ id, agent_id: `agent-${id}`, name: `Agent ${id}`, slug: id, status: "active", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: "worker" } }));

type Rule = { type: string; severity?: string; push?: boolean; inapp?: boolean };
type Section = { muted?: string[]; instances?: string[]; rules?: Rule[] };

/** What the server resolves for a row: the owner's rule when there is one, else the default. */
function effective(rules: Rule[]) {
	return TYPES.map((t) => {
		const rule = rules.find((r) => r.type === t.id);
		const cell = (channel: "push" | "inapp") => (rule && rule[channel] !== undefined ? { allowed: rule[channel] as boolean, source: "instance" as const, rule } : { allowed: true, source: "default" as const });
		return { type: t.id, severity: "update", inapp: cell("inapp"), push: cell("push") };
	});
}

async function mock(page: Page, stored: Section = {}, opts: { rejectNext?: () => boolean } = {}) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	let notifications: Section = stored;
	const puts: Section[] = [];
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user", "creator"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: INSTANCES });
		if (path === "/v1/notifications") return json({ notifications: [], unreadCount: 0 });
		if (path === "/v1/connectors") return json({ connectors: [] });
		if (path === "/v1/instances/notification-vocabulary") {
			return json({ types: TYPES, events: [], severities: ["update"], channels: [{ id: "inapp", label: "Console", description: "", optional: true }, { id: "push", label: "Push", description: "", optional: true }] });
		}
		if (path === "/v1/preferences") {
			if (req.method() === "PUT") {
				const body = req.postDataJSON() as { notifications?: Section };
				if (body.notifications) {
					if (opts.rejectNext?.()) return json({ error: "The server refused that." }, 400);
					notifications = body.notifications;
					puts.push(body.notifications);
				}
				return json({ preferences: { notifications } });
			}
			return json({ preferences: { voice: { speed: 130, sttMode: "openai" }, notifications }, languages: [{ name: "English", tag: "en-US" }], notificationTypes: TYPES, attentionEvents: [], notificationEffective: effective(notifications.rules ?? []) });
		}
		// An unmocked route fails the way an unreachable one would; a bare `{}` 200 crashes cards that read a list off it.
		return json({ error: "not mocked" }, 404);
	});
	return { puts, stored: () => notifications };
}

const typeSwitch = (page: Page, label: string) => page.getByRole("checkbox", { name: `Notify me about ${label}`, exact: true });
const ruleSelect = (page: Page, label: string, channel: "console" | "push") => page.getByLabel(`${label} — progress — ${channel}`);

test.describe("Preferences notification controls share one state (#1283)", () => {
	test("A: a rule is set, then a type switch and a Which agents box are changed — the rule survives, on the page and in storage", async ({ page }) => {
		const { puts, stored } = await mock(page, { muted: [], rules: [{ type: "deploy", push: false }] });
		await page.goto("/console/preferences");
		await expect(ruleSelect(page, "Deployments", "push")).toHaveValue("off");

		await typeSwitch(page, "Deployments").click();
		await expect(typeSwitch(page, "Deployments")).not.toBeChecked();
		await expect.poll(() => puts.at(-1)).toEqual({ muted: ["deploy"], rules: [{ type: "deploy", push: false }] });

		await typeSwitch(page, "Agent inst-b").click();
		await expect.poll(() => puts.at(-1)).toEqual({ muted: ["deploy"], instances: ["inst-a", "inst-c"], rules: [{ type: "deploy", push: false }] });
		await expect(ruleSelect(page, "Deployments", "push")).toHaveValue("off");

		// Reloaded: the page reads back exactly what it showed.
		await page.reload();
		await expect(ruleSelect(page, "Deployments", "push")).toHaveValue("off");
		await expect(typeSwitch(page, "Deployments")).not.toBeChecked();
		await expect(typeSwitch(page, "Agent inst-b")).not.toBeChecked();
		expect(stored()).toEqual({ muted: ["deploy"], instances: ["inst-a", "inst-c"], rules: [{ type: "deploy", push: false }] });
	});

	test("B: a type is muted and the agents narrowed, then a rule is changed with no reload — the mute and the scope stay", async ({ page }) => {
		const { puts, stored } = await mock(page);
		await page.goto("/console/preferences");
		await typeSwitch(page, "Deployments").click();
		await expect(typeSwitch(page, "Deployments")).not.toBeChecked();
		await typeSwitch(page, "Agent inst-a").click();
		await expect(typeSwitch(page, "Agent inst-a")).not.toBeChecked();
		await expect.poll(() => puts.at(-1)).toEqual({ muted: ["deploy"], instances: ["inst-b", "inst-c"] });

		await ruleSelect(page, "Applications", "push").selectOption("off");
		await expect(ruleSelect(page, "Applications", "push")).toHaveValue("off");
		await expect.poll(() => puts.at(-1)).toEqual({ muted: ["deploy"], instances: ["inst-b", "inst-c"], rules: [{ type: "apply", severity: "update", push: false }] });
		// The switches above did not move, and storage agrees with them.
		await expect(typeSwitch(page, "Deployments")).not.toBeChecked();
		await expect(typeSwitch(page, "Agent inst-a")).not.toBeChecked();
		expect(stored()).toEqual({ muted: ["deploy"], instances: ["inst-b", "inst-c"], rules: [{ type: "apply", severity: "update", push: false }] });
	});

	test("a refused save puts the switch back and says so, instead of showing a change that did not happen", async ({ page }) => {
		let refuse = false;
		const { stored } = await mock(page, { muted: [], rules: [{ type: "deploy", push: false }] }, { rejectNext: () => refuse });
		await page.goto("/console/preferences");
		await expect(typeSwitch(page, "Deployments")).toBeChecked();
		refuse = true;
		await typeSwitch(page, "Deployments").click();
		await expect(page.getByRole("alert").filter({ hasText: "The server refused that." })).toBeVisible();
		await expect(typeSwitch(page, "Deployments")).toBeChecked();
		await expect(ruleSelect(page, "Deployments", "push")).toHaveValue("off");
		expect(stored()).toEqual({ muted: [], rules: [{ type: "deploy", push: false }] });
	});
});
