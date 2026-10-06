import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The Research tab, end to end in the real console bundle (#946, #947). The API and the runner
 * behind it are mocked here — the runner's own behaviour is held by the browser-runner tests — so
 * this proves the console half: setup, settings, start, the run's trace, and the save decision.
 */
const API = "https://api.proagentstore.online";
const TOKEN = "test-pags-token";
const RUN_ID = "run-e2e-1";

interface Recorded {
	settingsPuts: unknown[];
	runPosts: unknown[];
	saves: string[];
}

/** A signed-in owner with one local browser research agent, and a run that finishes on cue. */
async function mockResearchAgent(page: Page) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), TOKEN);
	const recorded: Recorded = { settingsPuts: [], runPosts: [], saves: [] };
	const state = { started: false, finished: false, saved: false, allowDomains: [] as string[] };

	const settings = () => ({
		settings: state.allowDomains.length ? { access: { allowDomains: state.allowDomains } } : {},
		effective: null,
		problem: null,
		capability: { engines: ["claude", "codex"], mode: "research_only", subscriptionOnly: true, resultSchema: { id: "findings", version: 1 }, limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 }, allowDomains: [], denyDomains: [], collection: { name: "job_leads" } },
		runnerNode: "my-machine",
	});
	const at = "2026-10-07T01:00:00Z";
	const events = () => [
		{ seq: 1, type: "run.requested", at, recordedAt: 1 },
		{ seq: 2, type: "runner.dispatched", at, recordedAt: 2, detail: { runnerNode: "my-machine" } },
		{ seq: 3, type: "engine.auth_checked", at, recordedAt: 3, detail: { engine: "claude", engineAuth: "subscription" } },
		{ seq: 4, type: "engine.started", at, recordedAt: 4 },
		{ seq: 5, type: "policy.decision", at, recordedAt: 5, domain: "seek.com.au", detail: { decision: "allowed", basis: "allow_list" } },
		{ seq: 6, type: "browser.navigated", at, recordedAt: 6, url: "https://seek.com.au/jobs", domain: "seek.com.au", detail: { title: "Software jobs" } },
		{ seq: 7, type: "finding.parsed", at, recordedAt: 7, url: "https://seek.com.au/job/1", domain: "seek.com.au", detail: { title: "Senior TypeScript Engineer" } },
		...(state.finished ? [{ seq: 8, type: "engine.ended", at, recordedAt: 8 }, { seq: 9, type: "run.ended", at, recordedAt: 9, detail: { status: "completed" } }] : []),
	];
	const run = () => ({
		id: RUN_ID,
		instanceId: "inst-1",
		requestId: "q",
		objective: "Find senior TypeScript roles in Sydney",
		status: state.finished ? "completed" : "running",
		pauseReason: null,
		errorCode: null,
		error: null,
		policy: { engine: "claude", authMode: "subscription", workspace: { kind: "scratch" }, browserProfile: "isolated", mode: "research_only", allowDomains: ["seek.com.au"], denyDomains: [], limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 }, traceRetentionDays: 30, resultSchema: { id: "findings", version: 1 }, collection: { name: "job_leads" } },
		result: state.finished
			? { runId: RUN_ID, outcome: "completed", findings: [{ title: "Senior TypeScript Engineer", url: "https://seek.com.au/job/1", evidence: "Senior TypeScript Engineer — Sydney, hybrid", fields: { location: "Sydney" } }], sourceFailures: [], summary: "One matching role.", traceId: RUN_ID, engineAuth: "subscription" }
			: null,
		engineAuth: "subscription",
		runnerNode: "my-machine",
		findingReviews: state.saved ? { "0": { decision: "saved", collection: "job_leads", recordId: "rec_1", at: 1 } } : {},
		createdAt: 1,
		startedAt: 2,
		endedAt: state.finished ? 3 : null,
		updatedAt: 3,
	});

	await page.route(`${API}/**`, async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		const method = route.request().method();
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		const base = "/v1/instances/inst-1/local-browser";

		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") {
			return json({ instances: [{ id: "inst-1", name: "Job Search Scout", slug: "job-search-scout", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: "local_browser", workflow: null } }] });
		}
		if (path === "/v1/instances/inst-1/runtime/status") {
			return json({ runtime: { instanceId: "inst-1", status: "online", runnerNode: "my-machine" }, relay: { connected: true, runnerNode: "my-machine", live: true }, attachment: { state: "attached", message: "Connected.", remedy: null } });
		}
		if (path === `${base}/preflight`) {
			return json({ ready: true, checks: [{ id: "settings", ok: true, detail: "" }, { id: "runner", ok: true, detail: "Connected on my-machine" }, { id: "runner_support", ok: true, detail: "" }, { id: "engine_login", ok: null, detail: "Checked by the runner at the start of each run." }] });
		}
		if (path === `${base}/settings` && method === "PUT") {
			const body = route.request().postDataJSON() as { access?: { allowDomains?: string[] } };
			recorded.settingsPuts.push(body);
			state.allowDomains = body.access?.allowDomains ?? [];
			return json({ settings: settings().settings, effective: null });
		}
		if (path === `${base}/settings`) return json(settings());
		if (path === `${base}/consent`) return json({ consent: [] });
		if (path === `${base}/runs` && method === "POST") {
			recorded.runPosts.push(route.request().postDataJSON());
			state.started = true;
			return json(run(), 202);
		}
		if (path === `${base}/runs`) return json({ runs: state.started ? [run()] : [] });
		if (path === `${base}/runs/${RUN_ID}/events`) return json({ events: events(), nextAfter: events().length });
		if (path === `${base}/runs/${RUN_ID}/findings/0/save` && method === "POST") {
			recorded.saves.push(path);
			state.saved = true;
			return json(run());
		}
		if (path === `${base}/runs/${RUN_ID}`) return json(run());
		// Everything else the shell reads on its way past is answered empty — nothing under test.
		return json({});
	});
	return { recorded, state };
}

