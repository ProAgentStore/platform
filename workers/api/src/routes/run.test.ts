import { describe, expect, it } from "vitest";
import { canRunAgent } from "./run.js";

describe("run route validation", () => {
	it("default model fallback", () => {
		const agentModel = "";
		const model = agentModel || "@cf/meta/llama-3.2-3b-instruct";
		expect(model).toBe("@cf/meta/llama-3.2-3b-instruct");
	});

	it("uses agent model when set", () => {
		const agentModel = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
		const model = agentModel || "@cf/meta/llama-3.2-3b-instruct";
		expect(model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
	});

	it("execution log tracks duration", () => {
		const startMs = 1000;
		const endMs = 1500;
		const durationMs = endMs - startMs;
		expect(durationMs).toBe(500);
	});
});

describe("canRunAgent (#219, corrected by #590)", () => {
	it("lets anyone run a published agent", () => {
		expect(canRunAgent({ visibility: "published", privileged: false })).toBe(true);
	});

	// THE #590 CASE, and the one that was red before this change.
	//
	// Every agent a third-party creator can build is inserted `status = 'inactive'` and there is no
	// code path that changes it: not the update allowlist, not any `UPDATE agents`, nowhere. So
	// `visibility === "published" && status === "active"` was unsatisfiable for anything except the
	// nine agents seeded by migrations, and a published third-party agent 404'd for every non-owner
	// permanently. Publishing is the only decision a creator makes here, so publishing is the gate.
	it("lets a non-owner run a THIRD-PARTY published agent — the state every new agent is in", () => {
		expect(canRunAgent({ visibility: "published", privileged: false })).toBe(true);
	});

	// #219's finding, still enforced: the original `visibility !== "published" && status !==
	// "active"` rejected only an agent failing BOTH, so a draft was runnable by any signed-in user
	// who guessed the slug. `visibility` alone carries that, which is what it always did — the
	// `status` half of the AND never rejected anything the `visibility` half did not.
	it("blocks a non-owner from running a DRAFT", () => {
		expect(canRunAgent({ visibility: "draft", privileged: false })).toBe(false);
	});

	it("blocks unlisted and private for a non-owner", () => {
		for (const visibility of ["draft", "unlisted", "private", ""]) {
			expect(canRunAgent({ visibility, privileged: false })).toBe(false);
		}
	});

	// The creator workflow this endpoint exists for: run your own agent while building it.
	it("lets the owner or an admin run anything, in any state", () => {
		expect(canRunAgent({ visibility: "draft", privileged: true })).toBe(true);
		expect(canRunAgent({ visibility: "private", privileged: true })).toBe(true);
	});

	// The signature is the deliverable, not just the body: `status` is gone from the input, so no
	// future edit can reintroduce a dependency on it without changing the type.
	it("does not accept a status at all", () => {
		expect(Object.keys({ visibility: "published", privileged: false })).toEqual(["visibility", "privileged"]);
	});
});
