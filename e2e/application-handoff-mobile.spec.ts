import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";

// One Vite fixture per browser project, reused by this file's tests (#1376).
// Global fullyParallel would start a server per test and starve fixture startup.
test.describe.configure({ mode: "default" });

let vite: ChildProcess | undefined;
let fixtureBase = "";

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("No local test port"));
			server.close((error) => error ? reject(error) : resolve(address.port));
		});
	});
}

async function waitForFixture(url: string): Promise<void> {
	for (let i = 0; i < 80; i++) {
		try { if ((await fetch(url)).ok) return; } catch { /* Vite is still starting. */ }
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("The local mobile-handoff fixture did not start");
}

/**
 * The mocked 409s and 503s below are real failures to the console's `api()`, which reports every one to
 * `https://api.proagentstore.online/v1/errors/client`. Unrouted, each local or CI run wrote fixture rows
 * (`instance-1/run-1`, "handoff closed", build `unset`) into PRODUCTION's error log (#1086). Answer the
 * report here (10 per run, measured), so a run never reaches the deployed API.
 */
test.beforeEach(async ({ page }) => {
	await page.route("**/v1/errors/client", (route) => route.fulfill({ status: 204, body: "" }));
});

test.beforeAll(async () => {
	const port = await freePort();
	fixtureBase = `http://127.0.0.1:${port}`;
	vite = spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
		cwd: "store/console", stdio: "ignore", detached: false,
	});
	await waitForFixture(`${fixtureBase}/console/handoff-mobile-fixture.html`);
});

test.afterAll(() => { vite?.kill("SIGTERM"); });

for (const [label, reconciliation] of [["live", false], ["reconciliation", true]] as const) {
	test(`mobile — ${label} handoff forwards ephemeral keyboard controls and ends cleanly`, async ({ page }) => {
		const relayed: Array<Record<string, unknown>> = [];
		const consoleMessages: string[] = [];
		let rejectInput = false;
		let expired = false;
		page.on("console", (message) => consoleMessages.push(message.text()));
		await page.setViewportSize({ width: 390, height: 844 });
		await page.route("**/v1/instances/instance-1/application-runs/run-1/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.endsWith("/frame")) return route.fulfill({ status: expired ? 409 : 200, contentType: "application/json", body: JSON.stringify(expired ? { error: "handoff expired" } : { frame: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='480'%3E%3C/svg%3E", width: 320, height: 480 }) });
			if (path.endsWith("/input")) {
				const body = route.request().postDataJSON() as Record<string, unknown>;
				relayed.push(body);
				return route.fulfill({ status: rejectInput ? 409 : 200, contentType: "application/json", body: JSON.stringify(rejectInput ? { error: "handoff closed" } : { ok: true }) });
			}
			if (path.endsWith("/end")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "ended" }) });
			return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "unexpected fixture route" }) });
		});
		await page.goto(`${fixtureBase}/console/handoff-mobile-fixture.html?reconciliation=${reconciliation ? "1" : "0"}`);
		const entry = page.getByTestId("application-handoff-mobile-text-entry");
		await expect(entry).toBeVisible();
		await expect(entry).toHaveAttribute("inputmode", "text");
		await entry.fill("mobile-code");
		await expect(entry).toHaveValue("");
		await page.getByRole("button", { name: "Continue" }).click();
		await page.getByRole("button", { name: "Delete" }).click();
		await expect.poll(() => relayed.length).toBeGreaterThanOrEqual(3);
		expect(relayed).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "text", text: "mobile-code" }),
			expect.objectContaining({ type: "key", key: "Enter" }),
			expect.objectContaining({ type: "key", key: "Backspace" }),
		]));
		// The component neither displays nor logs the typed value; only the mocked secure relay saw it.
		await expect(page.locator("body")).not.toContainText("mobile-code");
		await expect(page.getByRole("button", { name: /fill|upload|submit/i })).toHaveCount(0);

		rejectInput = true; // The mocked Runner's post-auth/read-only refusal.
		await entry.fill("after-auth");
		await expect(entry).toHaveValue("");
		await expect(page.getByText("Secure sign-in input is no longer available.")).toBeVisible();
		await expect(page.locator("body")).not.toContainText("after-auth");
		expect(consoleMessages.join("\n")).not.toContain("mobile-code");
		expect(consoleMessages.join("\n")).not.toContain("after-auth");

		expired = true;
		await expect(page.getByText("Live handoff unavailable")).toBeVisible();
		await page.getByRole("button", { name: "End" }).click();
		await expect(page.getByTestId("handoff-fixture-closed")).toBeVisible();
	});
}

