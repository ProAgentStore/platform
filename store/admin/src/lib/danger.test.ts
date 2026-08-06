import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	blockedCount,
	canConfirm,
	confirmAction,
	type DangerEvent,
	type DangerState,
	dangerReducer,
	failureEvent,
	initialDangerState,
	runArgs,
} from "./danger";

/** Replay a sequence of events, the way the component does. */
function run(events: DangerEvent[], from: DangerState = initialDangerState): DangerState {
	return events.reduce(dangerReducer, from);
}

describe("two-step open→confirm — nothing destructive fires on one click", () => {
	it("starts closed, so the first click can only open the control", () => {
		// The failure this prevents: a mis-click, or a click on the wrong row, deletes an
		// agent. Opening is a separate act from confirming, by construction.
		expect(initialDangerState.open).toBe(false);
		expect(run([{ type: "open" }]).open).toBe(true);
	});

	it("cancel discards everything the operator entered", () => {
		// Including the 409. A reopened control must re-earn the right to force: leaving
		// `blocked` set would leave a Force button armed for the NEXT thing the operator
		// opens, which may not be the thing the count was about.
		const s = run([
			{ type: "open" },
			{ type: "typed", value: "my-agent" },
			{ type: "reason", value: "abuse" },
			{ type: "blocked", message: "3 active instances" },
			{ type: "cancel" },
		]);
		expect(s).toMatchObject({ open: false, typed: "", reason: "", blocked: "", error: "" });
	});

	it("opening clears a previous success line", () => {
		// A stale "Suspended." sitting next to a freshly opened panel reads as though this
		// attempt already landed — and an operator who believes it landed does not confirm.
		const s = run([{ type: "succeeded", message: "Suspended." }, { type: "open" }]);
		expect(s.ok).toBe("");
	});

	it("a success closes and clears the panel but keeps what happened visible", () => {
		const s = run([{ type: "open" }, { type: "typed", value: "x" }, { type: "submit" }, { type: "succeeded", message: "Deleted (2 instance(s) canceled)." }]);
		expect(s).toMatchObject({ open: false, typed: "", busy: false, ok: "Deleted (2 instance(s) canceled)." });
	});
});

describe("the echo gate", () => {
	it("refuses an empty echo", () => {
		// The whole gate. An operator who has typed nothing has confirmed nothing.
		expect(canConfirm(run([{ type: "open" }]), "my-agent")).toBe(false);
	});

	it("refuses a mismatched echo", () => {
		expect(canConfirm(run([{ type: "open" }, { type: "typed", value: "my-agen" }]), "my-agent")).toBe(false);
		expect(canConfirm(run([{ type: "open" }, { type: "typed", value: "my-agentt" }]), "my-agent")).toBe(false);
	});

	it("refuses a near-miss that a sloppy comparison would accept", () => {
		// A control that accepts "My-Agent " for "my-agent" is not an echo gate, it is a
		// speed bump: the operator never has to read what they are about to destroy.
		expect(canConfirm(run([{ type: "open" }, { type: "typed", value: "my-agent " }]), "my-agent")).toBe(false);
		expect(canConfirm(run([{ type: "open" }, { type: "typed", value: " my-agent" }]), "my-agent")).toBe(false);
		expect(canConfirm(run([{ type: "open" }, { type: "typed", value: "My-Agent" }]), "my-agent")).toBe(false);
	});

	it("arms only on an exact match", () => {
		expect(canConfirm(run([{ type: "open" }, { type: "typed", value: "my-agent" }]), "my-agent")).toBe(true);
	});

	it("stays closed while a request is already in flight", () => {
		// Double-firing an irreversible action is the same accident twice.
		const s = run([{ type: "open" }, { type: "typed", value: "my-agent" }, { type: "submit" }]);
		expect(s.busy).toBe(true);
		expect(canConfirm(s, "my-agent")).toBe(false);
	});

	it("actions with no phrase are still two-step, just not echoed", () => {
		// Unpublish and unsuspend are reversible; they get the open→confirm step without a
		// phrase. `canConfirm` must not accidentally require one.
		expect(canConfirm(run([{ type: "open" }]), undefined)).toBe(true);
	});
});

