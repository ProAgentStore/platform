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
	consentPuts: unknown[];
	resumes: number;
}

/** A run that is waiting on the owner, or one that has failed — what the banner and the reason read. */
type Pause = { reason: "consent_required" | "captcha" | "login_required"; domain: string };
type Failure = { errorCode: string; error: string };

/** A signed-in owner with one local browser research agent, and a run that finishes on cue. */
async function mockResearchAgent(page: Page, opts: { pause?: Pause; failure?: Failure } = {}) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), TOKEN);
	const recorded: Recorded = { settingsPuts: [], runPosts: [], saves: [], consentPuts: [], resumes: 0 };
	const state = { started: !!(opts.pause || opts.failure), finished: false, saved: false, allowDomains: [] as string[], pause: opts.pause ?? null, failure: opts.failure ?? null };

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
		...(state.pause?.reason === "consent_required" ? [{ seq: 10, type: "consent.requested", at, recordedAt: 10, domain: state.pause.domain, detail: { scope: "navigate" } }] : []),
		...(state.pause && state.pause.reason !== "consent_required" ? [{ seq: 10, type: "browser.blocked", at, recordedAt: 10, url: `https://${state.pause.domain}/`, domain: state.pause.domain, detail: { reason: state.pause.reason } }] : []),
		...(state.pause ? [{ seq: 11, type: "run.paused", at, recordedAt: 11, detail: { reason: state.pause.reason } }] : []),
		...(state.failure ? [{ seq: 12, type: "run.ended", at, recordedAt: 12, detail: { status: "failed" } }] : []),
	];
	const run = () => ({
		id: RUN_ID,
		instanceId: "inst-1",
		requestId: "q",
		objective: "Find senior TypeScript roles in Sydney",
		status: state.failure ? "failed" : state.pause ? "paused" : state.finished ? "completed" : "running",
		pauseReason: state.pause?.reason ?? null,
		errorCode: state.failure?.errorCode ?? null,
		error: state.failure?.error ?? null,
		policy: { engine: "claude", authMode: "subscription", workspace: { kind: "scratch" }, browserProfile: "isolated", mode: "research_only", allowDomains: ["seek.com.au"], denyDomains: [], limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 }, traceRetentionDays: 30, resultSchema: { id: "findings", version: 1 }, collection: { name: "job_leads" } },
		result: state.finished
			? { runId: RUN_ID, outcome: "completed", findings: [{ title: "Senior TypeScript Engineer", url: "https://seek.com.au/job/1", evidence: "Senior TypeScript Engineer — Sydney, hybrid", fields: { location: "Sydney" } }], sourceFailures: [], summary: "One matching role.", traceId: RUN_ID, engineAuth: "subscription" }
			: null,
		engineAuth: "subscription",
		runnerNode: "my-machine",
		findingReviews: state.saved ? { "0": { decision: "saved", collection: "job_leads", recordId: "rec_1", at: 1 } } : {},
		createdAt: 1,
		startedAt: 2,
		endedAt: state.finished || state.failure ? 3 : null,
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
			return json({
				ready: true,
				checks: [
					{ id: "settings", ok: true, detail: "" },
					{ id: "runner", ok: true, detail: "Connected on my-machine" },
					{ id: "runner_support", ok: true, detail: "" },
					{ id: "engine_login", ok: true, detail: "claude was signed in (subscription) (last checked 2026-10-07 01:00 UTC, run run-e2e-0)." },
				],
				engineAuth: { verdict: "subscription", runId: "run-e2e-0", observedAt: 1 },
			});
		}
		if (path === `${base}/settings` && method === "PUT") {
			const body = route.request().postDataJSON() as { access?: { allowDomains?: string[] } };
			recorded.settingsPuts.push(body);
			state.allowDomains = body.access?.allowDomains ?? [];
			return json({ settings: settings().settings, effective: null });
		}
		if (path === `${base}/settings`) return json(settings());
		if (path === `${base}/consent` && method === "PUT") {
			recorded.consentPuts.push(route.request().postDataJSON());
			return json({ consent: [] });
		}
		if (path === `${base}/consent`) return json({ consent: [] });
		if (path === `${base}/runs/${RUN_ID}/resume` && method === "POST") {
			recorded.resumes++;
			state.pause = null;
			return json(run());
		}
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
		// The Settings tab's trigger form previews its draft on load and reads `issues` off the answer;
		// `{}` crashes that section's error boundary and takes the whole tab — this section included — with it.
		if (path === "/v1/triggers/preview") return json({ schedule: null, timezone: null, issues: [] });
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
		// WHICH sign-in the engine used stays visible when the check passes (#945): subscription vs machine is the point.
		await expect(page.getByRole("list", { name: "Setup checklist" })).toContainText("Task engine signed in");
		await expect(page.getByRole("list", { name: "Setup checklist" })).toContainText("claude was signed in (subscription)");

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

