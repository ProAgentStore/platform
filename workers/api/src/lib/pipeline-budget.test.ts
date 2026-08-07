// One delegation pool per pipeline RUN (#382).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUDGET_OPENING_TOOLS, pipelineOpensDelegations } from "./pipeline-budget.js";
import { getRegistryTool } from "./tool-registry.js";

describe("pipelineOpensDelegations", () => {
	it("is false for an ordinary source → transform → sink pipeline", () => {
		// The common case, and the reason the definition decides: opening a pool here would put
		// three D1 operations and a permanent unused row on every tick of a 5-minute sweep.
		expect(pipelineOpensDelegations({ steps: [{ tool: "geocode" }, { tool: "map" }, { tool: "dedupe_upsert" }] })).toBe(false);
	});

	it("is true when a step delegates to another instance", () => {
		expect(pipelineOpensDelegations({ steps: [{ tool: "subordinate_status" }, { tool: "delegate_goal" }] })).toBe(true);
	});

	it("is true when a step hands work to the agent's own executor", () => {
		// `start_work` opens a pool too. From chat that IS the root; from a pipeline step it is the
		// same per-call pool one verb over.
		expect(pipelineOpensDelegations({ steps: [{ tool: "start_work" }] })).toBe(true);
	});

	it("survives a malformed definition rather than throwing mid-kick", () => {
		expect(pipelineOpensDelegations({ steps: [] })).toBe(false);
		expect(pipelineOpensDelegations({ steps: [{ tool: undefined as unknown as string }] })).toBe(false);
	});
});

describe("BUDGET_OPENING_TOOLS", () => {
	it("names only tools that actually exist in the registry", () => {
		for (const name of BUDGET_OPENING_TOOLS) expect(getRegistryTool(name), name).toBeTruthy();
	});

	/**
	 * The guard that keeps the set honest. "Opens a delegation pool" is a property of a handler's
	 * BODY — no registry field states it — so the set cannot be derived. What can be checked is
	 * where `openBudget` is called from: a fourth call site means someone added a way to open a
	 * tree, and they have to come here and decide whether a pipeline step can reach it.
	 *
	 * Getting it wrong is deliberately benign (a missed tool falls back to `openBudget`, which is
	 * exactly today's behaviour), so this fails loudly rather than silently over-blocking.
	 */
	it("has a call site for every place that opens a pool", () => {
		const SRC = resolve(__dirname, "..");
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const p = join(dir, entry);
				if (statSync(p).isDirectory()) walk(p);
				else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) files.push(p);
			}
		};
		walk(SRC);
		// Comment lines are stripped first: `agent-think.ts` explains this exact fallback in prose,
		// and a guard that counted the explanation as a call site would train the reader to ignore it.
		const code = (f: string) =>
			readFileSync(f, "utf8")
				.split("\n")
				.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
				.join("\n");
		const callers = files
			.filter((f) => /\bopenBudget\s*\(/.test(code(f)))
			.map((f) => relative(SRC, f).replace(/\\/g, "/"))
			.sort();
		expect(callers).toEqual([
			// The definition itself.
			"lib/delegation-budget-store.ts",
			// `delegate_goal` → another instance's brain. Inherits when it can (#382).
			"lib/delegate-instance.ts",
			// One pool per pipeline run — this module's whole reason for existing.
			"lib/pipeline-run-start.ts",
			// `start_work` → the agent's own executor. Inherits when it can (#382).
			"lib/tool-registry.ts",
			// `POST /v1/instances/:id/loop` — the human pressing Loop is always a root.
			"routes/tools.ts",
		].sort());
	});
});
