import { expect, test, type Page } from "@playwright/test";

async function fleetFixture(page: Page) {
	await page.addInitScript(() => localStorage.setItem("pags:session", "fixture-session"));
	const now = Date.now();
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
		if (path === "/v1/terminals/resources") body = { tier: "dense", from: new Date(now - 7_200_000).toISOString(), to: new Date(now).toISOString(), now: new Date(now).toISOString(), cursor: null, truncated: false, machines: [machine("pink-laptop", true, 5), machine("tiny-laptop", true, 4), machine("macmini", false, 15)] };
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
	});
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
