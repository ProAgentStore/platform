import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * #1068 — an unconfirmed submit's card offers the owner the read-only "was it sent?" check (#1013's
 * reconciliation), in the real console bundle. The API and the Runner are mocked; the server half is
 * held by `application-runner-routes.test.ts`. This proves the console half: the check is shown only
 * for that exact attempt, it asks the run's OWN Runner, and when the site needs a sign-in it opens the
 * bounded read-only handoff — never a retry or a submit.
 */
const API = "https://api.proagentstore.online";
const TOKEN = "test-pags-token";
const RUN = "run-uc-1";
const HANDOFF = "handoff-uc-1";

type Check = { state: string; runner?: { state: string; pauseReason?: string } };

async function mockRunner(page: Page, opts: { blockReason: string; submitAttempted: boolean; check: Check; actions?: string[]; bodies?: unknown[] }) {
	await page.addInitScript((t) => window.localStorage.setItem("pags:session", t), TOKEN);
	const posts: string[] = [];
	const at = "2026-10-14T06:29:03Z";
	const item = {
		key: "app:app-1", kind: "application", status: "blocked", title: "Director of Engineering APAC", company: "Gentrack", location: "Melbourne VIC",
		url: "https://au.seek.com/job/1", source: "SEEK", postedDate: null, matchRationale: null, scoutInstanceId: "scout-1", leadId: "lead-1", leadVersion: 1,
		applicationId: "app-1", tailorInstanceId: "tailor-1", stateVersion: 22, blockReason: opts.blockReason,
		questions: ["The application was submitted but the site did not confirm it. Check the employer's site or your email before anything is retried."],
		artifacts: null, profileVersion: null, tailoringRunId: null, fillRunId: RUN, fillRun: { id: RUN, status: "blocked", mode: "auto_submit", pause: null },
		submittedAt: null, submittedUrl: null, submitAttempted: opts.submitAttempted, submitPolicy: null, fillProgress: null,
		execution: { currentRun: { id: RUN, kind: "fill", status: "blocked", instanceId: "runner-1", mode: "auto_submit" } },
		diagnostic: null, queue: null, submitAuthorization: null, updatedAt: at, actions: opts.actions ?? ["defer", "archive"],
	};
	await page.route(`${API}/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		const method = route.request().method();
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (method === "POST") posts.push(path);
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", avatar: "https://example.com/a.png", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [{ id: "runner-1", name: "Job Application Runner", slug: "job-application-runner", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: "local_apply", workflow: null } }] });
		if (path === "/v1/instances/runner-1/runtime/status") return json({ runtime: { instanceId: "runner-1", status: "online", runnerNode: "my-machine" }, relay: { connected: true, runnerNode: "my-machine", live: true }, attachment: { state: "attached", message: "Connected.", remedy: null } });
		if (path === "/v1/instances/runner-1/application-queue") {
			return json({ pipeline: { scouts: [], tailors: [], runners: [] }, items: [item], counts: { blocked: 1 }, limits: [], connections: [], notes: [] });
		}
		if (path === `/v1/instances/runner-1/application-runs/${RUN}/reconciliation` && method === "POST") {
			return json({ reconciliation: { id: "rec-1", runId: RUN, applicationId: "app-1", state: opts.check.state, proofKind: null }, ...(opts.check.runner ? { runner: opts.check.runner } : {}) }, 202);
		}
		if (path === `/v1/instances/runner-1/application-runs/${RUN}/reconciliation/handoff` && method === "POST") {
			return json({ handoff: { id: HANDOFF, runId: RUN, applicationId: "app-1", state: "active", expiresAt: "2026-10-14T06:39:03Z", reason: null }, consoleLink: `/console/instances/runner-1/applications?reconciliation_handoff=${HANDOFF}` }, 201);
		}
		if (path === `/v1/instances/runner-1/application-reconciliation-handoffs/${HANDOFF}`) return json({ id: HANDOFF, runId: RUN, applicationId: "app-1", state: "active", expiresAt: "2026-10-14T06:39:03Z", reason: null });
		if (path.endsWith("/reconciliation/handoff/frame")) return json({ frame: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='480'%3E%3C/svg%3E", width: 320, height: 480 });
		if (path.includes("/connections/deliveries")) return json({ deliveries: [] });
		if (path === "/v1/instances/runner-1/application-queue/actions" && method === "POST") {
			opts.bodies?.push(route.request().postDataJSON());
			return json({ item: { ...item, actions: ["retry_fill", "defer", "archive"] }, result: { retryAllowed: true } });
		}
		return json({});
	});
	return posts;
}

/** The queue lists rows; a row opens its card. */
async function openCard(page: Page) {
	await page.goto("/console/instances/runner-1/applications");
	await page.getByRole("button", { name: /Director of Engineering APAC/ }).click();
}

test("an unconfirmed submit offers the read-only check; a sign-in wall opens the read-only handoff (#1068)", async ({ page }) => {
	const posts = await mockRunner(page, { blockReason: "submit_unconfirmed", submitAttempted: true, check: { state: "requested", runner: { state: "paused", pauseReason: "login_required" } } });
	await openCard(page);
	const check = page.getByTestId("check-submission");
	await expect(check).toBeVisible();
	await expect(check).toHaveText("Check the employer's site (read-only)");
	// Only the server's own actions sit beside it — no retry is invented for an attempted submit.
	await expect(page.getByRole("group", { name: /^Actions for / }).getByRole("button", { name: /retry|submit|approve|resume/i })).toHaveCount(0);
	await check.click();
	await expect(page).toHaveURL(new RegExp(`/console/instances/runner-1/applications\\?reconciliation_handoff=${HANDOFF}$`));
	await expect(page.getByText("Read-only application reconciliation")).toBeVisible();
	// It asked the run's OWN Runner, and asked for nothing else.
	expect(posts).toEqual([`/v1/instances/runner-1/application-runs/${RUN}/reconciliation`, `/v1/instances/runner-1/application-runs/${RUN}/reconciliation/handoff`]);
});

test("a machine that is away is said plainly, and no handoff is opened (#1068)", async ({ page }) => {
	const posts = await mockRunner(page, { blockReason: "submit_unconfirmed", submitAttempted: true, check: { state: "requested", runner: { state: "waiting_for_runtime" } } });
	await openCard(page);
	await page.getByTestId("check-submission").click();
	await expect(page.getByText(/Runner's machine is not connected/)).toBeVisible();
	expect(posts).toEqual([`/v1/instances/runner-1/application-runs/${RUN}/reconciliation`]);
});

test("a blocked card that is NOT an unconfirmed submit shows no check (#1068)", async ({ page }) => {
	await mockRunner(page, { blockReason: "incomplete", submitAttempted: false, check: { state: "requested" } });
	await openCard(page);
	await expect(page.getByRole("heading", { name: "Director of Engineering APAC" })).toBeVisible();
	await expect(page.getByTestId("check-submission")).toHaveCount(0);
});

test("the owner's 'nothing was sent' assertion: their words, the exact declaration, this attempt (#1073)", async ({ page }) => {
	const bodies: unknown[] = [];
	await mockRunner(page, { blockReason: "submit_unconfirmed", submitAttempted: true, check: { state: "requested" }, actions: ["assert_not_submitted", "defer", "archive"], bodies });
	const dialogs: string[] = [];
	page.on("dialog", async (d) => {
		dialogs.push(`${d.type()}: ${d.message()}`);
		if (d.type() === "prompt") await d.accept("SEEK Applied jobs does not list it.");
		else await d.accept();
	});
	await openCard(page);
	await page.getByRole("group", { name: /^Actions for / }).getByRole("button", { name: "I checked — nothing was sent" }).click();
	await expect.poll(() => bodies.length).toBe(1);
	expect(bodies[0]).toEqual({ action: "assert_not_submitted", expected_status: "blocked", application_id: "app-1", expected_version: 22, fill_run_id: RUN, statement: "SEEK Applied jobs does not list it.", confirm: "I checked the employer site and nothing was submitted", surface: "console" });
	expect(dialogs[0]).toMatch(/^prompt: What did you check/);
	expect(dialogs[1]).toMatch(/^confirm: "I checked the employer site and nothing was submitted\." This is recorded as YOUR assertion/);
});

test("dismissing the statement prompt records nothing (#1073)", async ({ page }) => {
	const bodies: unknown[] = [];
	await mockRunner(page, { blockReason: "submit_unconfirmed", submitAttempted: true, check: { state: "requested" }, actions: ["assert_not_submitted", "defer", "archive"], bodies });
	page.on("dialog", (d) => d.dismiss());
	await openCard(page);
	await page.getByRole("group", { name: /^Actions for / }).getByRole("button", { name: "I checked — nothing was sent" }).click();
	await page.waitForTimeout(300);
	expect(bodies).toEqual([]);
});
