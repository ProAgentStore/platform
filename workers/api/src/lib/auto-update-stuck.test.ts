/**
 * Auto-update ON but silently not happening (#1034). The 2026-10-12 machine: runner 0.4.94, its own
 * check last saw 0.4.98, 0.4.111 published, status `waiting_for_idle`, heartbeat fresh.
 */
import { describe, expect, it, vi } from "vitest";
import { AUTO_UPDATE_STUCK_AFTER_MS, assessAutoUpdateStuck, fetchPublishedCli, parsePublishedCli, type PublishedCli } from "./auto-update-stuck.js";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-12T12:00:00Z");
// 0.4.95 … 0.4.111, one release every 2 hours, the last one 12 hours ago.
const published: PublishedCli = {
	latest: "0.4.111",
	published: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`0.4.${95 + i}`, NOW - 12 * 3_600_000 - (16 - i) * 2 * 3_600_000])),
};
published.published["0.4.94"] = NOW - 5 * DAY;
published.published["0.4.95"] = NOW - 3 * DAY;

const pink = { autoUpdate: true, status: "waiting_for_idle", connected: true, runnerVersion: "0.4.94", reportedLatest: "0.4.98", published, now: NOW };

describe("assessAutoUpdateStuck (#1034)", () => {
	it("flags the observed machine: ON, connected, 17 releases behind for three days", () => {
		const stuck = assessAutoUpdateStuck(pink);
		expect(stuck).toMatchObject({ reason: "behind_published", published_version: "0.4.111", releases_behind: 17, remedy: "runner_update", behind_since: new Date(NOW - 3 * DAY).toISOString() });
		expect(stuck?.detail).toContain("runner_update");
		expect(stuck?.detail).toContain("0.4.98");
	});

	it("does not flag a machine that is current", () => {
		expect(assessAutoUpdateStuck({ ...pink, runnerVersion: "0.4.111" })).toBeNull();
		expect(assessAutoUpdateStuck({ ...pink, runnerVersion: "0.4.112" })).toBeNull();
	});

	it("gives a machine behind a fresh release time to update by itself", () => {
		// 0.4.110 is behind only 0.4.111, published 12h ago, and its own check saw it.
		expect(assessAutoUpdateStuck({ ...pink, runnerVersion: "0.4.110", reportedLatest: "0.4.111" })).toBeNull();
		expect(NOW - published.published["0.4.111"]).toBeLessThan(AUTO_UPDATE_STUCK_AFTER_MS);
	});

	it("flags a stale release check even when the machine is behind by less than the threshold", () => {
		// Behind only 0.4.111 (12h), but its check never moved past 0.4.98: it will not catch up.
		const stuck = assessAutoUpdateStuck({ ...pink, runnerVersion: "0.4.110", reportedLatest: "0.4.98" });
		expect(stuck).toMatchObject({ reason: "stale_latest", releases_behind: 1, behind_since: new Date(published.published["0.4.99"]).toISOString(), remedy: "runner_update" });
	});

	it("is silent when the policy is off, the machine is offline, or it already reports unsupported", () => {
		expect(assessAutoUpdateStuck({ ...pink, autoUpdate: false })).toBeNull();
		expect(assessAutoUpdateStuck({ ...pink, connected: false })).toBeNull();
		expect(assessAutoUpdateStuck({ ...pink, status: "unsupported" })).toBeNull();
	});

	it("unknown is not stuck: no registry answer, or an unreadable runner version", () => {
		expect(assessAutoUpdateStuck({ ...pink, published: null })).toBeNull();
		expect(assessAutoUpdateStuck({ ...pink, runnerVersion: "" })).toBeNull();
		expect(assessAutoUpdateStuck({ ...pink, runnerVersion: "dev" })).toBeNull();
	});

	it("flags any status, not only waiting_for_idle — the status is the runner's own record", () => {
		expect(assessAutoUpdateStuck({ ...pink, status: "enabled" })?.reason).toBe("behind_published");
		expect(assessAutoUpdateStuck({ ...pink, status: "installing" })?.reason).toBe("behind_published");
	});
});

