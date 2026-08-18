import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_WORKFLOWS, isAgentWorkflow, workflowChoices, workflowRequiredRuntime, workflowRuntimeDenial } from "./agent-workflows.js";
import { KNOWN_RUNTIMES } from "./agent-capabilities.js";
import { triggerActionRequirement } from "./trigger-capability.js";

const VALUES = AGENT_WORKFLOWS.map((w) => w.value);

describe("the workflow catalog is the platform's real vocabulary (#375)", () => {
	it("declares only workflows that are actually BOUND in wrangler.toml", () => {
		// The failure this catches, exactly: `INSURANCE_QUOTES` sat in the type union, the
		// sanitizer, the MCP enum and the console picker with no `[[workflows]]` block, no `Env`
		// field and no `.create()` call anywhere. A creator who picked it changed a lint and no
		// behaviour. Read from the deploy config rather than from `types.ts`, because the binding
		// is what makes the value mean anything at runtime.
		const toml = readFileSync(join(__dirname, "../../wrangler.toml"), "utf8");
		// Only the `[[workflows]]` blocks — a KV or DO binding that happened to share a name would
		// make this pass for the wrong reason.
		const bound = new Set(
			[...toml.matchAll(/\[\[workflows\]\]([\s\S]*?)(?=\n\s*\[|$)/g)].flatMap((block) => {
				const binding = /^\s*binding\s*=\s*"([A-Z_]+)"/m.exec(block[1]);
				return binding ? [binding[1]] : [];
			}),
		);
		expect(bound.size, "no [[workflows]] bindings parsed — did wrangler.toml move?").toBeGreaterThan(0);
		for (const value of VALUES) {
			expect(bound.has(value), `capabilities.workflow "${value}" has no binding in wrangler.toml`).toBe(true);
		}
	});

	it("offers BROWSER_TASK — the one value the platform ENFORCES", () => {
		// `trigger-capability.ts` refuses `run_browse` for any agent that does not declare it, and
		// the console's hand-written picker was the only authoring door that omitted it: a creator
		// building a portal-watch equivalent had to go through MCP `update_agent` instead.
		expect(VALUES).toContain("BROWSER_TASK");
		expect(triggerActionRequirement("run_browse")).toContain("BROWSER_TASK");
	});

	it("does not offer a workflow the platform is not going to run", () => {
		expect(VALUES).not.toContain("INSURANCE_QUOTES");
		expect(isAgentWorkflow("INSURANCE_QUOTES")).toBe(false);
		expect(isAgentWorkflow("JOB_APPLY")).toBe(true);
		for (const junk of [null, undefined, "", 7, {}, "job_apply"]) expect(isAgentWorkflow(junk), String(junk)).toBe(false);
	});

	it("leaves out the workflows a creator does not select", () => {
		// PIPELINE_RUN and AGENT_LOOP are bound and real, but the pipeline runner and the generic
		// loop start them whatever an agent declares — offering them would be a control that
		// changes nothing, which is the shape of the bug this table exists to end.
		expect(VALUES).not.toContain("PIPELINE_RUN");
		expect(VALUES).not.toContain("AGENT_LOOP");
	});

	it("gives every entry a description, because the picker shows it", () => {
		for (const w of AGENT_WORKFLOWS) expect(w.description.length, w.value).toBeGreaterThan(20);
	});
});

describe("the MCP enum mirrors the catalog", () => {
	it("lists exactly the declarable workflows", () => {
		// `update_agent` is the OTHER authoring door (#375: "two authoring doors, two
		// vocabularies"). It lives in another package that builds standalone, so it cannot import
		// the catalog — reading the source keeps the mirror honest without a cross-package import,
		// the same technique `store/console/src/lib/surfaces.test.ts` uses for RESERVED_SURFACE_IDS.
		const src = readFileSync(join(__dirname, "../../../mcp/src/index.ts"), "utf8");
		const block = /workflow:\s*z\.enum\(\[([^\]]*)\]\)/.exec(src);
		expect(block, "the update_agent workflow enum was not found — renamed or moved?").toBeTruthy();
		const listed = [...(block?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
		expect(listed).toEqual(VALUES);
	});
});

describe("workflowChoices — what the creator's picker renders", () => {
	it("leads with 'none' and then every declarable workflow", () => {
		const rows = workflowChoices(null);
		expect(rows[0].value).toBe("");
		expect(rows.slice(1).map((r) => r.value)).toEqual(VALUES);
		expect(rows.every((r) => r.unavailable === undefined)).toBe(true);
	});

	it("keeps a stored value the platform no longer runs, FLAGGED rather than dropped", () => {
		// A <select> whose value matches no option renders as its first option, so omitting the row
		// would show "none" over a config that still says INSURANCE_QUOTES and clear it on the next
		// Save without anyone choosing that.
		const rows = workflowChoices("INSURANCE_QUOTES");
		const stale = rows.find((r) => r.value === "INSURANCE_QUOTES");
		expect(stale?.unavailable).toBe(true);
		expect(stale?.label).toContain("not available");
		// …and it is an extra row, never a replacement for a real one.
		expect(rows.filter((r) => !r.unavailable).map((r) => r.value)).toEqual(["", ...VALUES]);
	});

	it("adds nothing for a current value that IS declarable, or for none at all", () => {
		expect(workflowChoices("BROWSER_TASK")).toEqual(workflowChoices());
		expect(workflowChoices("")).toEqual(workflowChoices());
		expect(workflowChoices(42)).toEqual(workflowChoices());
	});
});

describe("every workflow states whether it needs hands (#705)", () => {
	it("declares requiresRuntime on every entry, drawn from the runtime vocabulary", () => {
		// The `StyleBranch.lengthDefault` guard, applied here: the field is REQUIRED on the
		// interface, so a fourth workflow cannot be added without stating whether it needs a
		// physical executor. This asserts the runtime half too — the vocabulary is stated in
		// `agent-workflows.ts` to keep that module a leaf of the import graph, and this is what
		// stops the two copies drifting the way #375's four copies of the workflow enum did.
		const vocabulary = new Set<unknown>([...KNOWN_RUNTIMES, null]);
		for (const w of AGENT_WORKFLOWS) {
			expect(Object.hasOwn(w, "requiresRuntime"), `${w.value} declares no requiresRuntime`).toBe(true);
			expect(vocabulary.has(w.requiresRuntime), `${w.value} requires "${w.requiresRuntime}", which is not a runtime`).toBe(true);
		}
	});

	it("matches what each workflow's implementation actually reaches for", () => {
		// Grounded in the code, not in the table's own say-so — the same argument as the
		// wrangler.toml check above. A workflow whose implementation calls the runner needs a
		// runtime by construction; declaring `requiresRuntime: null` for it would restore exactly
		// the accepted-and-unrunnable combination this table now refuses.
		for (const w of AGENT_WORKFLOWS) {
			const file = join(__dirname, "../workflows", `${w.value.toLowerCase().replaceAll("_", "-")}.ts`);
			const src = readFileSync(file, "utf8");
			const usesRunner = /\bcallRunner\b|\bcallRuntime\b|\brequireLiveRuntime\b/.test(src);
			expect(usesRunner, `${w.value}: implementation ${usesRunner ? "does" : "does not"} drive a runner`).toBe(w.requiresRuntime !== null);
		}
	});

	it("reads only one way — a runtime without a workflow is legitimate", () => {
		// `runtime: "coding"` with `workflow: null` is what the tmux Operator, `tmux-coder` and
		// `single-pane-operator` all declare: they drive a CLI through registry tools with no
		// Pilot. Inferring a workflow's runtime in that direction would refuse three live agents.
		expect(workflowRuntimeDenial(null, "coding")).toBeNull();
		expect(workflowRuntimeDenial(null, "browser")).toBeNull();
		expect(workflowRuntimeDenial(null, null)).toBeNull();
	});

	it("refuses every workflow that needs hands when the runtime cannot supply them", () => {
		for (const w of AGENT_WORKFLOWS) {
			if (w.requiresRuntime === null) continue;
			const denial = workflowRuntimeDenial(w.value, null);
			expect(denial, `${w.value} with runtime null`).toBeTruthy();
			// The message has to be actionable on its own: which field, which value, what to set.
			expect(denial).toContain("capabilities.workflow");
			expect(denial).toContain(w.value);
			expect(denial).toContain("capabilities.runtime");
			expect(denial).toContain(w.requiresRuntime);
			// …and the wrong non-null runtime is refused too, not just the absent one.
			const other = w.requiresRuntime === "browser" ? "coding" : "browser";
			expect(workflowRuntimeDenial(w.value, other), `${w.value} with runtime ${other}`).toBeTruthy();
			// The matched pair is the whole point of the field.
			expect(workflowRuntimeDenial(w.value, w.requiresRuntime)).toBeNull();
		}
	});

	it("says nothing about a value this platform does not run", () => {
		// The sanitizer drops an unknown workflow to null anyway; denying the write instead would
		// mean a creator could never clear a stale `INSURANCE_QUOTES` by saving.
		expect(workflowRuntimeDenial("INSURANCE_QUOTES", null)).toBeNull();
		expect(workflowRuntimeDenial("PIPELINE_RUN", null)).toBeNull();
		expect(workflowRequiredRuntime("INSURANCE_QUOTES")).toBeNull();
		for (const junk of [undefined, "", 7, {}, "job_apply"]) expect(workflowRuntimeDenial(junk, null), String(junk)).toBeNull();
	});
});
