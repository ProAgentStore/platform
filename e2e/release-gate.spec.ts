import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1347 — the release-notes panel's exact-SHA gate, clicked in a real browser against a stub that applies the route's contract:
 * a PUT is a per-field patch, the deploy row needs its job and step, and a refused write changes nothing. The rules are unit-tested
 * (lib/releaseGate.test.ts) and run against the real route (workers/api slack-release-notes.integration.test.ts); what only a browser
 * shows is that the editor sends `requiredWorkflows` alone, shows the server's answer after a reload, puts a refusal beside its row,
 * and stays usable keyboard-only at phone width.
 */
const API = "https://api.proagentstore.online";
const CODER = { id: "inst-1", agent_id: "agent-1", name: "Repo Coder", status: "active", slug: "repo-coder", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } };
const CHAT = { id: "inst-2", agent_id: "agent-2", name: "Chatty", status: "active", slug: "chatty", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: "worker" } };
const CHESS = [
	{ path: ".github/workflows/ci.yml", role: "check" },
	{ path: ".github/workflows/e2e-full.yml", role: "check" },
	{ path: ".github/workflows/deploy.yml", role: "production_deploy", jobName: "deploy", stepName: "Upload to R2" },
];
const GRANT = { provider: "slack", grantId: "g1", channelId: "C1", name: "#release-notes" };

type Wf = { path: string; role: string; jobName?: string; stepName?: string };
interface Stored { enabled?: boolean; channels?: string[]; requiredWorkflows?: Wf[] }

async function mock(page: Page, opts: { stored?: Stored; runnerVersion?: string; refuse?: () => string | null } = {}) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), "test-pags-token");
	let stored: Stored = opts.stored ?? {};
	const puts: Array<Record<string, unknown>> = [];
	const seen: string[] = [];
	const gate = () => {
		const deploy = stored.requiredWorkflows?.find((w) => w.role === "production_deploy");
		if (!stored.requiredWorkflows) return { state: "none" };
		return deploy?.jobName && deploy.stepName ? { state: "ready" } : { state: "configuration_required", message: "This release gate predates deploy-step proof, so its production notes are held, not posted." };
	};
	const view = () => ({
		settings: stored,
		account: null,
		gate: gate(),
		effective: { enabled: stored.enabled ?? true, enabledFrom: "platform", channelsFrom: stored.channels ? "instance" : "all", missing: [], channels: [{ ...GRANT, selected: stored.channels ? stored.channels.includes("g1") : true }] },
	});
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		seen.push(path);
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [CODER, CHAT] });
		if (path === "/v1/instances/inst-1/release-notes") {
			if (req.method() === "PUT") {
				const body = req.postDataJSON() as Record<string, unknown>;
				puts.push(body);
				const refusal = opts.refuse?.();
				if (refusal) return json({ error: refusal }, 400);
				const next: Stored = { ...stored };
				// A per-field patch: an omitted field is kept, null returns it to inherited.
				if (body.enabled === null) delete next.enabled;
				else if (body.enabled !== undefined) next.enabled = body.enabled as boolean;
				if (body.channels === null) delete next.channels;
				else if (body.channels !== undefined) next.channels = body.channels as string[];
				if (body.requiredWorkflows === null) delete next.requiredWorkflows;
				else if (body.requiredWorkflows !== undefined) next.requiredWorkflows = body.requiredWorkflows as Wf[];
				stored = next;
			}
			return json(view());
		}
		if (path === "/v1/instances/inst-1/release-notes/deliveries") return json({ deliveries: [], hasMore: false, nextCursor: null });
		if (path === "/v1/instances/inst-1/runner-node") return json({ runnerNode: "mac", nodes: ["mac"], nodesDetail: [{ node: "mac", connected: true, nodeOnline: true }], resolvedNode: "mac" });
		if (path === "/v1/terminals/nodes") return json({ nodes: [{ node: "mac", connected: true, runnerVersion: opts.runnerVersion ?? "0.4.180" }] });
		if (path === "/v1/slack/bot") return json({ connected: true, valid: true, bot: { team: "Acme" }, oauthConfigured: false });
		if (path === "/v1/slack/channels") return json({ channels: [{ id: "C1", name: "release-notes", isMember: true }], hasMore: false });
		if (path.startsWith("/v1/discord/")) return json({ error: "not connected" }, 404);
		if (path === "/v1/connectors") return json({ connectors: [] });
		// An unmocked route fails the way an unreachable one would; a bare `{}` 200 crashes the cards that read a list off it.
		return json({ error: "not mocked" }, 404);
	});
	return { puts, seen, stored: () => stored };
}