// ── Durable notices outlive successful frame polls ─────────────────────────────────────────────────────
//
// The frame poll runs every 500ms (plus 150ms after each input) and used to clear the ONE shared error,
// so a refusal or the read-only notice vanished on the next good frame. Ordering below is controlled by
// counting the frame responses the mock has FULFILLED after the notice appeared: by the time the third
// such request arrives, at least one earlier successful frame has been rendered. An immediate
// `isVisible()` after that is a fact, not a retry.

const FRAME = { frame: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='480'%3E%3C/svg%3E", width: 320, height: 480 };
const REFUSAL = "Secure sign-in input is no longer available.";
const READ_ONLY = "Authenticated read-only inspection remains live.";

async function mountHandoff(page: import("@playwright/test").Page, reconciliation: boolean) {
	const ctl = { rejectInput: false, frameFails: false, framesServed: 0, resume: { state: "running" } as Record<string, unknown> };
	await page.setViewportSize({ width: 390, height: 844 });
	await page.route("**/v1/instances/instance-1/application-runs/run-1/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/frame")) {
			if (ctl.frameFails) {
				return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "runner relay unavailable" }) });
			}
			ctl.framesServed++;
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FRAME) });
		}
		if (path.endsWith("/input")) return route.fulfill({ status: ctl.rejectInput ? 409 : 200, contentType: "application/json", body: JSON.stringify(ctl.rejectInput ? { error: "handoff closed" } : { ok: true }) });
		if (path.endsWith("/resume")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ctl.resume) });
		if (path.endsWith("/end")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "ended" }) });
		return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "unexpected fixture route" }) });
	});
	await page.goto(`${fixtureBase}/console/handoff-mobile-fixture.html?reconciliation=${reconciliation ? "1" : "0"}`);
	await expect(page.getByAltText("Live Application Runner browser")).toBeVisible();
	/** Wait until `n` more successful frames have been served than at the time of the call. */
	const afterFrames = async (n: number) => {
		const from = ctl.framesServed;
		await expect.poll(() => ctl.framesServed - from).toBeGreaterThanOrEqual(n);
	};
	return { ctl, entry: page.getByTestId("application-handoff-mobile-text-entry"), afterFrames };
}

for (const [label, reconciliation] of [["live", false], ["reconciliation", true]] as const) {
	test(`mobile — ${label} handoff keeps a rejected-input notice through successful frame polls`, async ({ page }) => {
		const { ctl, entry, afterFrames } = await mountHandoff(page, reconciliation);
		ctl.rejectInput = true;
		await entry.fill("refused-value");
		await expect(page.getByText(REFUSAL)).toBeVisible();
		await afterFrames(3);
		expect(await page.getByText(REFUSAL).isVisible()).toBe(true);
		await expect(page.getByAltText("Live Application Runner browser")).toBeVisible();
		await expect(page.locator("body")).not.toContainText("refused-value");
		// An accepted input is the transition that retires the refusal.
		ctl.rejectInput = false;
		await page.getByRole("button", { name: "Continue" }).click();
		await expect(page.getByText(REFUSAL)).toHaveCount(0);
	});

	test(`mobile — ${label} handoff: a real frame error and recovery do not erase input feedback`, async ({ page }) => {
		const { ctl, entry, afterFrames } = await mountHandoff(page, reconciliation);
		ctl.rejectInput = true;
		await entry.fill("refused-value");
		await expect(page.getByText(REFUSAL)).toBeVisible();
		// Hold the fault until observed; a single 500ms poll can elude the assertion (#1378).
		ctl.frameFails = true;
		await expect(page.getByText("Live handoff unavailable")).toBeVisible();
		expect(await page.getByText(REFUSAL).isVisible()).toBe(true);
		await expect(page.getByAltText("Live Application Runner browser")).toBeVisible();
		ctl.frameFails = false;
		await afterFrames(3);
		expect(await page.getByText(REFUSAL).isVisible()).toBe(true);
		await expect(page.getByText("Live handoff unavailable")).toHaveCount(0);
	});
}

