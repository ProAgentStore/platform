import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1237 — an instance's operator manual in Settings: the template's manual, inherited, shown read-only
 * above this instance's own (editable) one. Routes are stubbed; this asserts what is shown and sent.
 */
const API = "https://api.proagentstore.online";
const INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Repo Coder", status: "active", slug: "repo-coder", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } };
const STANDARD = "Checkouts are home-relative: ~/dev/stores/pas/apps/<app>.";

async function mock(page: Page, inherited: string, account = "") {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	const puts: Array<Record<string, unknown>> = [];
	let own = "";
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/inst-1/operator-manual") {
			if (req.method() === "PUT") {
				const body = req.postDataJSON() as { manual: string };
				puts.push(body);
				own = body.manual;
				return json({ ok: true });
			}
			return json({ manual: own, account, inherited, sections: { account: account || null, inherited: inherited || null, instance: own || null }, combined: "", rules: "", context: "" });
		}
		// The coding cards beside it, with their real shapes (a bare {} crashes them).
		if (path === "/v1/instances/inst-1/po-triage/reports") return json({ settings: null, triggers: [], reports: [] });
		if (path === "/v1/instances/inst-1/coder-questions") return json({ settings: null, questions: [] });
		if (path === "/v1/instances/inst-1/auto-pickup") return json({ settings: null, builtinExcludeLabels: [], activeWhenQueueEmpties: "auto_pickup", recent: [] });
		if (path === "/v1/instances/inst-1/coding/engine-choice") return json({ defaultEngineId: "claude", engines: [{ id: "claude", label: "Claude Code", command: "claude", clientType: "claude", model: null, modelSelectable: true, suggestions: [] }], lastObserved: null, appliesTo: "" });
		// The triggers card reads these two lists; a bare {} crashes it (and the error boundary takes the tab).
		if (path === "/v1/triggers") return json({ triggers: [] });
		if (path === "/v1/triggers/actions") return json({ actions: [] });
		if (path === "/v1/triggers/preview") return json({ schedule: null, timezone: null, jitterMinutes: null, runs: [], issues: [], error: null });
		return json({});
	});
	return { puts };
}

test.describe("the operator manual in Settings (#1237)", () => {
	test("the template's manual is shown, read-only, above this instance's own — and only the instance's own is saved", async ({ page }) => {
		const { puts } = await mock(page, STANDARD);
		await page.goto("/console/instances/inst-1/settings");
		const card = page.getByTestId("operator-manual");
		await expect(card.getByTestId("operator-manual-inherited")).toContainText("Inherited from template");
		await expect(card.getByTestId("operator-manual-inherited")).toContainText(STANDARD);
		await expect(card.getByTestId("operator-manual-inherited").getByRole("textbox")).toHaveCount(0);
		await card.getByRole("textbox", { name: "This instance's operator manual" }).fill("Stash lives at ~/dev/stores/pas/apps/stash.");
		await card.getByRole("button", { name: "Save" }).click();
		await expect.poll(() => puts).toEqual([{ manual: "Stash lives at ~/dev/stores/pas/apps/stash." }]);
	});

	test("with no template manual, there is no inherited section — just the instance's own", async ({ page }) => {
		await mock(page, "");
		await page.goto("/console/instances/inst-1/settings");
		const card = page.getByTestId("operator-manual");
		await expect(card.getByRole("textbox", { name: "This instance's operator manual" })).toBeVisible();
		await expect(card.getByTestId("operator-manual-inherited")).toHaveCount(0);
	});
});

const MACHINES = "Machines: Mac mini, pink laptop, Dell. Main only, no PRs.";

test.describe("the account-level operator manual (#1238)", () => {
	test("an instance's Settings shows the account's manual first, then the template's, read-only, above its own", async ({ page }) => {
		await mock(page, STANDARD, MACHINES);
		await page.goto("/console/instances/inst-1/settings");
		const card = page.getByTestId("operator-manual");
		await expect(card.getByTestId("operator-manual-account")).toContainText("Inherited from your account");
		await expect(card.getByTestId("operator-manual-account")).toContainText(MACHINES);
		await expect(card.getByTestId("operator-manual-inherited")).toContainText(STANDARD);
		await expect(card.getByTestId("operator-manual-account").getByRole("textbox")).toHaveCount(0);
		const text = (await card.innerText()).replace(/\s+/g, " ").toLowerCase();
		expect(text.indexOf("inherited from your account")).toBeLessThan(text.indexOf("inherited from template"));
		expect(text.indexOf("inherited from template")).toBeLessThan(text.indexOf("an addendum that wins"));
	});

	test("with only an account manual there is no template section", async ({ page }) => {
		await mock(page, "", MACHINES);
		await page.goto("/console/instances/inst-1/settings");
		const card = page.getByTestId("operator-manual");
		await expect(card.getByTestId("operator-manual-account")).toContainText(MACHINES);
		await expect(card.getByTestId("operator-manual-inherited")).toHaveCount(0);
	});

	test("Preferences has the account manual: it loads, and saving sends only the manual to the account route", async ({ page }) => {
		await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
		const puts: Array<Record<string, unknown>> = [];
		let saved = MACHINES;
		await page.route(`${API}/**`, async (route) => {
			const req = route.request();
			const path = new URL(req.url()).pathname;
			const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
			if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
			if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
			if (path === "/v1/preferences/operator-manual") {
				if (req.method() === "PUT") {
					const body = req.postDataJSON() as { manual: string };
					puts.push(body);
					saved = body.manual;
					return json({ ok: true, manual: saved });
				}
				return json({ manual: saved, instances: 1 });
			}
			if (path === "/v1/preferences") return json({ preferences: { voice: { speed: 130, sttMode: "openai" }, notifications: {} }, languages: [{ name: "English", tag: "en-US" }], notificationTypes: [], attentionEvents: [], notificationEffective: [] });
			if (path === "/v1/notifications") return json({ notifications: [], unreadCount: 0 });
			if (path === "/v1/connectors") return json({ connectors: [] });
			if (path === "/v1/instances/notification-vocabulary") return json({ types: [], events: [], severities: ["update"], channels: [] });
			return json({ error: "not mocked" }, 404);
		});
		await page.goto("/console/preferences");
		const card = page.getByTestId("account-operator-manual");
		await expect(card).toContainText("applies to every agent you run");
		await expect(card).toContainText("1 now");
		const box = card.getByRole("textbox", { name: "Account operator manual" });
		await expect(box).toHaveValue(MACHINES);
		await box.fill(`${MACHINES} Checkouts are home-relative.`);
		await card.getByRole("button", { name: "Save" }).click();
		await expect.poll(() => puts).toEqual([{ manual: `${MACHINES} Checkouts are home-relative.` }]);
	});
});
