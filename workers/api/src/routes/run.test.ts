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

describe("canRunAgent (#219)", () => {
	const pub = { visibility: "published", status: "active" };

	it("lets anyone run a published, active agent", () => {
		expect(canRunAgent({ ...pub, privileged: false })).toBe(true);
	});

	// The bug: `visibility !== "published" && status !== "active"` rejects only an agent failing
	// BOTH, so a draft that is active — every agent under construction — was runnable by any
	// signed-in user who guessed the slug.
	it("blocks a non-owner from running an ACTIVE DRAFT", () => {
		expect(canRunAgent({ visibility: "draft", status: "active", privileged: false })).toBe(false);
	});

	it("blocks a non-owner from running a PUBLISHED INACTIVE agent", () => {
		expect(canRunAgent({ visibility: "published", status: "inactive", privileged: false })).toBe(false);
	});

	it("blocks unlisted/private regardless of status", () => {
		for (const visibility of ["draft", "unlisted", "private"]) {
			for (const status of ["active", "inactive"]) {
				expect(canRunAgent({ visibility, status, privileged: false })).toBe(false);
			}
		}
	});

	// The creator workflow this endpoint exists for: run your own agent while building it.
	it("lets the owner or an admin run anything, in any state", () => {
		expect(canRunAgent({ visibility: "draft", status: "inactive", privileged: true })).toBe(true);
		expect(canRunAgent({ visibility: "private", status: "active", privileged: true })).toBe(true);
	});
});