test.describe("Research tab — local browser research (#946, #947)", () => {
	test("set up, configure the allowed site, start a run, follow its trace, and save a finding", async ({ page }) => {
		const { recorded, state } = await mockResearchAgent(page);

		// 1. The tab exists for a local browser agent, and its checklist asks for no repository.
		await page.goto("/console/instances/inst-1/research");
		await expect(page.getByRole("heading", { name: "Local browser research" })).toBeVisible();
		await expect(page.getByRole("list", { name: "Setup checklist" })).toContainText("Runner connected");
		await expect(page.getByText(/read-only/)).toBeVisible();
		await expect(page.getByText(/repositor|GitHub/i)).toHaveCount(0);

		// 2. Settings: allow one site. Research-only is the only mode there is to choose.
		await page.goto("/console/instances/inst-1/settings");
		const section = page.locator("div", { has: page.getByRole("heading", { name: "Local browser research" }) }).last();
		await section.getByLabel(/Allowed sites/).fill("seek.com.au");
		await section.getByRole("button", { name: "Save research settings" }).click();
		await expect(section.getByText("Saved.")).toBeVisible();
		expect(recorded.settingsPuts.at(-1)).toMatchObject({ access: { allowDomains: ["seek.com.au"], denyDomains: [] } });

		// 3. Start a run.
		await page.goto("/console/instances/inst-1/research");
		await page.getByLabel("What should it research?").fill("Find senior TypeScript roles in Sydney");
		await page.getByRole("button", { name: "Start research" }).click();
		await expect(page).toHaveURL(new RegExp(`/instances/inst-1/research/${RUN_ID}$`));
		expect(recorded.runPosts[0]).toMatchObject({ objective: "Find senior TypeScript roles in Sydney", requestId: expect.any(String) });

		// 4. Its trace: who did each step, the engine's sign-in, and the pages it opened.
		const steps = page.getByRole("list", { name: "Run steps" });
		await expect(steps).toContainText("Local CLI started");
		await expect(steps).toContainText("Claude Code on my-machine · Subscription");
		await expect(page.getByText("seek.com.au", { exact: true }).first()).toBeVisible();
		await expect(page.getByText("Software jobs")).toBeVisible();

		// 5. The run finishes; the finding is a candidate until the owner saves it.
		state.finished = true;
		await expect(page.getByText("Finished")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("Senior TypeScript Engineer — Sydney, hybrid")).toBeVisible();
		await expect(page.getByRole("button", { name: /apply|submit/i })).toHaveCount(0);
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(page.getByText("Saved to job_leads")).toBeVisible();
		expect(recorded.saves).toEqual([`/v1/instances/inst-1/local-browser/runs/${RUN_ID}/findings/0/save`]);

		// 6. The run list shows it, with its status.
		await page.getByRole("button", { name: "← All runs" }).click();
		await expect(page.getByRole("button", { name: /Finished.*Find senior TypeScript roles/ })).toBeVisible();
	});
});
