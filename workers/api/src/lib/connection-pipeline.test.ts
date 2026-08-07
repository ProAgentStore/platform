import { describe, expect, it } from "vitest";
import { connectionPipelineWarning } from "./connection-pipeline.js";

const inv = (valid: string[], invalid: string[] = []) => ({ valid, invalid });

describe("connectionPipelineWarning (#363)", () => {
	it("says nothing when the named pipeline is there", () => {
		expect(connectionPipelineWarning("site-builder", '"Website Builder"', inv(["site-builder", "site-deploy"]))).toBeNull();
	});

	it("names the pipeline AND the agent it was looked for on", () => {
		const w = connectionPipelineWarning("site-buidler", '"Website Builder"', inv(["site-builder"]));
		expect(w).toContain('"site-buidler"');
		expect(w).toContain('"Website Builder"');
		// The near-miss is the whole point of listing what the target does have.
		expect(w).toContain('"site-builder"');
	});

	it("says so plainly when the target has no pipelines at all", () => {
		expect(connectionPipelineWarning("site-deploy", '"Lead Outreach"', inv([]))).toContain("no pipelines at all");
	});

	it("distinguishes a name that is PRESENT but does not validate", () => {
		const w = connectionPipelineWarning("site-deploy", '"Website Builder"', inv([], ["site-deploy"]));
		expect(w).toContain("not valid");
		// A broken definition is fixed on the target, not by renaming the edge — so it must not
		// read like a typo, which is the other sentence.
		expect(w).not.toContain("correct the name");
	});

	it("a null inventory ALLOWS — a failed read is not evidence of absence (#354)", () => {
		expect(connectionPipelineWarning("site-deploy", '"Website Builder"', null)).toBeNull();
		expect(connectionPipelineWarning("site-deploy", '"Website Builder"', undefined)).toBeNull();
	});

	it("says nothing when no pipeline is named — the event payload may still supply one", () => {
		expect(connectionPipelineWarning("", '"Website Builder"', inv([]))).toBeNull();
		expect(connectionPipelineWarning(null, '"Website Builder"', inv([]))).toBeNull();
		expect(connectionPipelineWarning("   ", '"Website Builder"', inv([]))).toBeNull();
	});

	it("falls back to a readable phrase when the target has no label", () => {
		expect(connectionPipelineWarning("x", "", inv([]))).toContain("the target agent");
	});

	it("trims a long pipeline list instead of printing the lot", () => {
		const many = Array.from({ length: 12 }, (_, i) => `p${i}`);
		const w = connectionPipelineWarning("nope", '"Big"', inv(many)) ?? "";
		expect(w).toContain("+4 more");
	});
});
