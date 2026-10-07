import { describe, expect, it } from "vitest";
import { behindLine, type MachineResources, resourceFacts, staleSample, tileHealth, warningHead } from "./machineHealth";
import { machineTile, updateOutcome } from "./runnerPanel";

const NOW = Date.parse("2026-10-07T10:00:00Z");
const res = (over: Partial<MachineResources> = {}): MachineResources => ({
	load1: 3.2,
	cpus: 8,
	loadPerCpu: 0.4,
	memUsedPct: 63.5,
	platform: "linux",
	sampledAt: new Date(NOW - 20_000).toISOString(),
	activeSessions: 2,
	recommendedMaxSessions: 4,
	disk: { usedPct: 71, inodesUsedPct: 12 },
	runner: { uptimeSec: 3 * 3600 + 5, starts24h: 1, relayReconnects: 0 },
	relayRttMs: 120,
	warnings: [],
	...over,
});

describe("machine resources on the console (#929 finding 6)", () => {
	it("says load, memory, disk, sessions against the ceiling, relay and uptime", () => {
		expect(resourceFacts(res())).toEqual(["load 0.4/core (8 cores)", "memory 63.5%", "disk 71%", "2 of ~4 sessions", "relay 120 ms", "up 3h"]);
	});

	it("never prints a bare macOS memory figure — it counts cache, and the server withholds that alarm", () => {
		expect(resourceFacts(res({ platform: "darwin", memUsedPct: 96 }))).toContain("memory 96% incl. cache");
	});

	it("names a crash-looping runner's restarts, and leaves out what an older CLI did not report", () => {
		expect(resourceFacts(res({ runner: { uptimeSec: 120, starts24h: 4, relayReconnects: 9 } }))).toContain("up 2m, 4 starts today");
		expect(resourceFacts(res({ disk: null, runner: null, relayRttMs: null, activeSessions: null }))).toEqual(["load 0.4/core (8 cores)", "memory 63.5%"]);
	});

	it("says when the sample is old — a stopped heartbeat is not an idle machine", () => {
		expect(staleSample(res(), NOW)).toBeNull();
		expect(staleSample(res({ sampledAt: new Date(NOW - 12 * 60_000).toISOString() }), NOW)).toBe("Last sample 12m ago — the heartbeat stopped, so these numbers are old.");
	});

	it("shortens a warning to its head for a tile, and the tile line to load and sessions", () => {
		expect(warningHead("CPU saturated: 1-minute load 30 on 8 cores (3.75 per core). A runner …")).toBe("CPU saturated");
		expect(warningHead("Relay round trip 1800 ms — at or over the 1500 ms a ping is given")).toBe("Relay round trip 1800 ms");
		expect(tileHealth(res())).toBe("load 0.4/core · 2 of ~4 sessions");
		expect(tileHealth(null)).toBe("");
	});

	it("a Runs-on tile carries the machine's health, warning heads and whether its CLI is out of date", () => {
		const t = machineTile(
			{ node: "mac", connected: true, instances: [], resources: res({ warnings: ["CPU saturated: load 30 on 8 cores."] }), runnerBehind: ["machine resources (needs 0.4.71)"] },
			"inst-1",
			"",
		);
		expect(t).toMatchObject({ health: "load 0.4/core · 2 of ~4 sessions", alerts: ["CPU saturated"], outdated: true });
		expect(machineTile({ node: "old", connected: true }, "inst-1", "")).toMatchObject({ health: "", alerts: [], outdated: false });
	});
});

describe("runner version gaps and the remote update (#929 finding 13)", () => {
	it("names the features an old CLI cannot run, and says nothing for a current one", () => {
		expect(behindLine(["machine resources (needs 0.4.71)", "clone jobs (needs 0.4.60)"])).toBe("This machine's `pags` CLI is too old for: machine resources (needs 0.4.71), clone jobs (needs 0.4.60).");
		expect(behindLine([])).toBeNull();
		expect(behindLine(null)).toBeNull();
	});

	it("reports the update's outcome in the console's words, not the MCP tools' names", () => {
		const scheduled = updateOutcome({
			action: "scheduled",
			detail: "mac will update 0.4.70 → 0.4.77 and restart as soon as these engines finish their turns — no run is cut off. Call runner_update again afterwards to confirm every agent re-attached.",
		});
		expect(scheduled.tone).toBe("pending");
		expect(scheduled.text).toContain("Refresh afterwards to confirm");
		expect(scheduled.text).not.toMatch(/runner_update/);
		const failed = updateOutcome({ action: "failed", detail: "The update may still be in flight; poll list_runner_nodes before retrying. If coding_diagnostics still reports an unresponsive runner, try force_runner_attach for an affected instance." });
		expect(failed.tone).toBe("warn");
		expect(failed.text).not.toMatch(/list_runner_nodes|coding_diagnostics|force_runner_attach/);
		expect(updateOutcome({ action: "restarted", detail: "Updated." }).tone).toBe("ok");
	});
});
