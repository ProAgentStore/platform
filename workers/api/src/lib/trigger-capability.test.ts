import { describe, expect, it } from "vitest";
import {
	canRunTriggerAction,
	runnerSkipMessage,
	triggerActionDenial,
	triggerActionOffers,
	triggerActionRequirement,
} from "./trigger-capability.js";
import { TRIGGER_ACTIONS } from "./trigger-types.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

const caps = (over: Partial<AgentCapabilities>): AgentCapabilities =>
	({ surfaces: [], runtime: null, workflow: null, boardColumns: [], ...over }) as AgentCapabilities;

describe("triggerActionDenial — the wiring-time gate (#358)", () => {
	it("allows run_browse on an agent that declares the BROWSER_TASK workflow", () => {
		expect(triggerActionDenial("run_browse", caps({ workflow: "BROWSER_TASK", runtime: "browser" }))).toBeNull();
		expect(canRunTriggerAction("run_browse", caps({ workflow: "BROWSER_TASK", runtime: "browser" }))).toBe(true);
	});

	// The reporting account: 1 of 26 instances declares BROWSER_TASK, and the console offered the
	// action on all 26.
	it("refuses run_browse on an agent whose workflow is something else, naming both", () => {
		const msg = triggerActionDenial("run_browse", caps({ workflow: "CODING_SESSION", runtime: "coding" }));
		expect(msg).toContain("BROWSER_TASK");
		expect(msg).toContain("CODING_SESSION");
	});

	it("refuses run_browse on an agent with no workflow at all", () => {
		expect(triggerActionDenial("run_browse", caps({}))).toContain("no workflow at all");
	});

	// The 17 cloud-only instances. `pags up` skips an instance whose runtime is null, so naming it
	// would send the user to a command that prints "None of your agents need a local runner".
	it("tells a cloud-only agent that pags up cannot help", () => {
		const msg = triggerActionDenial("run_browse", caps({ runtime: null })) ?? "";
		expect(msg).toContain("pags up");
		expect(msg).toContain("cannot make this work");
	});

	it("does not mention pags up for an agent that does have a runtime", () => {
		expect(triggerActionDenial("run_browse", caps({ workflow: "CODING_SESSION", runtime: "coding" }))).not.toContain("pags up");
	});

	// Being an instance IS the requirement for these — they dispatch into the instance's own DO.
	it("allows every action that needs no declared capability", () => {
		for (const action of TRIGGER_ACTIONS) {
			if (action === "run_browse") continue;
			expect(triggerActionDenial(action, caps({}))).toBeNull();
			expect(triggerActionRequirement(action)).toBeNull();
		}
	});

	// Same asymmetry as #354: ownership is proven before this runs, so a null is a failed read,
	// not evidence. Refusing on it would make a D1 blip say "your agent cannot do this".
	it("allows when the capabilities could not be read at all", () => {
		expect(triggerActionDenial("run_browse", null)).toBeNull();
		expect(triggerActionDenial("run_browse", undefined)).toBeNull();
	});
});

describe("triggerActionOffers — what the console picker renders", () => {
	it("offers the whole vocabulary, never a subset", () => {
		const offers = triggerActionOffers(caps({}));
		expect(offers.map((o) => o.action).sort()).toEqual([...TRIGGER_ACTIONS].sort());
	});

	it("marks the impossible ones unavailable, with the reason attached", () => {
		const offers = triggerActionOffers(caps({ workflow: "JOB_APPLY", runtime: "browser" }));
		const browse = offers.find((o) => o.action === "run_browse");
		expect(browse?.available).toBe(false);
		expect(browse?.reason).toContain("BROWSER_TASK");
		expect(browse?.requires).toContain("BROWSER_TASK");
		expect(offers.filter((o) => !o.available)).toHaveLength(1);
	});

	it("marks everything available on a browser-task agent", () => {
		expect(triggerActionOffers(caps({ workflow: "BROWSER_TASK", runtime: "browser" })).every((o) => o.available)).toBe(true);
	});

	it("carries a label for every action, so the console needs no list of its own", () => {
		expect(triggerActionOffers(null).every((o) => o.label.length > 0)).toBe(true);
	});
});

describe("runnerSkipMessage — the skip notification (#358, cf. #321/#259)", () => {
	it("names pags up for an agent that genuinely needs a runner", () => {
		const msg = runnerSkipMessage("Nightly watch", caps({ workflow: "BROWSER_TASK", runtime: "browser" }));
		expect(msg).toContain("pags up");
		expect(msg).toContain("Nightly watch");
	});

	it("does not name pags up for a cloud-only agent — there is no machine to fix", () => {
		const msg = runnerSkipMessage("Nightly watch", caps({ runtime: null }));
		expect(msg).not.toContain("pags up");
		expect(msg).toContain("needs no runner");
	});

	// Unknown capabilities keep the old behaviour: the common cause of a 503 IS an offline runner.
	it("falls back to the runner wording when capabilities are unknown", () => {
		expect(runnerSkipMessage("Nightly watch", null)).toContain("pags up");
	});
});
