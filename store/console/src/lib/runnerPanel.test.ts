import { afterEach, describe, expect, it, vi } from "vitest";
import { agoShort, type Machine, machinesToShow, machineTile, type NodeDetail, pinnedWarning, runnerReading } from "./runnerPanel";

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

	// The tile the sweep above could not reach: a machine ALREADY on the Terminals list, which is
	// every tile on a normal account. `machinesToShow` returned that list untouched, so the merge
	// the module promises happened for the synthesised tile and nothing else (#531).
	it("folds /runner-node's reading into a machine Terminals already lists", () => {
		// Terminals has not yet seen the socket this agent opened; /runner-node has.
		const machines: Machine[] = [{ node: "laptop", connected: false, instances: [{ instanceId: INST, connected: false }] }];
		const detail: NodeDetail[] = [{ node: "laptop", connected: true, nodeOnline: true }];
		const tile = machineTile(machinesToShow(machines, "laptop", INST, detail)[0], INST, "laptop");
		expect(tile.tone).toBe("attached");
		// And the reverse read: Terminals saw it, /runner-node's probe had not landed.
		const lagging: NodeDetail[] = [{ node: "laptop", connected: false, nodeOnline: false }];
		const seen: Machine[] = [{ node: "laptop", connected: true, instances: [{ instanceId: INST, connected: true }] }];
		expect(machineTile(machinesToShow(seen, "laptop", INST, lagging)[0], INST, "laptop").tone).toBe("attached");
	});

	// #379/#393 must survive the pin becoming load-bearing. A hostname moves under a machine, so a
	// pin can name the right MACHINE under a dead NAME — and routing already resolves through it.
	it("keeps a renamed machine attached, and does not draw it twice", () => {
		const machines: Machine[] = [{ node: "Mac", aka: ["RLs-MacBook-Air.local"], connected: true, instances: [{ instanceId: INST, connected: true }] }];
		const detail: NodeDetail[] = [
			{ node: "Mac", connected: true, nodeOnline: true },
			{ node: "RLs-MacBook-Air.local", connected: false, nodeOnline: false },
		];
		const tiles = machinesToShow(machines, "RLs-MacBook-Air.local", INST, detail);
		// ONE tile. Synthesising the retired name drew a grey "Offline · Pinned" next to a green
		// "Attached · Pinned" — two tiles, one machine, opposite claims.
		expect(tiles.map((t) => t.node)).toEqual(["Mac"]);
		const tile = machineTile(tiles[0], INST, "RLs-MacBook-Air.local");
		expect(tile.tone).toBe("attached");
		expect(tile.pinned).toBe(true);
	});

	it("takes the server's resolvedNode as proof of the same machine when Terminals has not folded", () => {
		// No `aka` here: the fold needs a persisted machine id and Terminals' rows may not carry one.
		// `/runner-node` holds that id and reports where the pin lands, so the tile trusts it rather
		// than telling a working agent it is not attached.
		const m: Machine = { node: "Mac", connected: true, instances: [{ instanceId: INST, connected: true }] };
		expect(machineTile(m, INST, "RLs-MacBook-Air.local", "Mac").tone).toBe("attached");
		// Without that proof it is the honest, routing-accurate answer: nothing resolves the pin.
		expect(machineTile(m, INST, "RLs-MacBook-Air.local").tone).toBe("connected");
	});
});

/**
 * The whole input space, so a fourth reading cannot re-introduce the divergence (#531).
 *
 * pinned-here / pinned-elsewhere / unpinned × socket / no socket × machine up / down × listed by
 * Terminals or not. The invariants asserted for EVERY tile of every combination:
 *
 *   1. "Attached" is said only where the routing puts work — never for a machine the pin excludes.
 *   2. The status line and the tiles agree: an Offline card contains no attached tile.
 *   3. For the pinned tile, the tone and the warning under the grid stay two renderings of one
 *      answer (the invariant the old sweep held for the synthesised tile alone).
 */
