import { describe, expect, it } from "vitest";
import { agentCapabilities, hasSurface } from "./agent-capabilities.js";

describe("agentCapabilities", () => {
	it("uses declared config.capabilities when present", () => {
		const cfg = JSON.stringify({ capabilities: { surfaces: ["coding"], runtime: "coding", workflow: "CODING_SESSION" } });
		const caps = agentCapabilities({ slug: "anything", category: "x", config: cfg });
		expect(caps.surfaces).toEqual(["coding"]);
		expect(caps.runtime).toBe("coding");
		expect(caps.workflow).toBe("CODING_SESSION");
	});

	it("declared capabilities override the slug fallback", () => {
		// A 'coder'-slug agent that declares apply still resolves to apply.
		const cfg = JSON.stringify({ capabilities: { surfaces: ["apply"], runtime: "browser", workflow: "JOB_APPLY" } });
		expect(agentCapabilities({ slug: "coder", config: cfg }).surfaces).toEqual(["apply"]);
	});

	it("filters unknown surfaces out of declared config", () => {
		const cfg = JSON.stringify({ capabilities: { surfaces: ["coding", "bogus"] } });
		expect(agentCapabilities({ config: cfg }).surfaces).toEqual(["coding"]);
	});

	it("falls back to apply for the job-application agent", () => {
		const caps = agentCapabilities({ slug: "job-application-assistant" });
		expect(caps.surfaces).toEqual(["apply"]);
		expect(caps.workflow).toBe("JOB_APPLY");
	});

	it("falls back to coding for the coder slug or code category", () => {
		expect(agentCapabilities({ slug: "coder" }).surfaces).toEqual(["coding"]);
		expect(agentCapabilities({ category: "code" }).surfaces).toEqual(["coding"]);
	});

	it("is empty for a generic agent (no apply/coding UI leaks)", () => {
		const caps = agentCapabilities({ slug: "site-monitor", category: "productivity" });
		expect(caps.surfaces).toEqual([]);
		expect(caps.runtime).toBeNull();
	});

	it("tolerates malformed config", () => {
		expect(agentCapabilities({ slug: "coder", config: "{not json" }).surfaces).toEqual(["coding"]);
	});

	it("hasSurface reflects the resolved surfaces", () => {
		expect(hasSurface({ slug: "coder" }, "coding")).toBe(true);
		expect(hasSurface({ slug: "coder" }, "apply")).toBe(false);
	});

	describe("boardColumns", () => {
		const titles = (a: Parameters<typeof agentCapabilities>[0]) => agentCapabilities(a).boardColumns.map((c) => c.title);

		it("gives apply agents the hiring-pipeline columns", () => {
			const t = titles({ slug: "job-application-assistant" });
			expect(t).toContain("Applying");
			expect(t).toContain("Submitted");
			// Human-driven pipeline stages the automation never sets.
			expect(t).toEqual(expect.arrayContaining(["Interview", "Offer", "Rejected"]));
		});

		it("gives other agents the generic runtime columns (no pipeline stages)", () => {
			const t = titles({ slug: "coder" });
			expect(t).toContain("Running");
			expect(t).toContain("Done");
			expect(t).not.toContain("Interview");
		});

		it("honors declared board columns over the default", () => {
			const cfg = JSON.stringify({ capabilities: { surfaces: ["apply"], boardColumns: [{ id: "todo", title: "To do", color: "#fff", statuses: ["queued"] }] } });
			expect(titles({ config: cfg })).toEqual(["To do"]);
		});

		it("always resolves a non-empty board, even for a generic agent", () => {
			expect(agentCapabilities({ slug: "whatever" }).boardColumns.length).toBeGreaterThan(0);
		});
	});
});
