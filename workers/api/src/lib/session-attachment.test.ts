import { describe, expect, it } from "vitest";
import { diagnoseSessionAttachment, type SessionAttachmentFacts } from "./session-attachment.js";
import { EMPTY_RUNTIME_FACTS } from "./instance-connectivity.js";

/** The shape the route hands in: the instance facts plus the session's stamped machine. */
const facts = (over: Partial<SessionAttachmentFacts>): SessionAttachmentFacts => ({
	...EMPTY_RUNTIME_FACTS,
	hasRuntimeRow: true,
	sessionNode: null,
	...over,
});

const FRESH = new Date().toISOString().replace("T", " ").slice(0, 19);

describe("diagnoseSessionAttachment — the #537 case: A is off, B is running `pags up`", () => {
	// THE bug. The banner had a boolean and rendered the only remedy a boolean can carry.
	it("names both machines and never prescribes `pags up`", () => {
		const d = diagnoseSessionAttachment(
			facts({ relayConnected: true, node: "B", sessionNode: "A", lastSeenAt: FRESH }),
		);
		expect(d.state).toBe("session-machine-offline");
		expect(d.message).toContain("A");
		expect(d.message).toContain("B");
		expect(d.message).not.toContain("pags up");
		expect(d.remedy).toBeNull();
	});

	it("says what to do about it — reopening relocates the session onto the live machine", () => {
		const d = diagnoseSessionAttachment(facts({ relayConnected: true, node: "B", sessionNode: "A" }));
		expect(d.message).toMatch(/open the session again/i);
	});

	// #379: a hostname is not a machine. The relay is keyed per NAME, so a session stamped with the
	// laptop's old name genuinely has no socket while the laptop is connected under its new one —
	// and reporting that as "A isn't connected. A.local is connected" draws one machine as two,
	// which is the defect #531 fixed one surface over.
	it("a renamed machine is one machine, not an offline one and a live one", () => {
		const d = diagnoseSessionAttachment(
			facts({
				relayConnected: true,
				node: "RLs-MacBook-Air.local",
				sessionNode: "RLs-MacBook-Air",
				sessionMachineLiveAs: "RLs-MacBook-Air.local",
			}),
		);
		expect(d.message).toContain("connected as RLs-MacBook-Air.local");
		expect(d.message).not.toMatch(/isn't connected/);
		expect(d.remedy).toBeNull();
	});

	it("a session stamped to no machine at all is not reported as an offline machine", () => {
		const d = diagnoseSessionAttachment(facts({ relayConnected: true, node: "B", sessionNode: null }));
		expect(d.message).toContain("B is connected");
		expect(d.remedy).toBeNull();
	});

	it("the session's OWN machine being the live one is a reattach, not an offline machine", () => {
		const d = diagnoseSessionAttachment(facts({ relayConnected: true, node: "B", sessionNode: "B" }));
		expect(d.message).toContain("B is connected, but this session isn't attached to it");
		expect(d.remedy).toBeNull();
	});
});

describe("diagnoseSessionAttachment — nothing routes anywhere: the instance vocabulary, unchanged", () => {
	// The whole point of delegating: one wording per situation across the platform. If these
	// sentences ever diverge from `diagnoseAttachment`, this file is the thing that notices.
	it("no registration at all", () => {
		const d = diagnoseSessionAttachment(facts({ hasRuntimeRow: false, relayConnected: false }));
		expect(d.state).toBe("never-registered");
		expect(d.remedy).toBe("pags up");
	});

	it("the machine has gone quiet — `pags up` IS the answer here", () => {
		const d = diagnoseSessionAttachment(facts({ relayConnected: false, lastSeenAt: null, sessionNode: "A" }));
		expect(d.state).toBe("runner-offline");
		expect(d.remedy).toBe("pags up");
	});

	// A pin is the one case where reopening the session CANNOT relocate it: the reopen resolves
	// through `getBoundRunnerConn`, which honours the pin and refuses to fall through. Telling the
	// owner to reopen would be a second false instruction, so this must stay the instance sentence.
	it("pinned to a machine that is off while another is up — the fix is 'Runs on', not a reopen", () => {
		const d = diagnoseSessionAttachment(
			facts({ relayConnected: false, sessionNode: "A", pinnedNode: "A", liveNodeExcludedByPin: "B", lastSeenAt: FRESH }),
		);
		expect(d.state).toBe("pinned-machine-offline");
		expect(d.message).toContain('"Runs on"');
		expect(d.message).not.toMatch(/open the session again/i);
		expect(d.remedy).toBeNull();
	});
});

describe("the invariant: `pags up` is never prescribed while a machine is connected", () => {
	// Enumerated rather than sampled — this is the whole claim of the ticket, and the shape that
	// produced it was one truthful boolean short of a sentence.
	const NODES = [null, "", "A", "B", "RLs-MacBook-Air"] as const;
	it("holds over every (sessionNode × routedNode × alias) combination", () => {
		for (const sessionNode of NODES) {
			for (const node of ["A", "B"]) {
				for (const sessionMachineLiveAs of [null, "B"]) {
					const d = diagnoseSessionAttachment(
						facts({ relayConnected: true, node, sessionNode, sessionMachineLiveAs, lastSeenAt: FRESH }),
					);
					expect(d.remedy, `remedy for session=${sessionNode} routed=${node}`).toBeNull();
					expect(d.message).not.toContain("pags up");
					// A sentence that names no machine is the #524 defect; every branch here has one.
					expect(d.message).toMatch(/A|B|RLs-MacBook-Air/);
				}
			}
		}
	});

	// `relayConnected` comes from `getBoundRunnerConn`, which live-checks (#532). Without a node
	// name there is nothing to say, and inventing one would be worse than the instance sentence.
	it("a connection with no node name falls back to the instance diagnosis rather than naming nothing", () => {
		const d = diagnoseSessionAttachment(facts({ relayConnected: true, node: null, sessionNode: "A" }));
		expect(d.state).toBe("attached");
	});
});