describe("machinesToShow + machineTile — connectivity is never reported as routing (#531)", () => {
	const LIVE = "laptop";
	const OTHER = "desktop";

	for (const pin of [LIVE, OTHER, ""]) {
		for (const socket of [true, false]) {
			for (const machineUp of [true, false]) {
				for (const listed of [true, false]) {
					const label = `pin=${pin || "(none)"} socket=${socket} machineUp=${machineUp} listed=${listed}`;
					it(`says the true thing — ${label}`, () => {
						// Terminals' reading of the machine that holds (or does not hold) the socket.
						const machines: Machine[] = listed
							? [{ node: LIVE, connected: machineUp || socket, instances: [{ instanceId: INST, connected: socket }] }]
							: [];
						// /runner-node's reading of the same machine, plus the pinned one when it is
						// elsewhere — exactly what the route returns (`available` ∪ the pin).
						const detail: NodeDetail[] = [
							{ node: LIVE, connected: socket, nodeOnline: machineUp || socket },
							...(pin === OTHER ? [{ node: OTHER, connected: false, nodeOnline: false }] : []),
						];
						// What `getBoundRunnerConn` would do: pinned ⇒ that machine only; unpinned ⇒
						// whichever machine holds a live socket. This is the ONLY definition of
						// "attached" the card is allowed to render.
						const routed = pin === OTHER ? false : socket;
						const runtimeInfo = { relay: { connected: routed, runnerNode: routed ? LIVE : null } };

						const tiles = machinesToShow(machines, pin, INST, detail).map((m) => machineTile(m, INST, pin));
						const reading = runnerReading(runtimeInfo, detail, pin);

						for (const t of tiles) {
							// 1. The word and the tone are one decision.
							expect(t.statusText.includes("Attached")).toBe(t.tone === "attached");
							// …and a tile only claims it when work reaches that machine.
							if (t.tone === "attached") expect(pin === "" || t.node === pin).toBe(true);
							// A machine the pin excludes says which fact it is reporting, and where the
							// work went instead — a reader must not have to infer it from a colour.
							if (t.tone === "connected") {
								expect(t.node).not.toBe(pin);
								expect(t.statusText).toContain("Connected");
								expect(t.statusText).toContain(pin);
							}
						}

						// 2. #531 itself: "Status: Offline" one line above a green "Attached" tile.
						if (!reading.online) expect(tiles.filter((t) => t.tone === "attached")).toEqual([]);
						expect(reading.online).toBe(routed);

						// 3. The pinned tile still never contradicts the warning under the grid.
						const pinnedTile = tiles.find((t) => t.pinned);
						if (pin) {
							expect(pinnedTile?.node).toBe(pin);
							const warning = pinnedWarning(pin, detail);
							if (warning === null) expect(pinnedTile?.tone).toBe("attached");
							if (warning === "not_attached") expect(pinnedTile?.tone).toBe("online");
							if (warning === "offline") expect(pinnedTile?.tone).toBe("offline");
						} else {
							expect(pinnedTile).toBeUndefined();
						}
					});
				}
			}
		}
	}

	// The reported screen, asserted as one statement (#531 AC5). Non-vacuous by construction: the
	// same fixture through the OLD rule produced "Attached · online" for `desktop`.
	it("cannot render Offline and Attached for the same instance at once", () => {
		const machines: Machine[] = [
			{ node: OTHER, connected: true, instances: [{ instanceId: INST, connected: true }] },
			{ node: LIVE, connected: false, instances: [{ instanceId: INST, connected: false }] },
		];
		const detail: NodeDetail[] = [
			{ node: OTHER, connected: true, nodeOnline: true },
			{ node: LIVE, connected: false, nodeOnline: false },
		];
		// Pinned to `laptop`, which is dead; `desktop` holds this agent's socket.
		const tiles = machinesToShow(machines, LIVE, INST, detail).map((m) => machineTile(m, INST, LIVE));
		const reading = runnerReading({ relay: { connected: false, runnerNode: null } }, detail, LIVE);

		expect(reading.online).toBe(false); // the card's status line reads "Offline"
		expect(tiles.map((t) => t.statusText).join(" | ")).not.toContain("Attached");
		const desktop = tiles.find((t) => t.node === OTHER);
		expect(desktop?.tone).toBe("connected");
		expect(desktop?.statusText).toBe("Connected · this agent runs on laptop");
		expect(pinnedWarning(LIVE, detail)).toBe("offline");
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
