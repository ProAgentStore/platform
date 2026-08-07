import { describe, expect, it } from "vitest";
import { isValidMachineId, MAX_NAMES, parseMachineFile, withName } from "./machine.js";

const ID = "2f1c8a90-0e2b-4b6a-9a2b-3c4d5e6f7081";

describe("parseMachineFile", () => {
	it("reads an id and its name history", () => {
		expect(parseMachineFile(JSON.stringify({ id: ID, names: ["Mac", "Mac.local"] })))
			.toEqual({ id: ID, names: ["Mac", "Mac.local"] });
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

describe("isValidMachineId", () => {
	// Must agree with the server's `normalizeMachineId`, which silently drops anything else —
	// an id that fails there would look sent and do nothing.
	it("matches the shape the server accepts", () => {
		expect(isValidMachineId(ID)).toBe(true);
		for (const bad of ["", "short", null, 42, "has space"]) expect(isValidMachineId(bad)).toBe(false);
	});
});