test.describe("Research tab — a blocked run shows why, and offers only the step that unblocks it (#946)", () => {
	test("a new site: \"Allow <site> and resume\" records consent for exactly that site, then resumes", async ({ page }) => {
		const { recorded } = await mockResearchAgent(page, { pause: { reason: "consent_required", domain: "indeed.com" } });
		await page.goto(`/console/instances/inst-1/research/${RUN_ID}`);
		const banner = page.getByRole("alert");
		await expect(banner).toContainText("Open indeed.com?");
		// Only the one step — no captcha/sign-in action offered for a consent pause.
		await expect(banner.getByRole("button", { name: "I've done it — resume" })).toHaveCount(0);
		await banner.getByRole("button", { name: "Allow indeed.com and resume" }).click();
		await expect(page.getByRole("alert")).toHaveCount(0);
		expect(recorded.consentPuts).toEqual([{ scope: "navigate", domain: "indeed.com", decision: "allow" }]);
		expect(recorded.resumes).toBe(1);
	});

	test("a captcha: done by the owner in the browser on their machine, then \"I've done it — resume\" — and no consent is recorded", async ({ page }) => {
		const { recorded } = await mockResearchAgent(page, { pause: { reason: "captcha", domain: "seek.com.au" } });
		await page.goto(`/console/instances/inst-1/research/${RUN_ID}`);
		const banner = page.getByRole("alert");
		await expect(banner).toContainText("Captcha on seek.com.au");
		await expect(banner).toContainText("Solve it in the browser on my-machine");
		await expect(banner.getByRole("button", { name: /^Allow/ })).toHaveCount(0);
		await banner.getByRole("button", { name: "I've done it — resume" }).click();
		await expect(page.getByRole("alert")).toHaveCount(0);
		expect(recorded.consentPuts).toEqual([]);
		expect(recorded.resumes).toBe(1);
	});

	test("a sign-in wall is the owner's to do, on their machine — PAGS never signs in", async ({ page }) => {
		await mockResearchAgent(page, { pause: { reason: "login_required", domain: "seek.com.au" } });
		await page.goto(`/console/instances/inst-1/research/${RUN_ID}`);
		const banner = page.getByRole("alert");
		await expect(banner).toContainText("Sign-in on seek.com.au");
		await expect(banner).toContainText("in the browser on my-machine");
		await expect(banner.getByRole("button", { name: "I've done it — resume" })).toBeVisible();
	});

	test("a run whose CLI never used the browser says so, with the fix — not \"Finished\" (#944)", async ({ page }) => {
		const error = "The Codex CLI was refused the PAGS browser tools. No page was opened, so this run found nothing. Update the CLI on that machine (npm i -g @proagentstore/cli), restart `pags up`, and start the run again.";
		await mockResearchAgent(page, { failure: { errorCode: "engine_failed", error } });
		await page.goto(`/console/instances/inst-1/research/${RUN_ID}`);
		await expect(page.getByText("Failed", { exact: true })).toBeVisible();
		await expect(page.getByText(/The CLI stopped with an error\. The Codex CLI was refused the PAGS browser tools\. No page was opened/)).toBeVisible();
		await expect(page.getByText(/npm i -g @proagentstore\/cli/)).toBeVisible();
		await expect(page.getByRole("button", { name: /resume/i })).toHaveCount(0);
	});
});

