import { describe, expect, it } from "vitest";
import {
	isValidMachineId,
	MAX_DECLINED,
	MAX_NAMES,
	parseMachineFile,
	withClaimedNames,
	withDeclinedNames,
	withName,
} from "./machine.js";

const ID = "2f1c8a90-0e2b-4b6a-9a2b-3c4d5e6f7081";

describe("parseMachineFile", () => {
	it("reads an id and its name history", () => {
		expect(parseMachineFile(JSON.stringify({ id: ID, names: ["Mac", "Mac.local"] })))
			.toEqual({ id: ID, names: ["Mac", "Mac.local"], declined: [] });
	});

	it("reads the names the user has already been asked about (#460)", () => {
		expect(parseMachineFile(JSON.stringify({ id: ID, names: ["Mac"], declined: ["other-laptop"] })))
			.toEqual({ id: ID, names: ["Mac"], declined: ["other-laptop"] });
	});

	// A corrupt file must cost the HEALING, never the ability to start a runner: `loadMachineIdentity`
	// treats null as "no record" and mints a fresh one rather than throwing out of `pags up`.
	it("treats an unreadable or id-less file as absent rather than as an error", () => {
		for (const text of ["", "{", "null", "[]", JSON.stringify({ names: ["Mac"] }), JSON.stringify({ id: "short" })]) {
			expect(parseMachineFile(text)).toBeNull();
		}
	});

	it("caps the stored history so a grown file cannot enlarge the claim it authorises", () => {
		const names = Array.from({ length: 40 }, (_, i) => `host-${i}`);
		expect(parseMachineFile(JSON.stringify({ id: ID, names }))?.names).toHaveLength(MAX_NAMES);
	});
});

describe("withName", () => {
	// The backfill this whole mechanism turns on (#379): the row left behind under the OLD
	// hostname has no machine id and never will, because the machine no longer registers under
	// it. Remembering that it once did is what lets the machine claim that row, which is what
	// reconnects a pin that was already stranded.
	it("remembers the previous hostname when the network renames the machine", () => {
		const first = withName({ id: ID, names: [] }, "RLs-MacBook-Air.local");
		expect(first.names).toEqual(["RLs-MacBook-Air.local"]);
		const renamed = withName(first, "Mac");
		expect(renamed.names).toEqual(["Mac", "RLs-MacBook-Air.local"]);
	});

	it("moves a name back to the front rather than repeating it", () => {
		const identity = withName(withName({ id: ID, names: [] }, "Mac"), "Mac.local");
		expect(withName(identity, "Mac").names).toEqual(["Mac", "Mac.local"]);
	});

	it("keeps the id and bounds the history", () => {
		let identity = { id: ID, names: [] as string[] };
		for (let i = 0; i < 30; i++) identity = withName(identity, `host-${i}`);
		expect(identity.id).toBe(ID);
		expect(identity.names).toHaveLength(MAX_NAMES);
		expect(identity.names[0]).toBe("host-29");
	});
});

describe("withClaimedNames", () => {
	// The step a user had to do in an editor (#460): the hostnames this laptop wore before it had
	// an id are the rows `claimMachineNames` can then stamp, which is what reconnects the pins.
	it("records the hand-edit the recovery used to require", () => {
		const claimed = withClaimedNames({ id: ID, names: ["Mac"], declined: [] }, ["RLs-MacBook-Air.local", "RLs-MacBook-Air"]);
		expect(claimed.names).toEqual(["Mac", "RLs-MacBook-Air.local", "RLs-MacBook-Air"]);
	});

	// `names` is capped and the cap is what the server acts on. A claim appended at the END of a
	// full list would be trimmed away, so the one entry a human actually asserted would be the one
	// that never got sent — a claim that silently does nothing.
	it("puts the claim ahead of passively-recorded history so the cap cannot swallow it", () => {
		const history = { id: ID, names: Array.from({ length: MAX_NAMES }, (_, i) => `host-${i}`), declined: [] };
		const claimed = withClaimedNames(history, ["the-one-that-matters"]);
		expect(claimed.names).toHaveLength(MAX_NAMES);
		expect(claimed.names[0]).toBe("host-0");
		expect(claimed.names[1]).toBe("the-one-that-matters");
	});

	it("does not repeat a name it already claims", () => {
		expect(withClaimedNames({ id: ID, names: ["Mac", "old"], declined: [] }, ["old"]).names).toEqual(["Mac", "old"]);
	});

	it("clears an earlier decline — the later answer is the answer", () => {
		const claimed = withClaimedNames({ id: ID, names: ["Mac"], declined: ["old", "other"] }, ["old"]);
		expect(claimed.declined).toEqual(["other"]);
	});
});

describe("withDeclinedNames", () => {
	it("remembers a decline so the offer is made once, not at every launch", () => {
		const first = withDeclinedNames({ id: ID, names: ["Mac"], declined: [] }, ["other-laptop"]);
		expect(first.declined).toEqual(["other-laptop"]);
		expect(withDeclinedNames(first, ["other-laptop"]).declined).toEqual(["other-laptop"]);
	});

	// `names` is the authority. A decline shadowing a claimed name would silently suppress the
	// offer if the claim were ever undone by hand — and hand-editing the file is the escape hatch.
	it("never declines a name this machine claims", () => {
		expect(withDeclinedNames({ id: ID, names: ["Mac"], declined: [] }, ["Mac"]).declined).toEqual([]);
	});

	it("bounds itself so the file cannot grow without limit", () => {
		let identity = { id: ID, names: ["Mac"], declined: [] as string[] };
		for (let i = 0; i < MAX_DECLINED + 10; i++) identity = withDeclinedNames(identity, [`host-${i}`]);
		expect(identity.declined).toHaveLength(MAX_DECLINED);
		expect(identity.declined?.at(-1)).toBe(`host-${MAX_DECLINED + 9}`);
	});
});

describe("isValidMachineId", () => {
	// Must agree with the server's `normalizeMachineId`, which silently drops anything else —
	// an id that fails there would look sent and do nothing.
	it("matches the shape the server accepts", () => {
		expect(isValidMachineId(ID)).toBe(true);
		for (const bad of ["", "short", null, 42, "has space"]) expect(isValidMachineId(bad)).toBe(false);
	});
});
