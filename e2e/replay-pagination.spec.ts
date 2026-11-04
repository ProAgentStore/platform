import { expect, test, type Page } from "@playwright/test";
const API = "https://api.proagentstore.online";

async function replayFixture(page: Page, total: number, failHistory = false, holdFirst = false) {
	const images: number[] = [];
	let fail = failHistory;
	let releaseFirst: () => void = () => {};
	const firstImageReady = new Promise<void>((resolve) => { releaseFirst = resolve; });
	await page.addInitScript(() => window.localStorage.setItem("pags:session", "synthetic-replay-token"));
	const item = { key: "app:app-1", kind: "application", applicationId: "app-1", status: "filling", title: "Long application", company: "Example", location: null, url: "https://jobs.example.com/", source: null, postedDate: null, matchRationale: null, scoutInstanceId: "scout", leadId: "lead", leadVersion: 1, tailorInstanceId: "tailor", stateVersion: 1, blockReason: null, questions: [], artifacts: null, profileVersion: null, tailoringRunId: null, fillRunId: "run-1", fillRun: null, submittedAt: null, submittedUrl: null, submitAttempted: false, submitPolicy: null, fillProgress: null, execution: null, diagnostic: null, queue: null, submitAuthorization: null, updatedAt: "2026-11-04T00:00:00Z", actions: [] };
	await page.route(`${API}/**`, async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (path === "/v1/auth/me") return json({ id: "owner", login: "tester", name: "Test Owner", display_name: "Test Owner", roles: ["user"] });
		if (path === "/v1/instances/my/instances") return json({ instances: [{ id: "runner", name: "Application Runner", slug: "job-application-runner", category: "productivity", capabilities: { surfaces: [], runtime: "local_apply", workflow: null } }] });
		if (path.endsWith("/application-queue")) return json({ pipeline: { scouts: [], tailors: [], runners: [] }, items: [], counts: {}, limits: [], connections: [], notes: [] });
		if (path.endsWith("/application-queue/item")) return json({ item });
		if (path.endsWith("/trace")) return json({ applicationId: "app-1", entries: [] });
		if (path.endsWith("/browser-artifacts")) {
			const after = Number(url.searchParams.get("cursor") ?? -1);
			const limit = Number(url.searchParams.get("limit") ?? 500);
			if (fail && after === 100) return json({ error: "Synthetic history page unavailable" }, 503);
			const first = Math.max(1, after + 1);
			const artifacts = Array.from({ length: Math.max(0, Math.min(limit, total - first + 1)) }, (_, index) => {
				const seq = first + index;
				return { id: `frame-${seq}`, subjectKind: "local_apply_run", subjectId: "run-1", seq, point: "snapshot", contentType: "image/svg+xml", bytes: 100, url: "https://jobs.example.com/", domain: "jobs.example.com", action: "browser_snapshot", capturedAt: "2026-11-04T00:00:00Z", createdAt: "2026-11-04T00:00:00Z" };
			});
			const last = artifacts.at(-1)?.seq ?? after;
			return json({ subjectKind: "local_apply_run", subjectId: "run-1", artifacts, hasMore: last < total, nextCursor: last < total ? String(last) : null, screenshotsOff: false, coverage: { basis: "stored_local_capture_sequences", storedFrames: total, firstStoredSeq: 1, lastStoredSeq: total, missingRanges: [], rangesTruncated: false, notice: "Stored history only; not the current browser screen." } });
		}
		const frame = path.match(/\/browser-artifacts\/frame-(\d+)$/);
		if (frame) {
			images.push(Number(frame[1]));
			if (holdFirst && frame[1] === "1") await firstImageReady;
			return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#075"/><text x="20" y="80" fill="white" font-size="30">Stored frame ${frame[1]}</text></svg>` });
		}
		return json({});
	});
	await page.goto("/console/instances/runner/applications/app-1");
	return { images, releaseFirst, recover: () => { fail = false; } };
}

test("a long replay reaches newest stored frame and preserves selection while backfilling", async ({ page }) => {
	const { images } = await replayFixture(page, 1200);
	const replay = page.getByTestId("run-replay");
	await expect(replay.getByRole("slider", { name: "Frame" })).toHaveAttribute("max", "1099");
	await expect(replay.getByTestId("replay-history-status")).toContainText("History pagination is incomplete");
	await replay.getByRole("slider", { name: "Frame" }).fill("1099");
	await expect(replay.getByRole("img")).toHaveAttribute("alt", /^Frame 1200:/);
	await expect.poll(() => images.includes(1200)).toBe(true);
	expect(images.length).toBeLessThan(12);
	await replay.getByRole("button", { name: "Load more history" }).click();
	await expect(replay.getByRole("slider", { name: "Frame" })).toHaveAttribute("max", "1199");
	await expect(replay.getByRole("img")).toHaveAttribute("alt", /^Frame 1200:/);
	await expect(replay.getByTestId("replay-history-status")).toContainText("All currently listed stored screenshots are loaded");
});

