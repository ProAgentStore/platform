import { describe, expect, it } from "vitest";
import {
	isExecutableTarget,
	parseDelegationTarget,
	targetId,
	targetKey,
	unsupportedTargetReason,
} from "./delegate-target.js";

describe("parseDelegationTarget", () => {
	it("accepts the legacy { repoId } shape the drive_claude tool emits", () => {
		// The model is still prompted with repoId; an in-flight call must not break.
		expect(parseDelegationTarget({ repoId: "r1" })).toEqual({ kind: "repo", repoId: "r1" });
	});

	it("accepts the explicit { kind, id } form", () => {
		expect(parseDelegationTarget({ kind: "repo", id: "r1" })).toEqual({ kind: "repo", repoId: "r1" });
		expect(parseDelegationTarget({ kind: "instance", id: "i1" })).toEqual({ kind: "instance", instanceId: "i1" });
	});

	it("accepts a bare { instanceId } — the shape supervision config will use", () => {
		expect(parseDelegationTarget({ instanceId: "i1" })).toEqual({ kind: "instance", instanceId: "i1" });
	});

	it("trims surrounding whitespace off ids", () => {
		expect(parseDelegationTarget({ repoId: "  r1  " })).toEqual({ kind: "repo", repoId: "r1" });
		expect(parseDelegationTarget({ kind: " repo ", id: " r1 " })).toEqual({ kind: "repo", repoId: "r1" });
	});

	it("returns null rather than guessing a target", () => {
		// A wrong default target would delegate real work — with real spend — somewhere the
		// caller never named. Refusing is the only safe answer.
		expect(parseDelegationTarget(null)).toBeNull();
		expect(parseDelegationTarget("r1")).toBeNull();
		expect(parseDelegationTarget({})).toBeNull();
		expect(parseDelegationTarget({ repoId: "" })).toBeNull();
		expect(parseDelegationTarget({ repoId: "   " })).toBeNull();
		expect(parseDelegationTarget({ kind: "repo" })).toBeNull(); // kind without id
		expect(parseDelegationTarget({ kind: "wormhole", id: "x" })).toBeNull();
	});

	it("prefers the explicit kind over a stray legacy field", () => {
		expect(parseDelegationTarget({ kind: "instance", id: "i1", repoId: "r1" })).toEqual({
			kind: "instance",
			instanceId: "i1",
		});
	});
});

describe("isExecutableTarget", () => {
	it("allows repo targets — the Pilot path that exists today", () => {
		expect(isExecutableTarget({ kind: "repo", repoId: "r1" })).toBe(true);
	});

	it("allows instance targets now that #183/#184/#185 have landed", () => {
		// Held back until the supervision graph, the spend budget and authority containment
		// existed — without those this is an unbounded loop and a consent bypass. Each is
		// enforced on the delegation path itself (lib/delegate-instance.ts), not assumed.
		expect(isExecutableTarget({ kind: "instance", instanceId: "i1" })).toBe(true);
	});
});

describe("unsupportedTargetReason", () => {
	it("names the kind so an unknown target is debuggable", () => {
		expect(unsupportedTargetReason({ kind: "wormhole", id: "x" } as never)).toContain("wormhole");
	});
});

describe("targetId / targetKey", () => {
	it("reads the id regardless of kind", () => {
		expect(targetId({ kind: "repo", repoId: "r1" })).toBe("r1");
		expect(targetId({ kind: "instance", instanceId: "i1" })).toBe("i1");
	});

	it("never collides across kinds that share a raw id", () => {
		// targetKey feeds map keys and idempotency components — a collision would merge two
		// unrelated delegations into one.
		expect(targetKey({ kind: "repo", repoId: "x" })).not.toBe(targetKey({ kind: "instance", instanceId: "x" }));
	});
});
