import { expect, test, type Page } from "@playwright/test";

async function fleetFixture(page: Page) {
	await page.addInitScript(() => localStorage.setItem("pags:session", "fixture-session"));
	const now = Date.now();
	let changed = false;
	const machine = (name: string, stale: boolean, starts24h: number) => {
		const sampledAt = new Date(now - (stale ? 240_000 : 10_000)).toISOString();
		return {
			key: name, machineId: name, name, node: name, aka: [], lastSeenAt: sampledAt, sampledAt, stale, sampleAgeSec: stale ? 240 : 10,
			latest: { sampledAt, cpus: 4, loadPerCpu: 0.2, memTotalBytes: 8 * 1024 ** 3, memUsedPct: 60, platform: "darwin", activeSessions: 1, recommendedMaxSessions: 2, diskUsedPct: 50, diskTotalBytes: 100e9, relayRttMs: 20, uptimeSec: 3600, starts24h, supervisor: "service", gateState: "accepting", warnings: [] },
			points: [{ at: sampledAt, loadPerCpu: 0.2, memUsedPct: 60, diskUsedPct: 50, relayRttMs: 20, starts24h, sessionCount: 1 }],
		};
	};
	await page.route("https://api.proagentstore.online/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		let body: unknown = {};
		if (path === "/v1/auth/me") body = { id: "fixture-user", login: "tester", name: "Tester", roles: ["user"] };
		if (path === "/v1/instances/my/instances") body = { instances: [] };
		if (path === "/v1/terminals/resources") {
			const machines = [machine("pink-laptop", !changed, 5), machine("tiny-laptop", !changed, 4), machine("macmini", changed, 15)];
			body = { tier: new URL(route.request().url()).searchParams.get("tier") ?? "dense", from: new Date(now - 7_200_000).toISOString(), to: new Date(now).toISOString(), now: new Date(now).toISOString(), cursor: null, truncated: false, machines: changed ? [machine("alpha-new", false, 1), ...machines.reverse()] : machines };
		}
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
	});
	return { change: () => { changed = true; } };
}

test("Fleet distinguishes stale telemetry from host availability", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1280, height: 1000 });
	await fleetFixture(page);
	await page.goto("/console/fleet");
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