test("mobile — reconciliation keeps the authenticated read-only notice through frame polls and accepted input", async ({ page }) => {
	const { ctl, entry, afterFrames } = await mountHandoff(page, true);
	ctl.resume = { state: "running" };
	await page.getByRole("button", { name: "Recheck — done" }).click();
	await expect(page.getByText(READ_ONLY)).toBeVisible();
	await afterFrames(3);
	expect(await page.getByText(READ_ONLY).isVisible()).toBe(true);
	// A valid later state change — an accepted sign-in key — does not retire it either.
	await entry.fill("ok-value");
	await page.getByRole("button", { name: "Continue" }).click();
	await afterFrames(3);
	expect(await page.getByText(READ_ONLY).isVisible()).toBe(true);
	await expect(page.getByText(REFUSAL)).toHaveCount(0);
	await expect(page.getByTestId("handoff-fixture-closed")).toHaveCount(0);
});

// ── #1100 round 2: the console's take-over control on an application card, on a phone ─────────────────
//
// Round 1 changed no console file, so nothing proved the owner could reach a card's live browser at all:
// the card's task is `blocked`, so RunDetail's "Take over (live)" (gated on `needs_human`) never showed,
// and the banner said "Waiting for you to take over" with only resume/decline under it. These mount the
// REAL RunDetail page for the reported card on a touch phone (so `deviceKind()` is "mobile"), with the
// API mocked at the network edge and every request recorded.

const CARD = "app-b8586cf8-0987-4397-85ef-e4db9563cdd5";
const TAKEOVER_ID = "30532b43-66b0-41c4-8906-021f8ebc31d7";

async function mountCard(page: import("@playwright/test").Page, opts: { takeover: "requested" | "none"; mobileAllowed?: boolean; frame?: Record<string, unknown> }) {
	const calls: Array<{ method: string; path: string; query: string; body: unknown }> = [];
	const takeover = opts.takeover === "none" ? null : {
		id: TAKEOVER_ID, subjectKind: "runtime_task", subjectId: CARD, state: "requested", reason: "login_required", mobileAllowed: opts.mobileAllowed ?? true,
		endReason: null, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), createdAt: new Date().toISOString(), activatedAt: null, endedAt: null,
	};
	await page.route("**/v1/instances/instance-1/**", async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace("/v1/instances/instance-1", "");
		const body = req.postData() ? req.postDataJSON() : null;
		calls.push({ method: req.method(), path, query: url.search, body });
		const ok = (json: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
		if (path === `/tasks/${CARD}`) return ok({ id: CARD, type: "application.run", status: "blocked", title: "Senior Engineer — Globex", description: "reason: login_required", application: { applicationStatus: "blocked", blockReason: "login_required" } });
		if (path === `/tasks/${CARD}/thread`) return ok({ turns: [] });
		if (path === "/task-events") return ok({ events: [] });
		if (path === "/board") return ok({ items: [] });
		if (path === "/browser-artifacts") return ok({ subjectKind: "runtime_task", subjectId: CARD, artifacts: [], screenshotsOff: false });
		if (path === "/browser-takeovers") return ok({ takeovers: takeover ? [takeover] : [] });
		if (path === `/browser-takeovers/${TAKEOVER_ID}` && req.method() === "PATCH" && takeover) {
			takeover.state = (body as { state: string }).state;
			return ok({ takeover, changed: true });
		}
		if (path === `/takeover/${CARD}/frame`) return ok(opts.frame ?? FRAME);
		if (path === `/takeover/${CARD}/input`) return ok({ ok: true });
		if (path === `/takeover/${CARD}/resume`) return ok({ signIn: { state: "closed", signedIn: { fingerprint: 1, verifiable: true } }, retry: { outcome: "started", runId: "run-2" } });
		return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: `unexpected fixture route ${path}` }) });
	});
	await page.goto(`${fixtureBase}/console/run-detail-fixture.html?task=${CARD}`);
	return { calls, frames: () => calls.filter((c) => c.path === `/takeover/${CARD}/frame`) };
}