test("failed history page keeps loaded frames and reports incomplete until retry succeeds", async ({ page }) => {
	const { recover } = await replayFixture(page, 650, true);
	const replay = page.getByTestId("run-replay");
	await expect(replay.getByTestId("replay-history-status")).toContainText("history is incomplete");
	await expect(replay.getByTestId("replay-history-status")).not.toContainText("All currently listed");
	await expect(replay.getByRole("img")).toBeVisible();
	recover();
	await replay.getByRole("button", { name: "Retry screenshot history" }).click();
	await expect(replay.getByRole("slider", { name: "Frame" })).toHaveAttribute("max", "649");
	await expect(replay.getByTestId("replay-history-status")).toContainText("All currently listed stored screenshots are loaded");
});


test("ordinary task replay respects the run's recorded screenshots-off mode", async ({ page }) => {
	await page.addInitScript(() => window.localStorage.setItem("pags:session", "synthetic-replay-token"));
	await page.route(`${API}/**`, (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
		if (path === "/v1/auth/me") return json({ id: "owner", login: "tester", name: "Test Owner", roles: ["user"] });
		if (path.endsWith("/my/instances")) return json({ instances: [] });
		if (path.endsWith("/tasks/task-1")) return json({ id: "task-1", type: "browser.task", status: "completed", title: "Browser task", input: {}, createdAt: "2026-11-04T00:00:00Z" });
		if (path.endsWith("/task-events")) return json({ events: [] });
		if (path.endsWith("/actions")) return json({ entries: [], hasMore: false, nextCursor: null, tail: null, total: 0 });
		if (path.endsWith("/thread")) return json({ turns: [] });
		if (path.endsWith("/browser-takeovers")) return json({ takeovers: [] });
		if (path.endsWith("/browser-artifacts")) return json({ subjectKind: "runtime_task", subjectId: "task-1", artifacts: [], hasMore: false, nextCursor: null, screenshotsOff: true });
		return json({});
	});
	await page.goto("/console/instances/runner/tasks/task-1");
	await expect(page.getByTestId("replay-empty")).toContainText("Screenshots were off for this run");
	await expect(page.getByRole("slider", { name: "Frame" })).toHaveCount(0);
});


test("switching task routes cannot reuse a preceding task's legacy screenshot or caption", async ({ page }) => {
	await page.addInitScript(() => window.localStorage.setItem("pags:session", "synthetic-replay-token"));
	let releaseSecond: () => void = () => {};
	const secondReady = new Promise<void>((resolve) => { releaseSecond = resolve; });
	await page.route(`${API}/**`, async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
		if (path === "/v1/auth/me") return json({ id: "owner", login: "tester", name: "Test Owner", roles: ["user"] });
		if (path.endsWith("/my/instances")) return json({ instances: [] });
		const task = path.match(/\/tasks\/(task-[12])$/);
		if (task) { if (task[1] === "task-2") await secondReady; return json({ id: task[1], type: "browser.task", status: "completed", title: task[1], input: {}, createdAt: "2026-11-04T00:00:00Z" }); }
		if (path.endsWith("/task-events")) { const id = url.searchParams.get("task_id"); return json({ events: [{ id: `shot-${id}`, taskId: id, type: "agent.shot", message: `Recorded for ${id}`, data: { seq: 1 }, createdAt: "2026-11-04T00:00:00Z" }] }); }
		if (path.endsWith("/shots/1")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="green"/></svg>' });
		if (path.endsWith("/actions")) return json({ entries: [], hasMore: false, nextCursor: null, tail: null, total: 0 });
		if (path.endsWith("/thread")) return json({ turns: [] });
		if (path.endsWith("/browser-takeovers")) return json({ takeovers: [] });
		if (path.endsWith("/browser-artifacts")) return json({ subjectKind: "runtime_task", subjectId: url.searchParams.get("subject_id"), artifacts: [], hasMore: false, nextCursor: null, screenshotsOff: false });
		return json({});
	});
	await page.goto("/console/instances/runner/tasks/task-1");
	await expect(page.getByTestId("run-replay").getByRole("img")).toHaveAttribute("alt", /Recorded for task-1/);
	const requested = page.waitForRequest(`${API}/v1/instances/runner/tasks/task-2`);
	await page.evaluate(() => { window.history.pushState({}, "", "/console/instances/runner/tasks/task-2"); window.dispatchEvent(new PopStateEvent("popstate")); });
	await requested;
	try { await expect(page.getByTestId("run-replay")).toHaveCount(0); }
	finally { releaseSecond(); }
	await expect(page.getByTestId("run-replay").getByRole("img")).toHaveAttribute("alt", /Recorded for task-2/);
});


test("metadata backfill does not cancel an unchanged selected image request", async ({ page }) => {
	const { images, releaseFirst } = await replayFixture(page, 1200, false, true);
	const replay = page.getByTestId("run-replay");
	await expect.poll(() => images.filter((seq) => seq === 1).length).toBe(1);
	await replay.getByRole("button", { name: "Load more history" }).click();
	await expect(replay.getByRole("slider", { name: "Frame" })).toHaveAttribute("max", "1199");
	try { expect(images.filter((seq) => seq === 1)).toHaveLength(1); }
	finally { releaseFirst(); }
	await expect(replay.getByRole("img")).toHaveAttribute("alt", /^Frame 1:/);
});
