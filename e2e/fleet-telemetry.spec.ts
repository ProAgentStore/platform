import { expect, test, type Page } from "@playwright/test";

async function fleetFixture(page: Page) {
	await page.addInitScript(() => localStorage.setItem("pags:session", "fixture-session"));
	const now = Date.now();
	let changed = false;
	let failPolls = false;
	const machine = (name: string, stale: boolean, starts24h: number) => {
		const sampledAt = new Date(now - (stale ? 240_000 : 10_000)).toISOString();
		const firstReceivedAt = new Date(now - 50_000).toISOString(), lastReceivedAt = new Date(now - 20_000).toISOString();
		return {
			key: name, machineId: name, name, node: name, aka: [], lastSeenAt: sampledAt, sampledAt, stale, sampleAgeSec: stale ? 240 : 10,
			latest: { sampledAt, cpus: 4, loadPerCpu: 0.2, memTotalBytes: 8 * 1024 ** 3, memUsedPct: 60, platform: "darwin", activeSessions: 1, recommendedMaxSessions: 2, diskUsedPct: 50, diskTotalBytes: 100e9, relayRttMs: 20, uptimeSec: 3600, starts24h, supervisor: "service", gateState: "accepting", warnings: [] },
			points: [{ at: sampledAt, loadPerCpu: 0.2, memUsedPct: 60, diskUsedPct: 50, relayRttMs: 20, starts24h, sessionCount: 1 }],
			availability: { source: "heartbeat_receipts", bucketMs: 60_000, from: new Date(now - 7_200_000).toISOString(), to: new Date(now).toISOString(), retentionMs: 86_400_000, coverage: "observed_only", missingBucketMeaning: "no_recorded_receipt", error: null, truncated: false, buckets: name === "tiny-laptop" ? [] : [{ at: new Date(now - 60_000).toISOString(), receipts: 2, firstReceivedAt, lastReceivedAt }] },
		};
	};
	await page.route("https://api.proagentstore.online/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		let body: unknown = {};
		if (path === "/v1/auth/me") body = { id: "fixture-user", login: "tester", name: "Tester", roles: ["user"] };
		if (path === "/v1/instances/my/instances") body = { instances: [] };
		if (path === "/v1/terminals/resources") {
			if (failPolls) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture poll unavailable" }) });
			const machines = [machine("pink-laptop", !changed, 5), machine("tiny-laptop", !changed, 4), machine("macmini", changed, 15)];
			body = { tier: new URL(route.request().url()).searchParams.get("tier") ?? "dense", from: new Date(now - 7_200_000).toISOString(), to: new Date(now).toISOString(), now: new Date(now).toISOString(), cursor: null, truncated: false, machines: changed ? [machine("alpha-new", false, 1), ...machines.reverse()] : machines };
		}
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
	});
	return { change: () => { changed = true; }, failPolls: () => { failPolls = true; } };
}

test("Fleet distinguishes stale telemetry from host availability", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1280, height: 1000 });
	await fleetFixture(page);
	await page.goto("/console/fleet");
	const availability = page.getByRole("region", { name: "Availability history" });
	await expect(availability.getByRole("heading", { name: "Availability — PAGS heartbeat" })).toBeVisible();
	await expect(availability.getByRole("img", { name: /pink-laptop: 2 recorded heartbeats/ })).toBeVisible();
	await expect(availability.getByRole("img", { name: /tiny-laptop: 0 recorded heartbeats; No recorded heartbeat/ })).toBeVisible();
	expect(await availability.evaluate((element) => !!(element.compareDocumentPosition(document.querySelector("table")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
	const pink = page.getByRole("row").filter({ hasText: "pink-laptop" });
	await expect(pink).toContainText("telemetry stale");
	await expect(pink).not.toContainText("offline");
	await expect(page.getByRole("row").filter({ hasText: "macmini" })).toContainText("reporting");
	await expect(page.getByRole("columnheader", { name: "Sessions / recommended" })).toBeVisible();
	await expect(page.getByText("Counts runner process starts, including updates and manual restarts. An increase alone does not establish a crash loop.")).toBeVisible();
	await expect(page.getByText(/This does not establish host power, runner responsiveness or task progress/)).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("fleet-desktop.png"), fullPage: true });
});

test("mobile — Fleet keeps telemetry caveats readable with an internally scrolling table", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await fleetFixture(page);
	await page.goto("/console/fleet");
	await expect(page.getByRole("heading", { name: "Availability — PAGS heartbeat" })).toBeVisible();
	await expect(page.getByRole("row").filter({ hasText: "pink-laptop" })).toContainText("telemetry stale");
	await expect(page.getByText(/This does not establish host power, runner responsiveness or task progress/)).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath("fleet-mobile.png"), fullPage: true });
});

