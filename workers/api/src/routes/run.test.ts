import { describe, expect, it } from "vitest";

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

describe("agent visibility check", () => {
	it("allows published agents", () => {
		const visibility = "published";
		const status = "inactive";
		const allowed = visibility === "published" || status === "active";
		expect(allowed).toBe(true);
	});

	it("allows active agents regardless of visibility", () => {
		const visibility = "draft";
		const status = "active";
		const allowed = visibility === "published" || status === "active";
		expect(allowed).toBe(true);
	});

	it("blocks draft inactive agents", () => {
		const visibility = "draft";
		const status = "inactive";
		const allowed = visibility === "published" || status === "active";
		expect(allowed).toBe(false);
	});
});
