import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";

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
	const ctl = { rejectInput: false, frameFails: 0, framesServed: 0, resume: { state: "running" } as Record<string, unknown> };
	await page.setViewportSize({ width: 390, height: 844 });
	await page.route("**/v1/instances/instance-1/application-runs/run-1/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/frame")) {
			if (ctl.frameFails > 0) {
				ctl.frameFails--;
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
		ctl.frameFails = 1;
		await expect(page.getByText("Live handoff unavailable")).toBeVisible();
		expect(await page.getByText(REFUSAL).isVisible()).toBe(true);
		await expect(page.getByAltText("Live Application Runner browser")).toBeVisible();
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

async function mountCard(page: import("@playwright/test").Page, opts: { takeover: "requested" | "none"; mobileAllowed?: boolean }) {
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
		if (path === `/takeover/${CARD}/frame`) return ok(FRAME);
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
