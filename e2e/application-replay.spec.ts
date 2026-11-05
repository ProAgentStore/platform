import { expect, test, type Locator, type Page } from "@playwright/test";

// #1464: each replay position must show its own bytes, capture time and action evidence.
// The real console is rendered; every account/API request is answered by synthetic fixtures.
const API = "https://api.proagentstore.online";
const JOB_URL = "https://au.seek.com/job/95534692";
const LOGIN_URL = "https://login.seek.com/login";
const INSTANCE = { id: "runner-1", name: "Job Application Runner", slug: "job-application-runner", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: [], runtime: "local_apply", workflow: null } };
const application = {
	key: "app:app-1", kind: "application", status: "blocked", title: "Release Train Engineer", company: "Example Employer", location: "Melbourne",
	url: JOB_URL, source: "SEEK", postedDate: null, matchRationale: null, scoutInstanceId: "scout-1", leadId: "lead-1", leadVersion: 1,
	applicationId: "app-1", tailorInstanceId: "tailor-1", stateVersion: 3, blockReason: "login_required", questions: [],
	artifacts: null, profileVersion: null, tailoringRunId: null, fillRunId: "run-1", fillRun: null,
	submittedAt: null, submittedUrl: null, submitAttempted: false, submitPolicy: null, fillProgress: null,
	execution: null, diagnostic: null, queue: null, submitAuthorization: null, updatedAt: "2026-11-03T11:00:00Z", actions: [],
};