test.describe("on a touch phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

	test("mobile — a requested takeover on an application card is taken over from the banner and streams the live page", async ({ page }) => {
		const { calls, frames } = await mountCard(page, { takeover: "requested" });
		const banner = page.getByTestId("takeover-banner");
		await expect(banner).toContainText("Waiting for you to take over");
		await banner.getByTestId("takeover-open").click();

		// Taking over is the recorded move to `active`, from a phone, BEFORE any frame is asked for.
		await expect.poll(() => calls.find((c) => c.method === "PATCH")?.body).toEqual({ state: "active", device: "mobile" });
		await expect.poll(() => frames().length).toBeGreaterThanOrEqual(1);
		expect(calls.findIndex((c) => c.path === `/takeover/${CARD}/frame`)).toBeGreaterThan(calls.findIndex((c) => c.method === "PATCH"));

		// The live view polls the card's frame and shows the page.
		await expect(page.getByAltText("Live agent browser")).toBeVisible();
		await expect.poll(() => frames().length).toBeGreaterThanOrEqual(3);
		expect(frames().every((c) => c.query.includes("device=mobile"))).toBe(true);

		// A phone types through the native entry — the page receives it, the field never keeps it.
		const entry = page.getByTestId("application-handoff-mobile-text-entry");
		await entry.fill("owner@example.com");
		await expect(entry).toHaveValue("");
		await expect.poll(() => calls.find((c) => c.path === `/takeover/${CARD}/input`)?.body).toEqual({ type: "text", text: "owner@example.com" });
		await page.getByRole("button", { name: "Continue" }).click();
		await expect.poll(() => calls.some((c) => c.path === `/takeover/${CARD}/input` && (c.body as { key?: string }).key === "Enter")).toBe(true);

		// On a phone the view opens full-screen (#1105): leaving it is how the takeover's own bar comes back.
		await page.getByTestId("remote-exit-fullscreen").click();
		await page.getByRole("button", { name: "Resume — done" }).click();
		await expect.poll(() => calls.some((c) => c.method === "POST" && c.path === `/takeover/${CARD}/resume`)).toBe(true);
	});

	test("mobile — a card blocked on a site sign-in with no takeover yet still offers the live view", async ({ page }) => {
		const { frames } = await mountCard(page, { takeover: "none" });
		const panel = page.getByTestId("sign-in-blocked");
		await expect(panel).toContainText("The job site needs you to sign in");
		await panel.getByRole("button", { name: /Take over \(live\)/ }).click();
		await expect(page.getByAltText("Live agent browser")).toBeVisible();
		expect(frames().length).toBeGreaterThanOrEqual(1);
	});

	test("mobile — when the owner turned phone takeovers off, the banner says so instead of offering the control", async ({ page }) => {
		const { calls } = await mountCard(page, { takeover: "requested", mobileAllowed: false });
		const banner = page.getByTestId("takeover-banner");
		await expect(banner).toContainText("Taking over from a phone is off");
		await expect(banner.getByTestId("takeover-open")).toHaveCount(0);
		expect(calls.some((c) => c.method === "PATCH")).toBe(false);
	});
});

// ── #1105: the live view on a phone is a browser — full-screen, zoom, and its own controls ──────────────
//
// The page in the report: SEEK's sign-in on dell-laptop, a 1280×720 CSS viewport, shown on a phone where
// it was a postage stamp nobody could read or tap. The real RunDetail view on a touch phone; the API is
// mocked and every relayed input recorded, so what reaches the page is the fact under test.

const WIDE = {
	frame: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1280' height='720'%3E%3Crect width='1280' height='720' fill='%23ddd'/%3E%3C/svg%3E",
	width: 1280,
	height: 720,
	url: "https://login.seek.com/login",
};

async function openLive(page: import("@playwright/test").Page) {
	const card = await mountCard(page, { takeover: "requested", frame: WIDE });
	await page.getByTestId("takeover-banner").getByTestId("takeover-open").click();
	await expect(page.getByAltText("Live agent browser")).toBeVisible();
	const inputs = () => card.calls.filter((c) => c.path === `/takeover/${CARD}/input`).map((c) => c.body as Record<string, unknown>);
	return { ...card, inputs };
}