describe("parsePublishedCli / fetchPublishedCli", () => {
	it("keeps the latest tag and release publish times only", () => {
		expect(parsePublishedCli({ "dist-tags": { latest: "0.4.111" }, time: { created: "2026-01-01T00:00:00Z", modified: "2026-10-11T00:00:00Z", "0.4.111": "2026-10-11T19:36:29.429Z", "0.5.0-beta.1": "2026-10-11T00:00:00Z" } }))
			.toEqual({ latest: "0.4.111", published: { "0.4.111": Date.parse("2026-10-11T19:36:29.429Z") } });
	});

	it("an unreadable document is null, never a guess", () => {
		expect(parsePublishedCli(null)).toBeNull();
		expect(parsePublishedCli({ "dist-tags": {} })).toBeNull();
		expect(parsePublishedCli({ "dist-tags": { latest: "next" } })).toBeNull();
	});

	it("a failed or non-OK registry answer is null", async () => {
		expect(await fetchPublishedCli(vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBeNull();
		expect(await fetchPublishedCli(vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch)).toBeNull();
		const ok = vi.fn(async () => Response.json({ "dist-tags": { latest: "0.4.111" }, time: { "0.4.111": "2026-10-11T19:36:29.429Z" } }));
		expect((await fetchPublishedCli(ok as unknown as typeof fetch))?.latest).toBe("0.4.111");
		expect(ok).toHaveBeenCalledWith("https://registry.npmjs.org/@proagentstore%2fcli", expect.anything());
	});
});

describe("an `unsupported` that is really a Windows npm call that cannot start (#1054)", () => {
	// dell-laptop, 2026-10-13: 0.4.112 on win32, ON, connected, its updater's stored reason the npm refusal.
	const releases: PublishedCli = { latest: "0.4.117", published: { "0.4.112": NOW - 2 * DAY, "0.4.113": NOW - 7 * 3_600_000, "0.4.117": NOW - 3_600_000 } };
	const NPM = "npm could not be asked for the latest @proagentstore/cli from this machine.";
	const dell = { autoUpdate: true, status: "unsupported", connected: true, runnerVersion: "0.4.112", reportedLatest: null, published: releases, now: NOW, lastError: NPM, platform: "win32" };

	it("is flagged at once — it can never fetch the fix — with the at-the-machine remedy, not runner_update", () => {
		const stuck = assessAutoUpdateStuck(dell);
		expect(stuck).toMatchObject({ reason: "cannot_fetch_update", remedy: "manual_npm_install", published_version: "0.4.117", releases_behind: 2, behind_since: new Date(NOW - 7 * 3_600_000).toISOString() });
		expect(stuck?.detail).toMatch(/npm i -g @proagentstore\/cli[\s\S]*restart the "pags up" scheduled task/);
		expect(stuck?.detail).toContain(NPM); // the runner's own reason, quoted
	});

	it("a permanent `unsupported` (source checkout, no restarter) still hides nothing", () => {
		expect(assessAutoUpdateStuck({ ...dell, lastError: "This runner runs from a source checkout — update it with `git pull` there, not npm." })).toBeNull();
		expect(assessAutoUpdateStuck({ ...dell, lastError: null })).toBeNull();
	});

	it("the same reason off Windows is the ordinary rule: stuck only after a day, with runner_update", () => {
		expect(assessAutoUpdateStuck({ ...dell, platform: "darwin" })).toBeNull(); // 7 hours behind
		expect(assessAutoUpdateStuck({ ...dell, platform: "darwin", published: { ...releases, published: { ...releases.published, "0.4.113": NOW - 2 * DAY } } })).toMatchObject({ reason: "behind_published", remedy: "runner_update" });
	});

	it("a Windows runner already on the fixed npm path (0.4.117+) is never told to install by hand", () => {
		const later: PublishedCli = { latest: "0.4.120", published: { ...releases.published, "0.4.118": NOW - 3_600_000, "0.4.120": NOW - 600_000 } };
		expect(assessAutoUpdateStuck({ ...dell, runnerVersion: "0.4.117", published: later })).toBeNull();
	});

	it("off, disconnected or current: nothing to flag", () => {
		expect(assessAutoUpdateStuck({ ...dell, autoUpdate: false })).toBeNull();
		expect(assessAutoUpdateStuck({ ...dell, connected: false })).toBeNull();
		expect(assessAutoUpdateStuck({ ...dell, runnerVersion: "0.4.117" })).toBeNull();
	});
});
