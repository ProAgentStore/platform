import { describe, expect, it } from "vitest";
import { actDigest as runnerDigest } from "../../../../packages/browser-runner/src/coding/input-ledger.js";
import { actDigest, reconcileAct } from "./coding-act-send.js";
import type { CodingActionKind, CodingPaneSnapshot } from "./coding-loop.js";

type MessageAct = Extract<CodingActionKind, { kind: "message" }>;
const act = (text: string, objective?: string): MessageAct => ({
	kind: "message",
	text,
	author: "pilot",
	inputId: "act:r:s1-act",
	...(objective ? { objective: { runId: "r", text: objective, origin: { kind: "supervisor" as const, by: "agent lead-1" }, constraints: ["- read-only (owner directive 1)"] } } : {}),
});
const pane = (over: Partial<CodingPaneSnapshot>): CodingPaneSnapshot => ({ pane: "", runState: "idle", ready: true, alive: true, ...over });
const sentTo = (digest: string, objective: boolean, ledger: string | null = "L1", node: string | null = "A") => ({ digest, objective, ledger, node });

describe("an act's content identity (#1019)", () => {
	it("the cloud and the runner hash the same act to the same digest — and a changed objective to a different one", async () => {
		for (const a of [act("go"), act("go", "FIRST ✓ 漢字"), act("go", "€".repeat(20_000))]) expect(await actDigest(a)).toBe(runnerDigest(a));
		expect(await actDigest(act("go", "FIRST"))).not.toBe(await actDigest(act("go", "CHANGED")));
		// Delivery metadata is not content: the same act under another id, or with a replay, is the same content.
		expect(await actDigest({ ...act("go"), inputId: "other" })).toBe(await actDigest(act("go")));
	});
});

describe("reconcileAct — what a runner's ledger may and may not say about a lost act (#1019)", () => {
	const id = "act:r:s1-act";
	it("accepted by this engine process with the content this send dispatched → accepted, and whether it carried the objective", async () => {
		const d = await actDigest(act("go", "OBJ"));
		const seen = pane({ engine: { ledger: "L1", epoch: 1, accepted: [[id, d, 1]], consumed: [] } });
		expect(reconcileAct(seen, id, [sentTo(d, true)], "A")).toEqual({ outcome: "accepted", objective: true, ledger: "L1", epoch: 1 });
	});

	it("accepted by an EARLIER process of the same session → predecessor: not re-run, not credited to the replacement", async () => {
		const d = await actDigest(act("go", "OBJ"));
		const seen = pane({ engine: { ledger: "L1", epoch: 2, accepted: [[id, d, 1]], consumed: [[id, 1]] } });
		expect(reconcileAct(seen, id, [sentTo(d, true)], "A")).toMatchObject({ outcome: "predecessor", epoch: 1 });
	});

	it("accepted with content none of this send's compositions had → conflict, never attributed", async () => {
		const seen = pane({ engine: { ledger: "L1", epoch: 1, accepted: [[id, await actDigest(act("go", "CHANGED")), 1]], consumed: [] } });
		expect(reconcileAct(seen, id, [sentTo(await actDigest(act("go", "FIRST")), true)], "A")).toMatchObject({ outcome: "conflict" });
	});

	it("an empty ledger proves absence only for the ledger and machine every attempt went to", async () => {
		const d = await actDigest(act("go"));
		const empty = (ledger: string) => pane({ acceptedInputs: [], engine: { ledger, epoch: 1, accepted: [], consumed: [] } });
		expect(reconcileAct(empty("L1"), id, [sentTo(d, false)], "A")).toBe("absent");
		expect(reconcileAct(empty("L2"), id, [sentTo(d, false)], "B")).toMatchObject({ outcome: "unknown" }); // a different runner
		expect(reconcileAct(empty("L2"), id, [sentTo(d, false)], "A")).toMatchObject({ outcome: "unknown" }); // same machine, session re-created
		expect(reconcileAct(empty("L1"), id, [sentTo(d, false, null)], "A")).toMatchObject({ outcome: "unknown" }); // dispatched before any ledger was seen
		expect(reconcileAct(empty("L1"), id, [sentTo(d, false), sentTo(d, false, "L0", "Z")], "A")).toMatchObject({ outcome: "unknown" }); // an earlier attempt went elsewhere
	});

	it("a runner without a ledger identity: its receipt is believed, its silence proves nothing", () => {
		expect(reconcileAct(pane({ acceptedInputs: [id] }), id, [sentTo("d", false)], "A")).toMatchObject({ outcome: "accepted" });
		expect(reconcileAct(pane({ acceptedInputs: [] }), id, [sentTo("d", true)], "A")).toEqual({ outcome: "unknown", objective: true, ledger: null, epoch: null });
	});
});
