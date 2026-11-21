import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

// #1669 — answering a coder question from a phone shows saving / saved / failed and never double-sends.
// The page is the real RunDetail; every API call, including POST /input, is a Playwright mock. No answer
// ever reaches a server.
test.describe.configure({ mode: "default" });

let vite: ChildProcess | undefined;
let base = "";
const TASK = "csess-1669";

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const a = server.address();
			if (!a || typeof a === "string") return reject(new Error("No local test port"));
			server.close((e) => (e ? reject(e) : resolve(a.port)));
		});
	});
}

test.beforeAll(async () => {
	const port = await freePort();
	base = `http://127.0.0.1:${port}`;
	vite = spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: "store/console", stdio: "ignore", shell: process.platform === "win32" });
	for (let i = 0; i < 120; i++) {
		try { if ((await fetch(`${base}/console/run-detail-fixture.html`)).ok) return; } catch { /* starting */ }
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("fixture did not start");
});
test.afterAll(() => { vite?.kill("SIGTERM"); });

type Ctl = { status: number; error?: string; hold?: Promise<void>; posts: Array<Record<string, unknown>>; waiting: boolean; resumeOnPost?: boolean };

function gate(ctl: Ctl): () => void {
	let release!: () => void;
	ctl.hold = new Promise<void>((r) => { release = r; });
	return release;
}

async function mount(page: Page, needs: { options?: string[]; parts?: unknown[] }): Promise<Ctl> {
	const ctl: Ctl = { status: 200, posts: [], waiting: true };
	await page.route("**/v1/errors/client", (r) => r.fulfill({ status: 204, body: "" }));
	await page.route("**/v1/instances/instance-1/**", async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname.replace("/v1/instances/instance-1", "");
		const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (path === "/input" && req.method() === "POST") {
			ctl.posts.push(req.postDataJSON());
			await ctl.hold;
			if (ctl.status === 200 && ctl.resumeOnPost) ctl.waiting = false;
			return ctl.status === 200 ? json(200, { ok: true }) : json(ctl.status, { error: ctl.error ?? "failed" });
		}
		if (path === `/tasks/${TASK}`) return json(200, { id: TASK, type: "coding.session", status: ctl.waiting ? "needs_human" : "running", title: "Fix the thing" });
		if (path === "/task-events") return json(200, { events: [{ id: "e1", type: "agent.needs_input", taskId: TASK, createdAt: new Date().toISOString(), message: "Needs your input — Which approach should I take for the migration?", data: { field: "Which approach should I take for the migration?", ...needs } }] });
		if (path === `/tasks/${TASK}/thread`) return json(200, { turns: [] });
		if (path === `/tasks/${TASK}/actions`) return json(200, { entries: [], total: 0, nextCursor: null, hasMore: false });
		if (path === "/board") return json(200, { items: [] });
		if (path === "/browser-artifacts") return json(200, { subjectKind: "runtime_task", subjectId: TASK, artifacts: [], screenshotsOff: false });
		if (path === "/browser-takeovers") return json(200, { takeovers: [] });
		return json(200, {});
	});
	await page.goto(`${base}/console/run-detail-fixture.html?task=${TASK}`);
	return ctl;
}

