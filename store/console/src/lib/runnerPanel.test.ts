import { afterEach, describe, expect, it, vi } from "vitest";
import { agoShort, machinesToShow, machineTile, type NodeDetail, pinnedWarning, runnerReading } from "./runnerPanel";

const INST = "inst-1";

afterEach(() => {
	vi.useRealTimers();
});

/** Freeze the clock and return an ISO stamp `secondsAgo` in the past. */
function ago(secondsAgo: number, sep: "T" | " " = "T"): string {
	const now = new Date("2026-08-07T12:00:00.000Z");
	vi.useFakeTimers();
	vi.setSystemTime(now);
	const iso = new Date(now.getTime() - secondsAgo * 1000).toISOString();
	return sep === "T" ? iso : iso.replace("T", " ").replace(/\.\d+Z$/, "");
}

describe("agoShort", () => {
	it("floors into the band rather than rounding out of it", () => {
		// Rounding printed 59.5 minutes as "60m ago" and 23.99 hours as "24h ago" — the unit the
		// band above exists to express, printed by the band below it.
		expect(agoShort(ago(3570))).toBe("59m ago");
		expect(agoShort(ago(86_390))).toBe("23h ago");
		expect(agoShort(ago(90))).toBe("1m ago");
	});

	it("picks the band the elapsed time is actually in", () => {
		expect(agoShort(ago(0))).toBe("0s ago");
		expect(agoShort(ago(59))).toBe("59s ago");
		expect(agoShort(ago(60))).toBe("1m ago");
		expect(agoShort(ago(3600))).toBe("1h ago");
		expect(agoShort(ago(86_400))).toBe("1d ago");
	});

	it("reads a zone-less D1 stamp as UTC, not local", () => {
		// `YYYY-MM-DD HH:MM:SS` parsed as local time reports a machine seen seconds ago as hours
		// stale — wrong by the reader's own offset, so it looks right in London and wrong in Sydney.
		expect(agoShort(ago(120, " "))).toBe("2m ago");
	});

	it("says something rather than nothing for a missing or unparseable stamp", () => {
		// "" rendered the tile's meta line as "local · seen " — a truncated page, not a value.
		expect(agoShort(null)).toBe("never");
		expect(agoShort(undefined)).toBe("never");
		expect(agoShort("not a date")).toBe("unknown");
	});

	it("does not report a clock-skewed future stamp as negative", () => {
		expect(agoShort(ago(-30))).toBe("0s ago");
	});
});

describe("machinesToShow", () => {
	const other = { node: "desktop", connected: true, instances: [] };

	it("leaves the list alone when the pinned machine is already on it", () => {
		expect(machinesToShow([other], "desktop", INST, []).map((m) => m.node)).toEqual(["desktop"]);
		expect(machinesToShow([other], "", INST, []).map((m) => m.node)).toEqual(["desktop"]);
	});

	it("shows the pinned machine first when Terminals does not list it", () => {
		expect(machinesToShow([other], "laptop", INST, []).map((m) => m.node)).toEqual(["laptop", "desktop"]);
	});

	// The contradiction this module exists for. `/v1/terminals/nodes` drops a node that serves no
	// runner-using agent; `/v1/instances/:id/runner-node` always reports the pinned one. Synthesising
	// `connected:false` asserted the machine was off while the endpoint that knows said it was on.
	it("does not assert the pinned machine is offline when /runner-node says it is up", () => {
		const detail: NodeDetail[] = [{ node: "laptop", connected: false, nodeOnline: true }];
		const tile = machineTile(machinesToShow([], "laptop", INST, detail)[0], INST, "laptop");
		expect(tile.tone).not.toBe("offline");
		expect(tile.statusText).toBe("Online · agent not attached");
		// …which is the same sentence the warning under the grid prints.
		expect(pinnedWarning("laptop", detail)).toBe("not_attached");
	});

	it("shows the pinned machine as attached when this agent's own socket is up on it", () => {
		const detail: NodeDetail[] = [{ node: "laptop", connected: true, nodeOnline: true }];
		const tile = machineTile(machinesToShow([], "laptop", INST, detail)[0], INST, "laptop");
		expect(tile.tone).toBe("attached");
		expect(pinnedWarning("laptop", detail)).toBeNull();
	});

	it("still reads offline when that is what /runner-node says", () => {
		const detail: NodeDetail[] = [{ node: "laptop", connected: false, nodeOnline: false }];
		expect(machineTile(machinesToShow([], "laptop", INST, detail)[0], INST, "laptop").tone).toBe("offline");
		expect(pinnedWarning("laptop", detail)).toBe("offline");
	});

	// #379. A hostname moves under a machine, so a pin can name the right MACHINE and the wrong
	// NAME at the same time. The server proves sameness with a persisted machine id and reports
	// where the pin resolved; the card must not print "⚠ offline" over an agent that is working.
	it("says the machine was renamed rather than warning about a pin that already resolves", () => {
		const detail: NodeDetail[] = [{ node: "RLs-MacBook-Air.local", connected: false, nodeOnline: false }];
		expect(pinnedWarning("RLs-MacBook-Air.local", detail, "Mac")).toBe("renamed");
		// Without the server's proof it is the old, honest "offline" — a rename is never guessed.
		expect(pinnedWarning("RLs-MacBook-Air.local", detail)).toBe("offline");
		// And a pin that resolves to itself is not a rename.
		expect(pinnedWarning("RLs-MacBook-Air.local", detail, "RLs-MacBook-Air.local")).toBe("offline");
	});

	it("never disagrees with the warning under it, for any state of the pinned node", () => {
		// The invariant, stated once so a fourth reading cannot be added that breaks it: the tile's
		// tone and the warning are two renderings of one answer.
		for (const connected of [true, false]) {
			for (const nodeOnline of [true, false, undefined]) {
				const detail: NodeDetail[] = [{ node: "laptop", connected, nodeOnline }];
				const tile = machineTile(machinesToShow([], "laptop", INST, detail)[0], INST, "laptop");
				const warning = pinnedWarning("laptop", detail);
				const reading = runnerReading(null, detail, "laptop");
				if (warning === null) expect(tile.tone).toBe("attached");
				if (warning === "not_attached") expect(tile.tone).toBe("online");
				if (warning === "offline") expect(tile.tone).toBe("offline");
				// And the status line at the top of the same card.
				expect(reading.online).toBe(tile.tone === "attached");
			}
		}
	});
});

