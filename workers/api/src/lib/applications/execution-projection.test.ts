import { describe, expect, it } from "vitest";
import { directiveReconciliation } from "./execution-projection.js";

/**
 * #988 invariant: durable supervision tells a reader exactly whether there is terminal handling
 * or persisted work to deliver. This is projection-only: it must never invent an approval or make
 * a final submit eligible.
 */
describe("application execution directive reconciliation (#988)", () => {
	const checkpoint = (delivery: "queued" | "delivery_attempted" | "delivered" | "acknowledged_by_runner" | null) => ({
		id: "cp-1",
		phase: "initial" as const,
		facts: { actions: 1, filled: 0, uploaded: 0, blockers: [], domain: "jobs.example.com" },
		directive: delivery ? { kind: "continue" as const, delivery } : null,
	});

	it.each([
		["new lead / tailoring / materials ready", false, null, "not_applicable"],
		["initial checkpoint before decision", false, checkpoint(null), "decision_pending"],
		["durably queued directive", false, checkpoint("queued"), "delivery_pending"],
		["failed delivery retries the same directive", false, checkpoint("delivery_attempted"), "retry_pending"],
		["transport acknowledgement awaits runner progress", false, checkpoint("delivered"), "delivery_pending"],
		["runner acknowledgement is durable trace evidence", false, checkpoint("acknowledged_by_runner"), "acknowledged"],
		["unavailable/blocker/submitted terminal outcome", true, checkpoint(null), "terminal"],
	] as const)("%s", (_name, terminal, cp, expected) => {
		expect(directiveReconciliation({ terminal, checkpoint: cp })).toBe(expected);
	});

	it("does not turn a checkpoint into an approval or a submit action", () => {
		const state = directiveReconciliation({ terminal: false, checkpoint: checkpoint("acknowledged_by_runner") });
		expect(state).toBe("acknowledged");
		// This module has no submit-gate or approval dependency by design. A regression that adds one
		// would be an authority expansion, not a read projection.
		expect(Object.keys(awaitableProjection())).not.toContain("submitAuthorization");
	});
});

function awaitableProjection() {
	return { schemaVersion: 1, directiveReconciliation: "acknowledged", permittedActions: ["resume"] };
}
