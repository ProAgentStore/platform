import { describe, expect, it } from "vitest";
import { lintAgentClaims } from "./agent-claims-lint.js";

describe("lintAgentClaims (#66 — catalog description-vs-capability integrity)", () => {
	const noRuntime = { runtime: null, workflow: null };

	it("flags a deliberately-mismatched fixture (Creator OS shape)", () => {
		const v = lintAgentClaims({
			description: "Personal AI content agent: publishing through your own logged-in browser sessions via the local runner.",
			capabilities: noRuntime,
		});
		expect(v.length).toBeGreaterThan(0);
		expect(v.join(" ")).toMatch(/browser|runner|publishing/i);
	});

	it("flags a 'runs headlessly after every deploy' claim with no runtime", () => {
		expect(lintAgentClaims({ description: "Runs them headlessly after every deploy via an observable runner.", capabilities: noRuntime })).not.toHaveLength(0);
	});

	it("does NOT flag when the agent actually declares a runtime", () => {
		expect(lintAgentClaims({ description: "Runs a coding CLI on your machine via the local runner.", capabilities: { runtime: "coding", workflow: "CODING_SESSION" } })).toHaveLength(0);
	});

	it("does NOT flag a description that makes no runtime claim", () => {
		expect(lintAgentClaims({ description: "Chat with your document library; answers cite the source document.", capabilities: noRuntime })).toHaveLength(0);
	});

	it("is quiet on empty/missing input", () => {
		expect(lintAgentClaims({ description: "", capabilities: noRuntime })).toHaveLength(0);
		expect(lintAgentClaims({ description: "Browser agent", capabilities: null })).not.toHaveLength(0); // claim + no caps → flag
	});
});