describe("machineTile", () => {
	it("is green only when THIS agent is attached, not merely when the machine is up", () => {
		const m = { node: "desktop", connected: true, instances: [{ instanceId: "other", connected: true }] };
		expect(machineTile(m, INST, "").tone).toBe("online");
		expect(machineTile(m, INST, "").statusText).toBe("Online · agent not attached");
	});

	it("marks the pinned tile, and only that one", () => {
		const m = { node: "desktop", connected: true };
		expect(machineTile(m, INST, "desktop").pinned).toBe(true);
		expect(machineTile(m, INST, "laptop").pinned).toBe(false);
		expect(machineTile(m, INST, "").pinned).toBe(false);
	});

	it("describes where the machine is and what it runs", () => {
		expect(machineTile({ node: "n", connected: true, placement: "managed", runnerVersion: "0.3.3", lastSeenAt: null }, INST, "").meta)
			.toBe("cloud · v0.3.3 · seen never");
		expect(machineTile({ node: "n", connected: false }, INST, "").meta).toBe("local · seen never");
	});
});

describe("runnerReading", () => {
	it("reads the relay keys, not the top-level ones", () => {
		// There is no top-level `connected`; reading it made the panel say Offline permanently.
		expect(runnerReading({ connected: true }, [], "").online).toBe(false);
		expect(runnerReading({ relay: { connected: true, runnerNode: "laptop" } }, [], "").online).toBe(true);
		expect(runnerReading({ relay: { connected: true, runnerNode: "laptop" } }, [], "").node).toBe("laptop");
	});

	it("does not open on a false Offline while the probe is in flight", () => {
		expect(runnerReading(null, [{ node: "laptop", connected: true }], "laptop").online).toBe(true);
	});

	it("falls back to the pin for the machine name, and to empty when there is none", () => {
		expect(runnerReading({ relay: { connected: false, runnerNode: null } }, [], "laptop").node).toBe("laptop");
		expect(runnerReading(null, [], "").node).toBe("");
	});

	it("reports the machine being up for other agents separately from this one", () => {
		const r = runnerReading(null, [{ node: "laptop", connected: false, nodeOnline: true }], "laptop");
		expect(r.online).toBe(false);
		expect(r.pinnedNodeOnline).toBe(true);
	});
});

describe("pinnedWarning", () => {
	it("says nothing when nothing is pinned or the node is unknown", () => {
		expect(pinnedWarning("", [{ node: "laptop", connected: false }])).toBeNull();
		expect(pinnedWarning("laptop", [])).toBeNull();
	});

	it("treats an older response with no nodeOnline as offline rather than guessing", () => {
		expect(pinnedWarning("laptop", [{ node: "laptop", connected: false }])).toBe("offline");
	});
});
