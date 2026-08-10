import { describe, expect, it } from "vitest";
import { describeFacts } from "./runner-availability.js";
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

	// #468 — the SECOND adapter. #461 taught `describeFacts` to forward the pin and left this
	// function forwarding three of `diagnoseAttachment`'s five inputs, which is what
	// `subordinate_status`, `start_work`/Loop and the chat-tool session opener all read.
	it("forwards the pin, so a pinned agent is never told to --force the machine that IS up", () => {
		// The exact production state #461 measured: the pin is on a switched-off machine, and the
		// heartbeat reads FRESH because on a multi-machine account the live machine's heartbeat
		// lands on the shared default row. Every input below is the one the three call sites hold.
		const c = classifySubordinateConnectivity({
			requiresRunner: true,
			hasRuntimeRow: true,
			relayConnected: false,
			node: "Sergeys-MacBook-Pro.local",
			lastSeenAt: secondsAgo(10),
			pinnedNode: "Sergeys-Mac-mini.local",
			liveNodeExcludedByPin: "Sergeys-MacBook-Pro.local",
			now: NOW,
		});
		expect(c.state).toBe("pinned-machine-offline");
		// The three assertions that matter, matching `runner-availability.test.ts` for the other
		// adapter: no remedy, and a sentence that prescribes neither command.
		expect(c.remedy).toBeNull();
		expect(c.message).not.toContain("--force");
		expect(c.message).not.toContain("pags up");
		// Both machines named — the dead pin and the live one — since the fix is to repoint the
		// pin, and the user cannot do that without knowing what to repoint it TO.
		expect(c.message).toContain("Sergeys-Mac-mini.local");
		expect(c.message).toContain("Sergeys-MacBook-Pro.local");
		// The sentence must not be suffixed with "(machine: <the excluded machine>)" — that is the
		// one machine this agent is deliberately not allowed to run on.
		expect(c.message).not.toContain("machine: ");
		// Unchanged from before the fix, and the reason this is safe to ship: no delegation
		// decision moves. Only the explanation does.
		expect(c.canWork).toBe(false);
	});

	it("leaves the unpinned detached case saying --force", () => {
		// The regression guard for the fix above: `--force` is the right answer when the machine
		// really is up and only this agent lost its socket, which is every account with no pin.
		const c = classifySubordinateConnectivity({
			requiresRunner: true,
			hasRuntimeRow: true,
			relayConnected: false,
			node: "macbook",
			lastSeenAt: secondsAgo(10),
			pinnedNode: null,
			liveNodeExcludedByPin: null,
			now: NOW,
		});
		expect(c.state).toBe("machine-online-agent-detached");
		expect(c.remedy).toBe("pags up --force");
	});

	it("agrees with the other adapter on the same facts", () => {
		// The invariant, stated where it can be checked: `describeFacts` and this function are two
		// adapters onto ONE diagnosis, and the whole defect class is one of them going stale when
		// the diagnosis grows an input. Spreading the SAME `RuntimeFacts` through both must yield
		// the same state and the same remedy, whatever the fields are.
		const facts = {
			hasRuntimeRow: true,
			relayConnected: false,
			node: "Sergeys-MacBook-Pro.local",
			runnerVersion: "0.4.45",
			lastSeenAt: secondsAgo(10),
			pinnedNode: "Sergeys-Mac-mini.local",
			liveNodeExcludedByPin: "Sergeys-MacBook-Pro.local",
		};
		const viaSubordinate = classifySubordinateConnectivity({ requiresRunner: true, ...facts, now: NOW });
		const viaFacts = describeFacts(facts);
		expect(viaSubordinate.state).toBe(viaFacts.state);
		expect(viaSubordinate.remedy).toBe(viaFacts.remedy);
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

// #484 — budget dimension. Runner connectivity and account ceiling are independent.
describe("classifySubordinateConnectivity — budget dimension (#484)", () => {
	// A ceiling well above any spend: "budget is clear".
	const clearBudget = {
		chargedMicros: 1_000_000, // $1
		chargedMicrosCeiling: 50_000_000, // $50
		tokens: 1_000_000,
		tokenCeiling: 250_000_000,
		budgetEnforced: false,
		windowOldestAt: "2026-08-09T10:00:00",
	};
	// A ceiling that has been reached.
	const trippedBudget = {
		chargedMicros: 50_000_000, // $50 — at the ceiling
		chargedMicrosCeiling: 50_000_000,
		tokens: 1_000_000,
		tokenCeiling: 250_000_000,
		budgetEnforced: false,
		windowOldestAt: "2026-08-09T10:00:00",
	};
	const trippedTokenBudget = {
		chargedMicros: 1_000_000,
		chargedMicrosCeiling: 50_000_000,
		tokens: 250_000_000, // at the ceiling
		tokenCeiling: 250_000_000,
		budgetEnforced: false,
		windowOldestAt: "2026-08-09T10:00:00",
	};

	it("attaches a budget field when budgetFacts are supplied", () => {
		const c = classifySubordinateConnectivity({
			requiresRunner: false,
			hasRuntimeRow: false,
			relayConnected: false,
			now: NOW,
			budgetFacts: clearBudget,
		});
		expect(c.budget).toBeDefined();
		expect(c.budget?.chargedMicros).toBe(1_000_000);
		expect(c.budget?.ceilingTripped).toBe(false);
	});

	it("omits budget when no budgetFacts are supplied (backward-compatible)", () => {
		const c = classifySubordinateConnectivity({
			requiresRunner: false,
			hasRuntimeRow: false,
			relayConnected: false,
			now: NOW,
		});
		expect(c.budget).toBeUndefined();
	});

	it("sets ceilingTripped=true when charged spend hits the ceiling", () => {
		const c = classifySubordinateConnectivity({
			requiresRunner: false,
			hasRuntimeRow: false,
			relayConnected: false,
			now: NOW,
			budgetFacts: trippedBudget,
		});
		expect(c.budget?.ceilingTripped).toBe(true);
	});

	it("sets ceilingTripped=true when token count hits the ceiling", () => {
		const c = classifySubordinateConnectivity({
			requiresRunner: false,
			hasRuntimeRow: false,
			relayConnected: false,
			now: NOW,
			budgetFacts: trippedTokenBudget,
		});
		expect(c.budget?.ceilingTripped).toBe(true);
	});

	it("does NOT lower canWork when enforcement is off, even when ceiling is tripped", () => {
		// THE key invariant from #485: observe-only is the default. A tripped ceiling must
		// never block delegation unless BUDGET_ENFORCE is on. Lowering canWork here would
		// reintroduce exactly the blocking that #485 removed.
		const c = classifySubordinateConnectivity({
			requiresRunner: false,
			hasRuntimeRow: false,
			relayConnected: false,
			now: NOW,
			budgetFacts: { ...trippedBudget, budgetEnforced: false },
		});
		expect(c.canWork).toBe(true);
		expect(c.budget?.ceilingTripped).toBe(true);
		expect(c.budget?.budgetEnforced).toBe(false);
	});

	it("lowers canWork when enforcement is on and ceiling is tripped", () => {
		// When BUDGET_ENFORCE=true, the ceiling is a hard gate. A supervisor that sees
		// canWork:true must be able to trust it — so a tripped ceiling that blocks reserve()
		// must also be visible here, not only discovered when the first loop step fails.
		const c = classifySubordinateConnectivity({
			requiresRunner: false,
			hasRuntimeRow: false,
			relayConnected: false,
			now: NOW,
			budgetFacts: { ...trippedBudget, budgetEnforced: true },
		});
		expect(c.canWork).toBe(false);
		expect(c.budget?.ceilingTripped).toBe(true);
		expect(c.budget?.budgetEnforced).toBe(true);
		// Message must explain why and not suggest starting a runner.
		expect(c.message).toMatch(/ceiling/i);
		expect(c.message).not.toMatch(/pags up/i);
	});

	it("keeps canWork true when ceiling is not tripped and enforcement is on", () => {
		// A clear ceiling under enforcement must not gate anything — the flag alone must not block.
		const c = classifySubordinateConnectivity({
			requiresRunner: false,
			hasRuntimeRow: false,
			relayConnected: false,
			now: NOW,
			budgetFacts: { ...clearBudget, budgetEnforced: true },
		});
		expect(c.canWork).toBe(true);
		expect(c.budget?.ceilingTripped).toBe(false);
	});

	it("runner-connected subordinate: tripped ceiling with enforcement lowers canWork", () => {
		// The runner path: connected AND ceiling tripped AND enforcement on → canWork false.
		const c = classifySubordinateConnectivity({
			requiresRunner: true,
			hasRuntimeRow: true,
			relayConnected: true,
			node: "macbook",
			now: NOW,
			budgetFacts: { ...trippedBudget, budgetEnforced: true },
		});
		expect(c.state).toBe("attached"); // runner IS connected
		expect(c.canWork).toBe(false); // but budget blocks
		expect(c.budget?.ceilingTripped).toBe(true);
		expect(c.message).toMatch(/ceiling/i);
	});

	it("runner-connected subordinate: tripped ceiling without enforcement keeps canWork", () => {
		// Enforcement off → the runner verdict alone decides canWork. Budget is advisory.
		const c = classifySubordinateConnectivity({
			requiresRunner: true,
			hasRuntimeRow: true,
			relayConnected: true,
			node: "macbook",
			now: NOW,
			budgetFacts: { ...trippedBudget, budgetEnforced: false },
		});
		expect(c.state).toBe("attached");
		expect(c.canWork).toBe(true); // enforcement off → runner wins
		expect(c.budget?.ceilingTripped).toBe(true);
	});

	it("surfaces windowOldestAt in the budget field for reset timing", () => {
		const c = classifySubordinateConnectivity({
			requiresRunner: false,
			hasRuntimeRow: false,
			relayConnected: false,
			now: NOW,
			budgetFacts: { ...trippedBudget, budgetEnforced: true, windowOldestAt: "2026-08-09T10:00:00" },
		});
		expect(c.budget?.windowOldestAt).toBe("2026-08-09T10:00:00");
		// The message should mention when headroom returns.
		expect(c.message).toContain("2026-08-09T10:00:00");
	});
});