test.describe("Agent Builder — the Local CLI browser research capability card (#946)", () => {
	test("switching the runtime to local_browser shows the card, explains who does what, and saves its defaults", async ({ page }) => {
		await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), TOKEN);
		const puts: Array<Record<string, unknown>> = [];
		const lb = { engines: ["claude", "codex"], mode: "research_only", subscriptionOnly: true, resultSchema: { id: "job_leads", version: 1 }, limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 }, allowDomains: [], denyDomains: [], collection: { name: "job_leads", keyField: "url" } };
		const caps = { runtime: null as string | null, localBrowser: null as unknown, surfaces: [] as string[], workflow: null, tools: [] as string[], customSurfaces: [], workflowOptions: [] };
		await page.route(`${API}/**`, async (route) => {
			const path = new URL(route.request().url()).pathname;
			const method = route.request().method();
			const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
			if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user", "creator"], boardConfig: null });
			if (path === "/v1/agents/agent-1") return json({ id: "agent-1", slug: "job-search-scout", name: "Job Search Scout", description: "Finds jobs", category: "productivity", visibility: "draft", status: "inactive", model: "claude-sonnet-4-6", owner_id: "user-1" });
			if (path === "/v1/agents/agent-1/capabilities" && method === "PUT") {
				const body = route.request().postDataJSON() as Record<string, unknown>;
				puts.push(body);
				if ("runtime" in body) {
					caps.runtime = body.runtime as string | null;
					caps.localBrowser = caps.runtime === "local_browser" ? lb : null;
				}
				if (body.localBrowser) caps.localBrowser = { ...lb, ...(body.localBrowser as object) };
				return json(caps);
			}
			if (path === "/v1/agents/agent-1/capabilities") return json(caps);
			return json({});
		});

		await page.goto("/console/agents/agent-1");
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page.getByLabel(/Runtime/).selectOption("local_browser");
		// Before the runtime is SAVED the card says what to do, rather than editing defaults that cannot be stored.
		await expect(page.getByText("Save the capabilities above with runtime local_browser")).toBeVisible();
		await page.getByRole("button", { name: "Save capabilities" }).click();
		await expect.poll(() => puts[0]).toMatchObject({ runtime: "local_browser" });

		const card = page.locator("div", { has: page.getByRole("heading", { name: "Local CLI browser research" }) }).last();
		await expect(card).toContainText("PAGS supervises");
		await expect(card).toContainText("the local CLI drives the browser");
		await expect(card).toContainText("Research only: no forms, applications or messages.");
		await expect(card.getByText(/repositor|GitHub/i)).toHaveCount(0);

		await card.getByLabel("Allowed sites").fill("seek.com.au\nindeed.com");
		await card.getByLabel("Codex").uncheck();
		await card.getByRole("button", { name: "Save research defaults" }).click();
		await expect(card.getByText("Saved.")).toBeVisible();
		expect(puts.at(-1)).toMatchObject({ localBrowser: { engines: ["claude"], subscriptionOnly: true, allowDomains: ["seek.com.au", "indeed.com"], collection: { name: "job_leads" } } });
	});
});

/**
 * Phone geometry for the three research screens (#946 "responsive"). Named `mobile — ` so the WebKit
 * project runs them too (playwright.config.ts greps on that prefix). The measure is the console
 * spec's: anything past the window's right edge outside a deliberate scroller, or past its OWN
 * container — the two shapes a phone user feels as sideways panning or overlapping controls.
 */
