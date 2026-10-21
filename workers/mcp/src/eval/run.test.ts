/**
 * The on-demand eval entry (#1244). Skipped unless `EVAL_RUN=1`: `scripts/mcp-agent-eval.mjs` sets it, with `EVAL_DRIVER`
 * (`scripted` | `live`) and `EVAL_OUT` (where to write the JSON). It lives in a test file because the server's base class only loads
 * under the module mocks below, the same ones `argument-normalize.test.ts` uses.
 *
 * Self-contained on purpose: it imports only the harness and tasks, never anything newer than `PagsMcp`, so the same file can be
 * copied into an older checkout and run there to capture a before-score (docs/mcp-tool-audit.md §9).
 */
import { writeFileSync } from "node:fs";
import { describe, it, vi } from "vitest";

vi.mock("@cloudflare/workers-oauth-provider", () => ({ OAuthProvider: class {} }));
vi.mock("agents/mcp", () => ({
	McpAgent: class {
		env: unknown;
		props: unknown;
		static serve() {
			return { fetch: () => new Response("mock") };
		}
	},
}));

const realFetch = globalThis.fetch;
const { PagsMcp } = await import("../index.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
import { anthropicDriver, ScriptedDriver } from "./driver.js";
import { runCorpus, runLive } from "./harness.js";
import { TASKS } from "./tasks.js";

describe.skipIf(!process.env.EVAL_RUN)("mcp agent eval (on demand)", () => {
	it("runs the corpus or a live model and writes the result", { timeout: 20 * 60_000 }, async () => {
		const host = { PagsMcp, Client, InMemoryTransport };
		const driver = process.env.EVAL_DRIVER ?? "scripted";
		const out = process.env.EVAL_OUT;
		const body =
			driver === "live"
				? await (async () => {
						const apiKey = process.env.ANTHROPIC_API_KEY;
						if (!apiKey) throw new Error("EVAL_DRIVER=live needs ANTHROPIC_API_KEY.");
						const model = process.env.EVAL_MODEL ?? "claude-sonnet-5-5";
						return { driver: `anthropic:${model}`, report: await runLive(host, TASKS, anthropicDriver({ apiKey, model, fetchImpl: realFetch })) };
					})()
				: { driver: "scripted", report: await runCorpus(host, TASKS, (calls) => new ScriptedDriver(calls)) };
		if (out) writeFileSync(out, JSON.stringify({ ...body, tasks: TASKS.length }, null, 2));
	});
});