test.describe("on a touch phone, the live view is a browser (#1105)", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

	test("mobile — it opens full-screen, with one way out", async ({ page }) => {
		await openLive(page);
		const browser = page.getByTestId("remote-browser");
		await expect(browser).toHaveAttribute("data-immersive", "true");
		// Full-screen covers the takeover's own bar: nothing competes with the page but the one exit.
		// The takeover's bar is still in the DOM, under the full-screen layer: a tap there reaches the layer.
		const resume = await page.getByRole("button", { name: "Resume — done" }).boundingBox();
		if (!resume) throw new Error("no Resume button");
		const covered = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-testid='remote-browser']") !== null, [resume.x + resume.width / 2, resume.y + resume.height / 2]);
		expect(covered).toBe(true);
		await page.getByTestId("remote-exit-fullscreen").click();
		await expect(browser).toHaveAttribute("data-immersive", "false");
		await expect(page.getByRole("button", { name: "Resume — done" })).toBeVisible();
		await expect(page.getByTestId("remote-exit-fullscreen")).toHaveCount(0);
		// …and back in, from the controls.
		await page.getByTestId("remote-fullscreen").click();
		await expect(browser).toHaveAttribute("data-immersive", "true");
	});

	test("mobile — back, forward, reload and the address bar drive the remote page", async ({ page }) => {
		const { inputs } = await openLive(page);
		const address = page.getByTestId("remote-address");
		await expect(address).toHaveValue("https://login.seek.com/login"); // where the page is, after SEEK's redirect
		await page.getByTestId("remote-back").click();
		await page.getByTestId("remote-forward").click();
		await page.getByTestId("remote-reload").click();
		await address.fill("au.seek.com/job/95289924");
		await address.press("Enter");
		await expect.poll(() => inputs().map((i) => i.type)).toEqual(expect.arrayContaining(["back", "forward", "reload", "navigate"]));
		expect(inputs().find((i) => i.type === "navigate")).toEqual({ type: "navigate", url: "au.seek.com/job/95289924" });
		// The address bar's typing is the bar's, never keystrokes into the remote page.
		expect(inputs().some((i) => i.type === "text")).toBe(false);
	});

	test("mobile — double-tap zooms in without pressing the page, and a tap then lands on the right page point", async ({ page }) => {
		const { inputs } = await openLive(page);
		const stage = page.getByTestId("remote-stage");
		const box = await stage.boundingBox();
		if (!box) throw new Error("no stage");
		const at = { x: box.x + 100, y: box.y + 60 };
		await page.touchscreen.tap(at.x, at.y);
		await page.touchscreen.tap(at.x, at.y);
		await expect(stage).toHaveAttribute("data-scale", "2.5");
		await page.waitForTimeout(500);
		expect(inputs().filter((i) => i.type === "click")).toEqual([]); // a zoom presses nothing
		// Zoomed about the tapped point, so the same point is still the same page pixel…
		await page.touchscreen.tap(at.x, at.y);
		await expect.poll(() => inputs().filter((i) => i.type === "click")).toHaveLength(1);
		const page1 = { x: Math.round((100 / box.width) * 1280), y: Math.round((60 / box.height) * 720) };
		// Within a CSS pixel: a touch point is sub-pixel, and WebKit rounds it differently from Chromium.
		const first = inputs().find((i) => i.type === "click") as Record<string, number>;
		expect(Math.abs(first.x - page1.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(first.y - page1.y)).toBeLessThanOrEqual(1);
		// …and 50 screen px to its right is 50 / 2.5 = 20 stage px, not 50: a precise tap at zoom.
		await page.touchscreen.tap(at.x + 50, at.y);
		await expect.poll(() => inputs().filter((i) => i.type === "click")).toHaveLength(2);
		const second = inputs().filter((i) => i.type === "click")[1];
		expect(Math.abs(Number(second.x) - (first.x + (20 / box.width) * 1280))).toBeLessThanOrEqual(1);
		expect(second.y).toBe(first.y);
	});

	test("mobile — a pinch zooms the page around the fingers", async ({ page, browserName }) => {
		test.skip(browserName !== "chromium", "two-finger touch is driven through Chromium's DevTools protocol");
		const { inputs } = await openLive(page);
		const stage = page.getByTestId("remote-stage");
		const box = await stage.boundingBox();
		if (!box) throw new Error("no stage");
		const cdp = await page.context().newCDPSession(page);
		const cx = box.x + box.width / 2;
		const cy = box.y + box.height / 2;
		const fingers = (d: number) => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }];
		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(20) });
		for (const d of [30, 45, 60]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(d) });
		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await expect.poll(async () => Number(await stage.getAttribute("data-scale"))).toBeGreaterThan(2.5);
		expect(inputs().filter((i) => i.type === "click")).toEqual([]); // a pinch presses nothing
	});
});
