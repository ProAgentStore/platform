/**
 * The Runner card says what a pin move or a reattach ACTUALLY did (#932).
 *
 * `PUT …/runner-node` answers `{runnerNode, attachment}` and `POST …/runner-attach` the attachment
 * itself (workers/api/src/routes/instances-runner-attach.ts). The card threw both away and printed
 * "Pinned to X" for every outcome, so a pin that saved but never attached — or whose confirmation
 * timed out — read as a finished move. And the remote takeover (`force_runner_attach`) had no
 * control at all: the only advice was "restart pags up", which the owner cannot do from here.
 */
import { describe, expect, it } from "vitest";
import { canReattach, humanDetail, pinOutcome, reattachOutcome } from "./runnerPanel";

describe("pinOutcome — every attachment shape PUT …/runner-node answers", () => {
	it("moved: attached and confirmed", () => {
		expect(pinOutcome("Macmini", { attachment: { node: "Macmini", attached: true } })).toEqual({ tone: "ok", text: "Moved to Macmini — this agent is attached there now.", offerReattach: false });
	});

	it("attached, release of the old machine unconfirmed (#922): pending, not failure", () => {
		const o = pinOutcome("Macmini", { attachment: { node: "Macmini", attached: true, unconfirmed: true, detail: "Attached on Macmini. …" } });
		expect(o.tone).toBe("pending");
		expect(o.text).toMatch(/^Attached on Macmini/);
	});

	it("not confirmed either way (#887): pending, says it re-checks — never 'Pinned' as if done", () => {
		const o = pinOutcome("Macmini", { attachment: { node: "Macmini", attached: false, unconfirmed: true, detail: "The pin to Macmini is saved; …" } });
		expect(o).toMatchObject({ tone: "pending", offerReattach: false });
		expect(o.text).toMatch(/not confirmed yet/);
	});

	it("saved but did not attach: a warning with the server's cause, and Reattach offered", () => {
		const o = pinOutcome("pink-laptop", {
			attachment: { node: "pink-laptop", attached: false, detail: "The `pags up` on pink-laptop did not attach this agent. Call force_runner_attach to take its slot on pink-laptop over — the remote `pags up --force` for this one agent." },
		});
		expect(o.tone).toBe("warn");
		expect(o.offerReattach).toBe(true);
		expect(o.text).toContain("didn't attach there");
		expect(o.text).toContain("did not attach this agent");
		// The MCP tool name is the agent's vocabulary; on this card the action is a button.
		expect(o.text).not.toContain("force_runner_attach");
		expect(o.text).toContain("Use Reattach");
	});

	it("automatic, and an older API that sent no attachment", () => {
		expect(pinOutcome("", { attachment: null }).text).toMatch(/^Set to automatic/);
		expect(pinOutcome("Macmini", {})).toEqual({ tone: "ok", text: "Pinned to Macmini.", offerReattach: false });
	});
});

describe("reattachOutcome — POST …/runner-attach", () => {
	it("attached, naming any stale connection it cleared", () => {
		expect(reattachOutcome("pink-laptop", { node: "pink-laptop", attached: true, evicted: 2 }).text).toBe("Reattached on pink-laptop (cleared 2 stale connections).");
		expect(reattachOutcome("pink-laptop", { node: "pink-laptop", attached: true, evicted: 0 }).text).toBe("Reattached on pink-laptop.");
	});

	it("unconfirmed is pending, not failure", () => {
		expect(reattachOutcome("pink-laptop", { attached: false, unconfirmed: true }).tone).toBe("pending");
	});

	it("refused: the server's cause, said for this card", () => {
		const o = reattachOutcome("pink-laptop", { attached: false, detail: "Every relay socket `pags up` holds on pink-laptop is connected but not answering (2 tried) — the runner there is frozen or gone, so nothing on that machine can be asked to attach this agent. Restart `pags up` on pink-laptop." });
		expect(o.tone).toBe("warn");
		expect(o.text).toMatch(/^Couldn't attach on pink-laptop\. Every relay socket/);
	});
});

describe("humanDetail", () => {
	it("drops the MCP polling advice and keeps the cause", () => {
		expect(humanDetail("The pin to X is saved; attachment and release of other machines are not yet confirmed. Call instance_runner_node to check current placement.")).toBe(
			"The pin to X is saved; attachment and release of other machines are not yet confirmed.",
		);
		expect(humanDetail(undefined)).toBe("");
	});
});

describe("canReattach — when the card offers the remote takeover", () => {
	it("when the pinned machine is online but this agent is not attached to it", () => {
		expect(canReattach("pink-laptop", "not_attached", null)).toBe(true);
	});

	it("when a move just said it did not attach", () => {
		expect(canReattach("pink-laptop", null, pinOutcome("pink-laptop", { attachment: { attached: false, detail: "x" } }))).toBe(true);
	});

	it("never with no pin, nor while things are fine, nor for an offline machine with nothing to take over", () => {
		expect(canReattach("", "not_attached", null)).toBe(false);
		expect(canReattach("pink-laptop", null, null)).toBe(false);
		expect(canReattach("pink-laptop", "offline", null)).toBe(false);
	});
});