async function overflowAt(page: Page) {
	return page.evaluate(() => {
		const name = (h: Element) => `${h.tagName.toLowerCase()}.${(typeof (h as HTMLElement).className === "string" ? (h as HTMLElement).className : "").split(/\s+/).slice(0, 3).join(".")}`;
		const main = document.querySelector("main");
		const inScroller = (el: Element) => {
			for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
				if (p === main) continue;
				const ox = getComputedStyle(p).overflowX;
				if (ox === "auto" || ox === "scroll") return true;
			}
			return false;
		};
		const wide: string[] = [];
		const escapes: string[] = [];
		for (const el of Array.from(document.body.querySelectorAll("*"))) {
			const r = el.getBoundingClientRect();
			if (r.width <= 0) continue;
			if (r.right > window.innerWidth + 1 && !inScroller(el)) wide.push(`${name(el)} (right ${Math.round(r.right)})`);
			const p = el.parentElement;
			if (!p || p === document.body) continue;
			const pos = getComputedStyle(el).position;
			if (pos === "absolute" || pos === "fixed") continue;
			const ps = getComputedStyle(p);
			if (ps.overflowX !== "visible") continue;
			const limit = p.getBoundingClientRect().right - (Number.parseFloat(ps.borderRightWidth) || 0) - (Number.parseFloat(ps.paddingRight) || 0);
			if (r.right - limit > 1) escapes.push(`${name(el)} escapes ${name(p)} by ${Math.round(r.right - limit)}px`);
		}
		return { docOv: document.documentElement.scrollWidth - window.innerWidth, mainOv: main ? main.scrollWidth - main.clientWidth : 0, wide, escapes };
	});
}

async function expectFits(page: Page, width: number, what: string) {
	const { docOv, mainOv, wide, escapes } = await overflowAt(page);
	expect(docOv, `${what}: page overflows by ${docOv}px at ${width}px`).toBeLessThanOrEqual(1);
	expect(mainOv, `${what}: <main> overflows by ${mainOv}px at ${width}px`).toBeLessThanOrEqual(1);
	expect(wide, `${what}: content past the right edge at ${width}px`).toEqual([]);
	expect(escapes, `${what}: a box past its own container at ${width}px`).toEqual([]);
}

test.describe("mobile — the research screens fit a phone (#946)", () => {
	for (const width of [320, 390]) {
		test(`mobile — the Research tab fits at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockResearchAgent(page);
			await page.goto("/console/instances/inst-1/research");
			await expect(page.getByRole("list", { name: "Setup checklist" })).toContainText("Task engine signed in");
			await expect(page.getByRole("button", { name: "Start research" })).toBeVisible();
			await expectFits(page, width, "Research tab");
		});

		test(`mobile — the run page fits at ${width}px, pause banner and trace included`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockResearchAgent(page, { pause: { reason: "consent_required", domain: "a-very-long-job-board-domain.example.com.au" } });
			await page.goto(`/console/instances/inst-1/research/${RUN_ID}`);
			const allow = page.getByRole("button", { name: /^Allow a-very-long-job-board-domain/ });
			await expect(allow).toBeVisible();
			await expect(page.getByRole("list", { name: "Run steps" })).toContainText("Local CLI started");
			// The one action must be reachable, not clipped off the edge.
			const box = await allow.boundingBox();
			expect(box && box.x + box.width, "the pause action is past the right edge").toBeLessThanOrEqual(width);
			await expectFits(page, width, "run page");
		});

		test(`mobile — the Local browser research settings fit at ${width}px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 812 });
			await mockResearchAgent(page);
			await page.goto("/console/instances/inst-1/settings");
			const section = page.locator("div", { has: page.getByRole("heading", { name: "Local browser research" }) }).last();
			await expect(section.getByRole("button", { name: "Save research settings" })).toBeVisible();
			await expectFits(page, width, "settings section");
		});
	}
});