describe("force is never sent on the first attempt", () => {
	it("omits force before the API has refused", () => {
		// The property in its strongest form: `force` is DERIVED from the recorded 409, so
		// there is no state in which a first attempt carries it. It is not "something the
		// caller remembers not to pass".
		const s = run([{ type: "open" }, { type: "typed", value: "my-agent" }]);
		expect(runArgs(s).force).toBeUndefined();
		expect(confirmAction(s)).toBe("confirm");
	});

	it("offers forcing only after a 409 has been recorded, and shows the count", () => {
		// A 409 is information, not a failure: it is the platform saying how many live
		// subscribers this would strand. The operator reads the number, then chooses a
		// second, distinctly-labelled action.
		const blocked = failureEvent(409, "Agent has 3 active instances", true);
		expect(blocked.type).toBe("blocked");
		const s = run([{ type: "open" }, { type: "typed", value: "my-agent" }, { type: "submit" }, blocked]);
		expect(s.blocked).toContain("3 active instance");
		expect(blockedCount(s.blocked)).toBe(3);
		expect(confirmAction(s)).toBe("force");
		expect(runArgs(s).force).toBe(true);
	});

	it("a 409 on a non-forceable action is a plain failure, not a hidden escalation", () => {
		// There is nothing to escalate to. Treating it as `blocked` would render a Force
		// button for an action that has no forcing path.
		expect(failureEvent(409, "conflict", false).type).toBe("failed");
	});

	it("any other error stays an error and unlocks nothing", () => {
		for (const status of [400, 401, 403, 404, 500, null]) {
			const e = failureEvent(status, "boom", true);
			expect(e.type, String(status)).toBe("failed");
		}
		const s = run([{ type: "open" }, { type: "submit" }, failureEvent(500, "boom", true)]);
		expect(s.error).toBe("boom");
		expect(runArgs(s).force).toBeUndefined();
		expect(confirmAction(s)).toBe("confirm");
	});

	it("submitting again clears the stale error but not the 409 that armed forcing", () => {
		const s = run([
			{ type: "open" },
			{ type: "submit" },
			failureEvent(409, "Agent has 2 active instances", true),
			{ type: "submit" },
		]);
		expect(s.error).toBe("");
		expect(s.blocked).toContain("2 active instance");
		expect(s.busy).toBe(true);
	});
});

describe("runArgs — what actually reaches the request builder", () => {
	it("hands over the typed echo, not the phrase the component already knew", () => {
		// The failure this prevents is subtle and total: if the request carries the
		// CORRECT slug read back from props, then a regressed UI gate still produces a
		// perfectly valid delete and the server's own echo check can never catch it.
		const s = run([{ type: "open" }, { type: "typed", value: "my-agent" }]);
		expect(runArgs(s).confirmed).toBe("my-agent");
	});

	it("drops a whitespace-only reason instead of storing a blank audit note", () => {
		expect(runArgs(run([{ type: "open" }, { type: "reason", value: "   " }])).reason).toBeUndefined();
		expect(runArgs(run([{ type: "open" }, { type: "reason", value: " abuse " }])).reason).toBe("abuse");
	});
});

describe("blockedCount", () => {
	it("pulls the count out of the API's message so the number leads the copy", () => {
		expect(blockedCount("Agent has 12 active instances; pass force to cancel them")).toBe(12);
		expect(blockedCount("Agent has 1 active instance")).toBe(1);
	});

	it("returns null rather than a confident zero when there is no count", () => {
		// A "0 live subscribers will be cancelled" line under a 409 is worse than showing
		// the raw message: it tells the operator the forcing is free.
		expect(blockedCount("conflict")).toBeNull();
		expect(blockedCount("")).toBeNull();
	});
});

/** Strip comments before matching — see store/console/src/lib/surfaces.test.ts. */
function codeOf(relPath: string): string {
	return readFileSync(join(__dirname, relPath), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
		.join("\n");
}

describe("DangerAction stays a renderer (#282 option b)", () => {
	it("drives the reducer instead of holding the guards in its own state", () => {
		// Extraction only buys anything while it is consumed. A future edit that puts
		// `useState` for `blocked`/`typed` back in the component moves the destructive
		// guards somewhere no test in this repo can reach — which is the situation #282
		// was filed about.
		const src = codeOf("./moderation.tsx");
		expect(src).toContain("dangerReducer");
		expect(src).toContain("canConfirm");
		expect(src).toContain("runArgs");
		expect(src).toContain("failureEvent");
		// The component must never decide to force by itself.
		expect(src).not.toMatch(/go\(true\)/);
		expect(src).not.toMatch(/force:\s*true/);
	});
});