async function mockReplay(page: Page, options: { missing?: number; longUrl?: boolean; livePause?: boolean; liveUpdates?: boolean; screenshotsOff?: boolean; emptyFrames?: boolean; handoff?: "active" | "wrong_run" | "wrong_app" | "ended"; running?: boolean; pauseRefused?: boolean } = {}) {
	await page.addInitScript(() => window.localStorage.setItem("pags:session", "test-pags-token"));
	const item = options.running ? { ...application, status: "filling", fillRun: { id: "run-1", status: "running", mode: "dry_run", pause: null } } : options.livePause ? { ...application, fillRun: { id: "run-1", status: "paused", mode: "dry_run", pause: { reason: "login_required", url: LOGIN_URL } }, actions: ["resume"] } : application;
	const jobUrl = options.longUrl ? `https://jobs.example.com/${"long-path-segment".repeat(18)}` : JOB_URL;
	const frames = [
		{ seq: 1, point: "navigated", action: "browser_navigate", target: null, url: jobUrl, capturedAt: "2026-11-03T10:45:45Z" },
		{ seq: 2, point: "clicked", action: "browser_click", target: "Apply", url: jobUrl, capturedAt: "2026-11-03T10:46:05Z" },
		{ seq: 3, point: "blocked", action: "browser_click", target: "Apply", url: LOGIN_URL, capturedAt: "2026-11-03T10:46:14Z" },
	].map((frame) => ({ ...frame, id: `frame-${frame.seq}`, subjectKind: "local_apply_run", subjectId: "run-1", contentType: "image/svg+xml", bytes: 100, domain: new URL(frame.url).hostname, createdAt: "2026-11-03T11:00:00Z" }));
	const entries = [
		{ type: "browser.navigated", detail: { url: `${jobUrl}?token=never-show-this#private` } },
		{ type: "policy.decision", detail: { tool: "browser_click", decision: "allowed", target: "Apply" } },
		{ type: "policy.decision", detail: { tool: "browser_click", class: "action", decision: "completed", target: "Apply", url: jobUrl } },
		{ type: "browser.blocked", detail: { reason: "login_required", url: LOGIN_URL } },
	].map((entry, index) => ({ ...entry, at: `2026-11-03T10:46:0${index}Z`, source: "runner", instanceId: "runner-1", runId: "run-1" }));
	let traceReads = 0, artifactReads = 0;
	await page.route(`${API}/**`, (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		if (path === "/v1/instances/runner-1/application-runs/run-1/handoff" && route.request().method() === "POST") return options.pauseRefused ? json({ error: "Native action is still settling. Retry the pause request." }, 409) : json({ handoff: { id: "handoff-1", applicationId: "app-1", runId: "run-1", state: "active", reason: "owner_requested" } });
		if (path === "/v1/instances/runner-1/application-handoffs/handoff-1") return json({ id: "handoff-1", applicationId: options.handoff === "wrong_app" ? "other-app" : "app-1", runId: options.handoff === "wrong_run" ? "other-run" : "run-1", state: options.handoff === "ended" ? "ended" : "active", reason: "login_required" });
		if (path === "/v1/instances/runner-1/application-runs/run-1/handoff/frame") return json({ frame: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#ffff00"/></svg>').toString("base64"), width: 1280, height: 720 });
		if (path === "/v1/auth/me") return json({ id: "user-1", login: "tester", name: "Test User", display_name: "Test User", roles: ["user"], boardConfig: null });
		if (path === "/v1/instances/my/instances") return json({ instances: [INSTANCE] });
		if (path === "/v1/instances/runner-1/application-queue/item") return json({ item });
		if (path === "/v1/instances/runner-1/application-queue") return json({ pipeline: { scouts: [], tailors: [], runners: [] }, items: [item], counts: { blocked: 1 }, limits: [], connections: [], notes: [] });
		if (path === "/v1/instances/runner-1/application-queue/app-1/trace") return json({ applicationId: "app-1", correlation: {}, entries: options.liveUpdates && ++traceReads > 1 ? [...entries, { at: "2026-11-03T10:47:00Z", source: "runner", type: "field.filled", detail: { target: "Email" } }] : entries });
		if (path === "/v1/instances/runner-1/browser-artifacts") return json({ subjectKind: "local_apply_run", subjectId: "run-1", artifacts: options.screenshotsOff || options.emptyFrames ? [] : options.liveUpdates && ++artifactReads === 1 ? frames.filter((frame) => frame.seq < 3) : frames, screenshotsOff: options.screenshotsOff === true });
		const frame = path.match(/\/browser-artifacts\/frame-(\d)$/);
		if (frame) {
			const seq = Number(frame[1]);
			if (seq === options.missing) return json({ error: "Frame unavailable" }, 404);
			const color = ["#ff0000", "#00ff00", "#0000ff"][seq - 1];
			return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="${color}"/><text x="100" y="120" fill="white" font-size="40">Synthetic frame ${seq}</text></svg>` });
		}
		if (path.includes("/connections/deliveries")) return json({ deliveries: [] });
		return json({});
	});
	await page.goto(`/console/instances/runner-1/applications/app-1${options.handoff ? "?handoff=handoff-1" : ""}`);
	return page.getByTestId("run-replay");
}

async function renderedPixel(image: Locator): Promise<number[]> {
	await expect(image).toBeVisible();
	await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
	return image.evaluate((element) => {
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const ctx = canvas.getContext("2d")!;
		ctx.drawImage(element as HTMLImageElement, 0, 0);
		return Array.from(ctx.getImageData(0, 0, 1, 1).data);
	});
}

test.use({ locale: "en-AU", timezoneId: "UTC" });

test("replay switches actual frame pixels, labels and capture timestamps", async ({ page }) => {
	const replay = await mockReplay(page);
	await expect(page.getByText("Stopped: login required", { exact: true })).toBeVisible();
	await expect(page.getByText("Waiting: login required", { exact: true })).toHaveCount(0);
	const image = replay.getByRole("img");
	await expect(replay.getByRole("slider", { name: "Frame" })).toHaveAttribute("aria-valuetext", "Frame 1 of 3");
	await expect(replay.getByTestId("replay-caption")).toContainText(`Opened — ${JOB_URL}`);
	await expect(replay).toContainText("Captured 10:45:45");
	expect(await renderedPixel(image)).toEqual([255, 0, 0, 255]);
	const firstSource = await image.getAttribute("src");
	await replay.getByRole("button", { name: "Next", exact: true }).click();
	await expect(replay.getByTestId("replay-caption")).toContainText(`Clicked “Apply” — ${JOB_URL}`);
	await expect(replay).toContainText("Captured 10:46:05");
	expect(await renderedPixel(image)).toEqual([0, 255, 0, 255]);
	expect(await image.getAttribute("src")).not.toBe(firstSource);
	await replay.getByRole("slider", { name: "Frame" }).fill("2");
	await expect(replay.getByTestId("replay-caption")).toContainText(LOGIN_URL);
	await expect(replay).toContainText("Captured 10:46:14");
	expect(await renderedPixel(image)).toEqual([0, 0, 255, 255]);
	await replay.getByRole("button", { name: "Previous", exact: true }).click();
	expect(await renderedPixel(image)).toEqual([0, 255, 0, 255]);
	await expect(page.getByRole("heading", { name: "Live steps", exact: true })).toBeVisible();
	const trace = page.getByRole("list", { name: "Application trace" });
	await expect(trace).toContainText(`Opened page — ${JOB_URL}`);
	await expect(trace).toContainText("Allowed click “Apply”");
	await expect(trace).toContainText(`Clicked “Apply” — ${JOB_URL}`);
	await expect(trace).not.toContainText("never-show-this");
	await replay.screenshot({ path: "/tmp/pags1464-replay-ui.png" });
});

test("a live browser pause remains waiting and offers Resume", async ({ page }) => {
	await mockReplay(page, { livePause: true });
	await expect(page.getByText("Waiting: login required", { exact: true })).toBeVisible();
	await expect(page.getByText("Stopped: login required", { exact: true })).toHaveCount(0);
	await expect(page.getByText(`At ${LOGIN_URL} — open the runner's browser window on your machine to handle it, then Resume.`)).toBeVisible();
	await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
});

test("an unavailable frame does not reuse the preceding image or remain loading", async ({ page }) => {
	const replay = await mockReplay(page, { missing: 2 });
	expect(await renderedPixel(replay.getByRole("img"))).toEqual([255, 0, 0, 255]);
	await replay.getByRole("button", { name: "Next", exact: true }).click();
	await expect(replay).toContainText("Screenshot unavailable for this frame.");
	await expect(replay.getByRole("img")).toHaveCount(0);
	await expect(replay).not.toContainText("Loading screenshot");
	await replay.getByRole("button", { name: "Next", exact: true }).click();
	expect(await renderedPixel(replay.getByRole("img"))).toEqual([0, 0, 255, 255]);
});

test("mobile — replay and descriptive trace wrap long URLs within 375px", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	const replay = await mockReplay(page, { longUrl: true });
	await expect(replay.getByRole("img")).toBeVisible();
	await expect(page.getByRole("heading", { name: "Live steps", exact: true })).toBeVisible();
	await expect(page.getByRole("list", { name: "Application trace" })).toContainText("Allowed click “Apply”");
	await replay.scrollIntoViewIfNeeded();
	const box = await replay.boundingBox();
	expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true);
	expect(await replay.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
	expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
	await page.screenshot({ path: "/tmp/pags1464-replay-mobile.png", fullPage: true });
});


test("standalone detail refreshes live steps and screenshots without a state-version change", async ({ page }) => {
	const replay = await mockReplay(page, { liveUpdates: true });
	await expect(replay.getByRole("slider", { name: "Frame" })).toHaveAttribute("aria-valuetext", "Frame 1 of 2");
	await expect(page.getByRole("list", { name: "Application trace" })).not.toContainText("Filled field “Email”");
	await page.evaluate(() => { (window as unknown as { applicationPageSentinel: string }).applicationPageSentinel = "same-page"; });
	await expect(page.getByRole("list", { name: "Application trace" })).toContainText("Filled field “Email”", { timeout: 12000 });
	await expect(replay.getByRole("slider", { name: "Frame" })).toHaveAttribute("aria-valuetext", "Frame 1 of 3", { timeout: 12000 });
	expect(await page.evaluate(() => (window as unknown as { applicationPageSentinel: string }).applicationPageSentinel)).toBe("same-page");
	await replay.getByRole("slider", { name: "Frame" }).fill("2");
	expect(await renderedPixel(replay.getByRole("img"))).toEqual([0, 0, 255, 255]);
	await expect(page.getByRole("group", { name: "Filter by status" })).toHaveCount(0);
});


test("standalone replay shows the run's recorded screenshots-off setting", async ({ page }) => {
	let imageRequests = 0;
	page.on("request", (request) => { if (/\/browser-artifacts\/frame-/.test(request.url())) imageRequests++; });
	await mockReplay(page, { screenshotsOff: true });
	await expect(page.getByTestId("replay-empty")).toContainText("Screenshots were off for this run");
	await expect(page.getByTestId("replay-empty")).toContainText("Turn it on in Settings");
	await expect(page.getByRole("slider", { name: "Frame" })).toHaveAttribute("aria-valuetext", "Live browser");
	await expect(page.getByRole("list", { name: "Application trace" })).toContainText("Allowed click “Apply”");
	expect(imageRequests).toBe(0);
});

test("standalone replay does not infer screenshots-off from an empty artifact list", async ({ page }) => {
	await mockReplay(page, { emptyFrames: true });
	await expect(page.getByTestId("replay-empty")).toContainText("No screenshots captured yet");
	await expect(page.getByTestId("replay-empty")).not.toContainText("Screenshots were off");
});

for (const width of [375, 1280]) {
	test(`mobile — responsive history ends at the exact live browser with explicit takeover at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 812 });
		const replay = await mockReplay(page, { handoff: "active" });
		await expect(replay.getByRole("slider")).toHaveAttribute("max", "3");
		await replay.getByRole("slider").fill("3");
		await expect(replay.getByRole("slider")).toHaveAttribute("aria-valuetext", "Live browser");
		expect(await renderedPixel(replay.getByRole("img"))).toEqual([255, 255, 0, 255]);
		await expect(replay.getByTestId("replay-caption")).toHaveCount(0);
		await expect(replay.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
		expect(await replay.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
		await replay.screenshot({ path: `/tmp/pags-live-slider-${width}.png` });
		await replay.getByRole("button", { name: "Previous", exact: true }).click();
		expect(await renderedPixel(replay.getByRole("img"))).toEqual([0, 0, 255, 255]);
		await expect(replay.getByRole("button", { name: "Take over live browser", exact: true })).toHaveCount(0);
		await replay.getByRole("button", { name: "Live browser →", exact: true }).click();
		await replay.getByRole("button", { name: "Take over live browser", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Live Application Runner browser control" })).toBeVisible();
	});
}
for (const handoff of [undefined, "wrong_run", "wrong_app", "ended"] as const) {
	test(`live endpoint refuses missing or mismatched authorization: ${handoff}`, async ({ page }) => {
		let frameRequests = 0;
		page.on("request", (request) => { if (request.url().includes("/handoff/frame")) frameRequests++; });
		const replay = await mockReplay(page, { handoff });
		await replay.getByRole("slider").fill("3");
		await expect(replay).toContainText("Live takeover is unavailable for this run");
		await expect(replay.getByRole("img")).toHaveCount(0);
		await expect(replay.getByRole("button", { name: "Take over live browser", exact: true })).toHaveCount(0);
		expect(frameRequests).toBe(0);
	});
}

test("entering Live never pauses the agent; an explicit click requests settled control", async ({ page }) => {
	const writes: unknown[] = [];
	page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/handoff")) writes.push(request.postDataJSON()); });
	const replay = await mockReplay(page, { running: true });
	await replay.getByRole("slider").fill("3");
	await expect(replay.getByRole("button", { name: "Pause and take control", exact: true })).toBeVisible();
	expect(writes).toEqual([]);
	await replay.getByRole("button", { name: "Pause and take control", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Live Application Runner browser control" })).toBeVisible();
	expect(writes).toEqual([{ pause: true }]);
	await expect(page).toHaveURL(/handoff=handoff-1/);
});

test("an unsettled or unsupported pause never enables live input", async ({ page }) => {
	const replay = await mockReplay(page, { running: true, pauseRefused: true });
	await replay.getByRole("slider").fill("3");
	await replay.getByRole("button", { name: "Pause and take control", exact: true }).click();
	await expect(replay.getByRole("alert")).toContainText("still settling");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(replay.getByRole("button", { name: "Pause and take control", exact: true })).toBeEnabled();
});
