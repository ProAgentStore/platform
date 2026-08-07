import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type WorkflowChoice, workflowPickerRows } from "./workflow-picker";

const served: WorkflowChoice[] = [
	{ value: "", label: "none", description: "No autonomous brain." },
	{ value: "JOB_APPLY", label: "JOB_APPLY", description: "…" },
	{ value: "BROWSER_TASK", label: "BROWSER_TASK", description: "…" },
];

describe("workflowPickerRows — the vocabulary comes from the server (#375)", () => {
	it("renders exactly what was served when it covers the stored value", () => {
		expect(workflowPickerRows(served, "BROWSER_TASK")).toEqual(served);
		expect(workflowPickerRows(served, "")).toEqual(served);
	});

	it("never drops the stored value, so a Save cannot silently clear it", () => {
		// A <select> whose value matches no option renders as its first option — here "none" — so a
		// creator who opened Settings and pressed Save would wipe a workflow they never touched.
		const rows = workflowPickerRows(served, "CODING_SESSION");
		expect(rows.map((r) => r.value)).toEqual(["", "JOB_APPLY", "BROWSER_TASK", "CODING_SESSION"]);
	});

	it("degrades to showing what you have when no vocabulary arrived", () => {
		// The fetch failed, or this console is deployed ahead of the API. Showing the stored value
		// unlabelled is honest; inventing option names is what this ticket is about.
		expect(workflowPickerRows(undefined, "CODING_SESSION")).toEqual([
			{ value: "CODING_SESSION", label: "CODING_SESSION", description: "" },
		]);
		expect(workflowPickerRows(null, "")).toEqual([{ value: "", label: "none", description: "" }]);
		expect(workflowPickerRows([], "")).toEqual([{ value: "", label: "none", description: "" }]);
	});

	it("invents no workflow of its own — every row is served or stored", () => {
		const rows = workflowPickerRows(served, "JOB_APPLY");
		expect(rows.map((r) => r.value)).toEqual(served.map((r) => r.value));
	});
});

describe("the hardcoded option list does not come back", () => {
	it("AgentDetail names no workflow binding in its picker", () => {
		// The bug was a second, hand-kept vocabulary in JSX: it offered INSURANCE_QUOTES (bound to
		// nothing) and omitted BROWSER_TASK (the only value the platform enforces). A future edit
		// that re-adds `<option value="JOB_APPLY">` restores exactly that drift while every other
		// test still passes, so the guard is on the SOURCE. Comments are stripped first — the ones
		// explaining this fix necessarily name the workflows.
		const src = readFileSync(join(__dirname, "../pages/AgentDetail.tsx"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.split("\n")
			.map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
			.join("\n");
		expect(src).toContain("workflowPickerRows");
		for (const value of ["JOB_APPLY", "INSURANCE_QUOTES", "BROWSER_TASK"]) {
			expect(src, `${value} is hardcoded in the console again`).not.toContain(`"${value}"`);
		}
	});
});