const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe("on a touch phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

	test("single choice: shows saving at once, ignores repeat taps, then confirms receipt", async ({ page }) => {
		const long = "Rewrite the whole migration as a single transaction with a very long explanatory label that must wrap rather than widen the page";
		const ctl = await mount(page, { options: ["Option A", long] });
		const release = gate(ctl);
		const a = page.getByRole("button", { name: /Option A/ });
		await a.tap();
		await expect(page.getByTestId("answer-saving")).toBeVisible();
		await expect(a).toContainText("Saving…");
		await expect(page.getByRole("button", { name: long })).toBeDisabled();
		await a.dispatchEvent("click"); // a repeat tap that slips past the disabled attribute
		expect(await noHScroll(page)).toBe(true);
		release();
		await expect(page.getByTestId("answer-saved")).toContainText("Waiting for the coder to resume");
		expect(ctl.posts).toEqual([{ taskId: TASK, value: "Option A" }]);
		expect(await noHScroll(page)).toBe(true);
	});

	test("once the coder resumes the receipt says so", async ({ page }) => {
		const ctl = await mount(page, { options: ["Option A", "Option B"] });
		ctl.resumeOnPost = true; // the coder picks the answer up, so the next reload shows the run moving on
		await page.getByRole("button", { name: "Option B" }).tap();
		await expect(page.getByTestId("answer-saved")).toContainText("the coder has resumed");
		expect(ctl.posts).toHaveLength(1);
	});

	test("failure is an inline alert, the choice can be retried, and a stale question says so", async ({ page }) => {
		const ctl = await mount(page, { options: ["Option A", "Option B"] });
		ctl.status = 503; ctl.error = "upstream unavailable";
		await page.getByRole("button", { name: "Option A" }).tap();
		const alert = page.getByRole("alert");
		await expect(alert).toContainText("not saved");
		await expect(alert).toContainText("upstream unavailable");
		await expect(page.getByRole("button", { name: "Option A" })).toBeEnabled();
		ctl.status = 409; ctl.error = "Task is no longer waiting for input";
		await page.getByRole("button", { name: "Option A" }).tap();
		await expect(alert).toContainText("no longer waiting");
		await expect(alert).toContainText("refresh");
		ctl.status = 200; ctl.error = undefined;
		await page.getByRole("button", { name: "Option A" }).tap();
		await expect(page.getByTestId("answer-saved")).toBeVisible();
		await expect(page.getByRole("alert")).toHaveCount(0);
		expect(ctl.posts).toHaveLength(3);
	});

	test("typed answer: keeps the text on failure; Enter is a NEW LINE and never sends; Send sends once (#1338)", async ({ page }) => {
		const ctl = await mount(page, {});
		ctl.status = 500; ctl.error = "boom";
		const input = page.getByPlaceholder("Which approach should I take for the migration?");
		const sendBtn = page.getByTestId("answer-send");
		await input.fill("my legal name");
		await sendBtn.tap();
		await expect(page.getByRole("alert")).toContainText("boom");
		await expect(input).toHaveValue("my legal name");
		ctl.status = 200;
		// Enter makes a second line and sends nothing — only the one failed POST so far.
		await input.press("Enter");
		await input.pressSequentially("second line");
		await expect(input).toHaveValue("my legal name\nsecond line");
		expect(ctl.posts).toHaveLength(1);
		const release = gate(ctl);
		await sendBtn.tap();
		await expect(page.getByTestId("answer-saving")).toBeVisible();
		await expect(sendBtn).toBeDisabled();
		await sendBtn.click({ force: true }); // a repeat press that slips past the disabled attribute
		release();
		await expect(page.getByTestId("answer-saved")).toBeVisible();
		await expect(input).toHaveValue("");
		expect(ctl.posts.map((p) => p.value)).toEqual(["my legal name", "my legal name\nsecond line"]);
	});

	test("the answer box is comfortably tall, grows with long text, and Send stays reachable with no sideways scroll (#1338)", async ({ page }) => {
		await mount(page, {});
		const box = page.getByTestId("answer-textarea");
		const sendBtn = page.getByTestId("answer-send");
		await expect(box).toBeVisible();
		const empty = (await box.boundingBox())?.height ?? 0;
		expect(empty).toBeGreaterThanOrEqual(110); // ~4 lines, not one
		expect(await box.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16); // no iOS focus-zoom
		// Send is a full-width button UNDER the box on a phone.
		const b = await box.boundingBox();
		const s = await sendBtn.boundingBox();
		expect((s?.y ?? 0) >= (b?.y ?? 0) + (b?.height ?? 0)).toBe(true);
		expect(s?.width ?? 0).toBeGreaterThanOrEqual((b?.width ?? 1) - 2);
		// Long text grows the box, up to a share of the viewport, then scrolls INSIDE it.
		await box.fill(Array.from({ length: 30 }, (_, i) => `line ${i + 1} of a long, considered reply`).join("\n"));
		const grown = (await box.boundingBox())?.height ?? 0;
		expect(grown).toBeGreaterThan(empty);
		expect(grown).toBeLessThanOrEqual(844 * 0.45 + 1);
		expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
		expect(await noHScroll(page)).toBe(true);
		// Reachable: the button can be scrolled to and is fully on screen.
		await sendBtn.scrollIntoViewIfNeeded();
		await expect(sendBtn).toBeInViewport({ ratio: 1 });
		await expect(sendBtn).toBeEnabled();
	});

	test("a long unbroken word wraps inside the box instead of widening the page (#1338)", async ({ page }) => {
		await mount(page, {});
		await page.getByTestId("answer-textarea").fill("x".repeat(400));
		expect(await noHScroll(page)).toBe(true);
	});

	test("multipart: Send shows saving, disables the picks, and sends one combined answer", async ({ page }) => {
		const ctl = await mount(page, { parts: [{ question: "Which database?", options: ["pg", "sqlite"] }, { question: "Which mode?", options: ["fast", "safe"] }] });
		await page.getByRole("button", { name: "pg", exact: true }).tap();
		await page.getByRole("button", { name: "safe", exact: true }).tap();
		const release = gate(ctl);
		await page.getByRole("button", { name: "Send" }).tap();
		await expect(page.getByTestId("answer-saving")).toBeVisible();
		await expect(page.getByRole("button", { name: "sqlite", exact: true })).toBeDisabled();
		await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
		release();
		await expect(page.getByTestId("answer-saved")).toBeVisible();
		expect(ctl.posts).toHaveLength(1);
		expect(await noHScroll(page)).toBe(true);
	});

	test("a slow request says it is still saving", async ({ page }) => {
		const ctl = await mount(page, { options: ["Option A"] });
		const release = gate(ctl);
		await page.getByRole("button", { name: "Option A" }).tap();
		await expect(page.getByTestId("answer-saving")).toContainText("Still saving", { timeout: 12_000 });
		release();
		await expect(page.getByTestId("answer-saved")).toBeVisible();
	});
});

test.describe("mobile — on a very narrow phone", () => {
	test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });

	test("the answer box and Send fit a 320px screen (#1338)", async ({ page }) => {
		await mount(page, {});
		const box = page.getByTestId("answer-textarea");
		await box.fill("a reply that is long enough to wrap across several lines on a very narrow screen, and then some more words after it");
		expect(await noHScroll(page)).toBe(true);
		const b = await box.boundingBox();
		expect((b?.x ?? -1) >= 0 && (b?.x ?? 0) + (b?.width ?? 0) <= 320).toBe(true);
		await page.getByTestId("answer-send").scrollIntoViewIfNeeded();
		await expect(page.getByTestId("answer-send")).toBeInViewport({ ratio: 1 });
	});
});