test("Fleet keeps machine order and identity colors through refresh and range changes", async ({ page }) => {
	const fixture = await fleetFixture(page);
	await page.goto("/console/fleet");
	const names = () => page.locator("tbody tr td:first-child").allTextContents().then((rows) => rows.map((text) => text.trim()));
	await expect.poll(names).toEqual(["macmini", "pink-laptop", "tiny-laptop"]);
	const colors = () => page.locator("tbody tr").evaluateAll((rows) => Object.fromEntries(rows.map((row) => [row.querySelector("td")!.textContent!.trim(), row.querySelector<HTMLElement>("td span")!.style.background])));
	const before = await colors();
	const verify = async () => {
		await expect.poll(names).toEqual(["alpha-new", "macmini", "pink-laptop", "tiny-laptop"]);
		const after = await colors();
		for (const [name, color] of Object.entries(before)) expect(after[name]).toBe(color);
		const chart = page.locator('svg[aria-label^="Disk used"]');
		const labels = chart.locator("text[data-machine-key]");
		await expect(labels).toHaveText([/alpha-new/, /macmini/, /pink-laptop/, /tiny-laptop/]);
		const chartColors = await labels.evaluateAll((labels) => Object.fromEntries(labels.map((label) => [label.getAttribute("data-machine-key"), label.getAttribute("fill")])));
		for (const [name, color] of Object.entries(after)) expect(chartColors[name]).toBe(color);
		const lanes = page.getByRole("region", { name: "Availability history" }).locator("[data-availability-machine]");
		expect(await lanes.evaluateAll((lanes) => lanes.map((lane) => lane.getAttribute("data-availability-machine")))).toEqual(["alpha-new", "macmini", "pink-laptop", "tiny-laptop"]);
		const laneColors = await lanes.evaluateAll((lanes) => Object.fromEntries(lanes.map((lane) => [lane.getAttribute("data-availability-machine"), lane.querySelector<HTMLElement>("span[aria-hidden]")!.style.background])));
		for (const [name, color] of Object.entries(after)) expect(laneColors[name]).toBe(color);
		await expect(page.getByRole("list", { name: "Machines not drawn on Memory used" }).locator("li .font-semibold")).toHaveText(["alpha-new", "macmini", "pink-laptop", "tiny-laptop"]);
	};
	fixture.change();
	await page.getByRole("button", { name: "Reload fleet telemetry" }).click();
	await verify();
	await page.getByRole("button", { name: "Last 24 h", exact: true }).click();
	await verify();
	await page.getByRole("button", { name: "Last 2 h", exact: true }).click();
	await verify();
});


test("availability ages and its unknown gap grows while polling fails, independently of browser wall-clock skew", async ({ page }) => {
	await page.clock.install({ time: new Date(Date.now() + 86_400_000) });
	const fixture = await fleetFixture(page);
	await page.goto("/console/fleet");
	const lane = page.getByRole("region", { name: "Availability history" }).locator('[data-availability-machine="pink-laptop"]');
	await expect(lane).toContainText("Last heartbeat 20s ago");
	const endpoint = lane.locator("svg g rect").last();
	const beforeX = Number(await endpoint.getAttribute("x"));
	fixture.failPolls();
	await page.clock.runFor(5 * 60_000);
	await expect(page.getByRole("alert")).toContainText("Could not refresh");
	await expect(lane).toContainText("Last heartbeat 5m ago");
	const afterX = Number(await endpoint.getAttribute("x"));
	// Five minutes of no observations must visibly extend the unknown right-hand gap.
	expect(beforeX - afterX).toBeGreaterThan(40);
	await expect(lane).not.toContainText("offline");
});

const GRAPH_HELP = [
	["Availability — PAGS heartbeat", "server receipt"],
	["Load per core", "one-minute load"],
	["Disk used (checkout volume)", "checkout volume"],
	["Relay round trip", "milliseconds"],
	["Runner starts in 24 h", "does not establish a crash loop"],
	["Sessions against the recommended maximum", "configured admission limit"],
	["Memory used", "macOS"],
] as const;

test("Fleet graph information explains every metric and supports keyboard dismissal and focus return", async ({ page }) => {
	await fleetFixture(page);
	await page.goto("/console/fleet");
	for (const [title, explanation] of GRAPH_HELP) {
		const trigger = page.getByRole("button", { name: `About ${title}`, exact: true });
		await trigger.focus();
		await trigger.press("Enter");
		const popup = page.getByRole("dialog", { name: `About ${title}`, exact: true });
		await expect(popup).toBeVisible();
		await expect(popup).toContainText(explanation);
		await expect(popup.getByRole("button", { name: "Close graph information" })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(popup.getByRole("button", { name: "Close graph information" })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(popup).toHaveCount(0);
		await expect(trigger).toBeFocused();
	}
	const trigger = page.getByRole("button", { name: "About Availability — PAGS heartbeat", exact: true });
	await trigger.click();
	await page.getByRole("button", { name: "Close graph information" }).click();
	await expect(trigger).toBeFocused();
	await trigger.click();
	await page.locator("[data-graph-info-backdrop]").click({ position: { x: 5, y: 5 } });
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(trigger).toBeFocused();
});

test("mobile — Fleet graph information fits the viewport with touch-sized controls", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await fleetFixture(page);
	await page.goto("/console/fleet");
	for (const [title] of GRAPH_HELP) {
		const trigger = page.getByRole("button", { name: `About ${title}`, exact: true });
		const box = await trigger.boundingBox();
		expect(box?.width).toBeGreaterThanOrEqual(44);
		expect(box?.height).toBeGreaterThanOrEqual(44);
		await trigger.click();
		const popup = page.getByRole("dialog", { name: `About ${title}`, exact: true });
		await expect(popup).toBeVisible();
		const bounds = await popup.boundingBox();
		expect(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844).toBe(true);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		if (title === "Relay round trip") await page.screenshot({ path: testInfo.outputPath("fleet-graph-info-mobile.png"), fullPage: true });
		await popup.getByRole("button", { name: "Close graph information" }).click();
	}
});
