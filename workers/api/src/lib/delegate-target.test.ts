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

	it("refuses instance targets until #183/#184/#185 land", () => {
		// Agent-to-agent delegation without the supervision graph, a spend budget and authority
		// containment would be an unbounded loop and a consent bypass. Parse it, don't run it.
		expect(isExecutableTarget({ kind: "instance", instanceId: "i1" })).toBe(false);
	});
});

describe("unsupportedTargetReason", () => {
	it("explains the refusal in terms a human can act on", () => {
		const reason = unsupportedTargetReason({ kind: "instance", instanceId: "i1" });
		expect(reason).toContain("another agent");
		expect(reason).not.toBe("");
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
