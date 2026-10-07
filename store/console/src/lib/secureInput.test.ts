import { describe, expect, it } from "vitest";
import { isMachineDeposit, secureInputStatusLine } from "./secureInput";

describe("secure input wording (#906, #918)", () => {
	it("tells an owner entry from a machine deposit by where the value came from", () => {
		expect(isMachineDeposit({})).toBe(false);
		expect(isMachineDeposit({ sourceNode: "mac-mini" })).toBe(true);
	});

	it("never asks the owner to type a machine deposit", () => {
		for (const status of ["pending", "ready", "consumed", "expired"] as const) {
			if (status === "pending") continue;
			expect(secureInputStatusLine({ status, sourceNode: "mac-mini" })).not.toMatch(/enter the value/i);
		}
		expect(secureInputStatusLine({ status: "pending" })).toBe("Waiting for you to enter the value");
	});

	it("names both machines of a completed handoff", () => {
		expect(secureInputStatusLine({ status: "ready", sourceNode: "mac-mini" })).toBe("Deposited from mac-mini — waiting to be retrieved on another machine");
		expect(secureInputStatusLine({ status: "consumed", sourceNode: "mac-mini", consumedNode: "pink-laptop" })).toBe("Moved from mac-mini to pink-laptop");
		expect(secureInputStatusLine({ status: "consumed" })).toBe("Used — the value has been deleted");
		expect(secureInputStatusLine({ status: "expired", sourceNode: "mac-mini" })).toBe("Expired unused — the value was deleted");
	});
});

describe("a deposit is a deposit even when its machine had no name (#929 finding 14)", () => {
	it("follows the server's kind before guessing from sourceNode", () => {
		expect(isMachineDeposit({ kind: "deposit" })).toBe(true);
		expect(isMachineDeposit({ kind: "owner", sourceNode: "mac" })).toBe(false);
		// No password box, and no "your value has been received", for a nameless deposit.
		expect(secureInputStatusLine({ status: "ready", kind: "deposit" })).toBe("Deposited from a machine — waiting to be retrieved on another machine");
		expect(secureInputStatusLine({ status: "consumed", kind: "deposit", consumedNode: "laptop" })).toBe("Moved from a machine to laptop");
		expect(secureInputStatusLine({ status: "ready", kind: "owner" })).toBe("Entered — waiting for the agent to use it");
	});
});

