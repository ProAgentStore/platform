import { describe, expect, it } from "vitest";
import { classifySubordinateConnectivity } from "./subordinate-connectivity.js";

const NOW = Date.parse("2026-08-06T06:00:00Z");
const secondsAgo = (s: number) => new Date(NOW - s * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

describe("classifySubordinateConnectivity", () => {
	it("says a connected runner can be given work even with nothing in flight", () => {
		// THE bug (#259). The Coder Lead read four idle subordinates, concluded "No active runner"
		// for all of them and refused to delegate — while `pags up` was running, the relay was
		// connected and health was ok. Busyness and reachability are independent, and this is the
		// field that has to say so out loud so the model never has to deduce it.
		const c = classifySubordinateConnectivity({
			requiresRunner: true,
			hasRuntimeRow: true,
			relayConnected: true,
			node: "macbook",
			runnerVersion: "0.4.32",
			lastSeenAt: secondsAgo(20),
			now: NOW,
		});
		expect(c.canWork).toBe(true);
		expect(c.state).toBe("attached");
		expect(c.remedy).toBeNull();
		// The wording has to license delegation explicitly. "Connected." was written for a tooltip
		// beside a green dot; a model reading raw JSON has no dot to read it against.
		expect(c.message).toMatch(/delegate/i);
		expect(c.message).toContain("macbook");
	});

	it("never tells a cloud-only agent to run pags up", () => {
		// A pipeline/RAG/connector agent declares `runtime: null` — there is no machine to be
		// offline. Running it through the attachment diagnosis would report "never-registered →
		// pags up", turning an always-available subordinate into a refusal with a bogus remedy.
		const c = classifySubordinateConnectivity({ requiresRunner: false, hasRuntimeRow: false, relayConnected: false, now: NOW });
		expect(c.canWork).toBe(true);
		expect(c.state).toBe("not-required");
		expect(c.remedy).toBeNull();
		expect(c.message).not.toMatch(/pags up/);
	});

	it("names the machine when the runner has gone quiet", () => {
		// The complaint behind the whole ticket was a refusal the user could not act on. When the
		// runner really is down, the answer must say WHICH machine — a multi-machine account
		// otherwise has to guess which laptop to go and wake.
		const c = classifySubordinateConnectivity({
			requiresRunner: true,
			hasRuntimeRow: true,
			relayConnected: false,
			node: "studio",
			lastSeenAt: secondsAgo(600),
			now: NOW,
		});
		expect(c.canWork).toBe(false);
		expect(c.state).toBe("runner-offline");
		expect(c.remedy).toBe("pags up");
		expect(c.message).toContain("studio");
	});

	it("distinguishes never-registered from stopped", () => {
		// Same remedy, different truth. "You have never started a runner for this agent" and
		// "your runner stopped" send the user to different places, and collapsing them is the
		// same conflation that produced the bug one level up.
		const never = classifySubordinateConnectivity({ requiresRunner: true, hasRuntimeRow: false, relayConnected: false, now: NOW });
		expect(never.state).toBe("never-registered");
		const stopped = classifySubordinateConnectivity({ requiresRunner: true, hasRuntimeRow: true, relayConnected: false, lastSeenAt: secondsAgo(600), now: NOW });
		expect(stopped.state).toBe("runner-offline");
	});

	it("reports a live machine with a detached agent as detached, not offline", () => {
		// The heartbeat is fresh, so the machine is demonstrably alive — another runner on the
		// same hostname holds this agent. `pags up` would be rejected again; `--force` is the fix.
		const c = classifySubordinateConnectivity({
			requiresRunner: true,
			hasRuntimeRow: true,
			relayConnected: false,
			node: "macbook",
			lastSeenAt: secondsAgo(10),
			now: NOW,
		});
		expect(c.state).toBe("machine-online-agent-detached");
		expect(c.remedy).toBe("pags up --force");
		expect(c.canWork).toBe(false);
	});

	it("keeps the runner version so a supervisor can report a stale CLI", () => {
		// `coding_diagnostics` already reported it at the same moment the Lead was guessing.
		// Carrying it means a supervisor can answer "which version is that machine on" without a
		// second tool call it does not have.
		const c = classifySubordinateConnectivity({
			requiresRunner: true,
			hasRuntimeRow: true,
			relayConnected: true,
			node: "macbook",
			runnerVersion: "0.4.32",
			now: NOW,
		});
		expect(c.runnerVersion).toBe("0.4.32");
	});

	it("treats a blank node or version as absent rather than empty-string", () => {
		// `instance_runtimes.runner_node` is NOT NULL DEFAULT '' (migration 0030), so the empty
		// string is the common case, not a rarity. Rendering "(machine: )" in a refusal reads as
		// a bug to the user and as a real machine name to the model.
		const c = classifySubordinateConnectivity({
			requiresRunner: true,
			hasRuntimeRow: true,
			relayConnected: true,
			node: "   ",
			runnerVersion: "",
			now: NOW,
		});
		expect(c.node).toBeNull();
		expect(c.runnerVersion).toBeNull();
		expect(c.message).not.toContain("machine: ");
	});
});