const panel = (page: Page) => page.getByTestId("release-notes-panel");
const gate = (page: Page) => page.getByTestId("release-gate");
const open = async (page: Page) => {
	await page.goto("/console/instances/inst-1/permissions");
	await expect(gate(page)).toBeVisible();
};

test.describe("the exact-SHA release gate in the console (#1347)", () => {
	test("a coder with the ChessClubs gate sees every part of it, ready, and sees the same after a reload", async ({ page }) => {
		await mock(page, { stored: { channels: ["g1"], requiredWorkflows: CHESS } });
		await open(page);
		for (let pass = 0; pass < 2; pass++) {
			await expect(gate(page)).toContainText("Verified production note");
			for (const p of [".github/workflows/ci.yml", ".github/workflows/e2e-full.yml", ".github/workflows/deploy.yml"]) await expect(gate(page)).toContainText(p);
			await expect(gate(page)).toContainText("deploy");
			await expect(gate(page)).toContainText("Upload to R2");
			await expect(panel(page)).toContainText("#release-notes");
			await expect(page.getByTestId("release-readiness")).toContainText("Ready to publish");
			if (pass === 0) await page.reload();
			await expect(gate(page)).toBeVisible();
		}
	});

	test("editing only the workflows sends requiredWorkflows alone; choosing a channel sends channels alone", async ({ page }) => {
		const { puts, stored } = await mock(page, { stored: { enabled: false, channels: ["g1"], requiredWorkflows: CHESS } });
		await open(page);
		await gate(page).getByRole("button", { name: "Edit gate" }).click();
		await page.getByLabel("Deploy step name").fill("Upload site to R2");
		await gate(page).getByRole("button", { name: "Save gate" }).click();
		await expect.poll(() => puts.length).toBe(1);
		expect(puts[0]).toEqual({ requiredWorkflows: [CHESS[0], CHESS[1], { ...CHESS[2], stepName: "Upload site to R2" }] });
		await expect(gate(page)).toContainText("Upload site to R2");
		expect(stored()).toMatchObject({ enabled: false, channels: ["g1"] });

		await page.getByRole("checkbox", { name: "Send release notes to slack #release-notes" }).click();
		await expect.poll(() => puts.length).toBe(2);
		expect(puts[1]).toEqual({ channels: [] });
		expect(stored().requiredWorkflows?.[2].stepName).toBe("Upload site to R2");
	});

	test("an empty deploy job is stopped beside its row without a request, and Cancel puts the saved gate back", async ({ page }) => {
		const { puts } = await mock(page, { stored: { requiredWorkflows: CHESS } });
		await open(page);
		await gate(page).getByRole("button", { name: "Edit gate" }).click();
		await page.getByLabel("Deploy job name").fill("");
		await gate(page).getByRole("button", { name: "Save gate" }).click();
		await expect(page.locator("#gate-row-2-error")).toContainText("Name the deploy job");
		expect(puts).toEqual([]);
		await gate(page).getByRole("button", { name: "Cancel" }).click();
		await gate(page).getByRole("button", { name: "Edit gate" }).click();
		await expect(page.getByLabel("Deploy job name")).toHaveValue("deploy");
	});

	test("a refusal from the server shows beside the deploy row and the last saved gate survives a reload", async ({ page }) => {
		const { puts } = await mock(page, { stored: { requiredWorkflows: CHESS }, refuse: () => "The production_deploy workflow needs an exact, non-empty jobName (the GitHub Actions job name)" });
		await open(page);
		await gate(page).getByRole("button", { name: "Edit gate" }).click();
		await page.getByLabel("Deploy job name").fill("ship");
		await gate(page).getByRole("button", { name: "Save gate" }).click();
		await expect(page.locator("#gate-row-2-error")).toContainText("non-empty jobName");
		expect(puts).toHaveLength(1);
		await page.reload();
		await expect(gate(page)).toContainText("Upload to R2");
		await expect(gate(page)).not.toContainText("ship");
	});

	test("clearing the gate asks first, then sends requiredWorkflows: null and returns to the status note", async ({ page }) => {
		const { puts } = await mock(page, { stored: { channels: ["g1"], requiredWorkflows: CHESS } });
		await open(page);
		await gate(page).getByRole("button", { name: "Clear gate" }).click();
		expect(puts).toEqual([]);
		await expect(gate(page)).toContainText("no deploy is verified");
		await gate(page).getByRole("button", { name: "Clear the gate" }).click();
		await expect.poll(() => puts).toEqual([{ requiredWorkflows: null }]);
		await expect(gate(page)).toContainText("Status note after a trunk-changing run");
		await expect(page.getByTestId("release-readiness")).not.toContainText("Ready to publish");
	});

	test("old runner, old gate and an unselected channel each show their own warning and never 'ready'", async ({ page }) => {
		await mock(page, { stored: { channels: [], requiredWorkflows: [CHESS[0], { path: ".github/workflows/deploy.yml", role: "production_deploy" }] }, runnerVersion: "0.4.150" });
		await open(page);
		const ready = page.getByTestId("release-readiness");
		await expect(ready).toContainText("Not ready to publish");
		await expect(ready).toContainText("none is selected");
		await expect(ready).toContainText("no deploy job and step");
		await expect(ready).toContainText("0.4.150");
		await expect(ready).not.toContainText("Ready to publish");
		await expect(gate(page)).toContainText("Verified production note: setup needed");
	});

	test("mobile — at phone width nothing overflows sideways and the editor works from the keyboard", async ({ page }) => {
		await page.setViewportSize({ width: 360, height: 740 });
		const { puts } = await mock(page, { stored: { requiredWorkflows: CHESS } });
		await open(page);
		await gate(page).getByRole("button", { name: "Edit gate" }).focus();
		await page.keyboard.press("Enter");
		await page.getByLabel("Deploy step name").focus();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.type("Upload to R2 (prod)");
		await page.keyboard.press("Enter"); // submits the form
		await expect.poll(() => puts.length).toBe(1);
		const overflow = await panel(page).evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(overflow).toBeLessThanOrEqual(1);
	});

	test("a Send test is labelled TEST and shows the message link", async ({ page }) => {
		await mock(page, { stored: { requiredWorkflows: CHESS } });
		await page.route(`${API}/v1/instances/inst-1/release-notes/test`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sent: true, channel: GRANT, permalink: "https://acme.slack.com/archives/C1/p1" }) }));
		await open(page);
		await expect(page.getByTestId("release-test-note")).toContainText("never a release");
		await panel(page).getByRole("button", { name: "Send test" }).click();
		await expect(panel(page)).toContainText("TEST note sent to Slack #release-notes");
		await expect(panel(page)).toContainText("https://acme.slack.com/archives/C1/p1");
	});

	test("a non-coder neither renders nor fetches the release-notes panel", async ({ page }) => {
		const { seen } = await mock(page);
		await page.goto("/console/instances/inst-2/permissions");
		await expect(page.getByTestId("permissions-and-connections")).toBeVisible();
		await expect(panel(page)).toHaveCount(0);
		expect(seen.filter((p) => p.includes("release-notes"))).toEqual([]);
	});
});
