import { describe, expect, it } from "vitest";
import { canSubmitSecureInput, isMachineDeposit, needsCommandApproval, secureInputStatusLine, secureInputSubmitBody, sudoCommandLine } from "./secureInput";

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


describe("a sudo request: the owner approves the exact command with the value (#1131)", () => {
	const PMSET = ["pmset", "-a", "autorestart", "1"];
	const sudo = { destinationScope: "sudo", command: PMSET };
	const tmux = { destinationScope: "tmux" };

	it("shows the command as the owner reads it, quoting what needs it so they can see where an argument ends", () => {
		expect(sudoCommandLine(PMSET)).toBe("sudo -- pmset -a autorestart 1");
		expect(sudoCommandLine(["sh", "-c", "echo $HOME; id"])).toBe("sudo -- sh -c 'echo $HOME; id'");
		expect(sudoCommandLine(["echo", "it's"])).toBe("sudo -- echo 'it'\\''s'");
	});

	it("only a sudo request that carries a command needs an approval", () => {
		expect(needsCommandApproval(sudo)).toBe(true);
		expect(needsCommandApproval(tmux)).toBe(false);
		expect(needsCommandApproval({ destinationScope: "sudo" })).toBe(false); // nothing to approve: the server will not deliver it either
		expect(needsCommandApproval({ destinationScope: "sudo", command: [] })).toBe(false);
	});

	it("Submit stays disabled until the value is entered AND the command is approved", () => {
		expect(canSubmitSecureInput(sudo, { value: "", approved: true })).toBe(false);
		expect(canSubmitSecureInput(sudo, { value: "pw", approved: false })).toBe(false);
		expect(canSubmitSecureInput(sudo, { value: "pw", approved: true })).toBe(true);
	});

	it("every other request needs only a value, exactly as before", () => {
		expect(canSubmitSecureInput(tmux, { value: "123456", approved: false })).toBe(true);
		expect(canSubmitSecureInput(tmux, { value: "", approved: false })).toBe(false);
	});

	it("the submit sends the argv exactly as it was shown — a copy, so the page cannot change what it approved", () => {
		const body = secureInputSubmitBody(sudo, "pw");
		expect(body).toEqual({ value: "pw", approvedCommand: PMSET });
		expect(body.approvedCommand).not.toBe(PMSET);
		expect(secureInputSubmitBody(tmux, "123456")).toEqual({ value: "123456" });
	});
});
