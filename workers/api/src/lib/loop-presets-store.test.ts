import { describe, expect, it } from "vitest";
import { readLoopPresets, writeLoopPresets } from "./loop-presets-store.js";
import type { Env } from "../types.js";

interface Write {
	sql: string;
	args: unknown[];
}

/**
 * Minimal D1 stand-in: one instance row, plus a log of every statement run. The point of these
 * tests is not SQL execution (that's `instance-config`'s job) but WHICH statement the store issues —
 * a whole-blob UPDATE here would silently discard a concurrent settings change (#231).
 */
function mockEnv(row: Record<string, unknown> | null) {
	const writes: Write[] = [];
	const DB = {
		prepare(sql: string) {
			const stmt = {
				bind(...args: unknown[]) {
					return {
						async first() {
							return row;
						},
						async run() {
							writes.push({ sql, args });
							return { meta: { changes: 1 } };
						},
					};
				},
			};
			return stmt;
		},
	};
	return { env: { DB } as unknown as Env, writes };
}

const codingAgent = { slug: "coder", category: "coding", config: JSON.stringify({ capabilities: { workflow: "CODING_SESSION" } }) };

describe("readLoopPresets", () => {
	it("hands a coding agent that never configured any the five defaults", async () => {
		const { env } = mockEnv({ config: "{}", agent_config: codingAgent.config, slug: codingAgent.slug, category: codingAgent.category });
		const r = await readLoopPresets(env, "inst-1", "user-1");
		expect(r.driver).toBe("coding");
		expect(r.source).toBe("default");
		expect(r.presets.map((p) => p.id)).toEqual(["bugs", "quality", "security", "refactor", "tests"]);
	});

	it("returns the subscriber's own list when it has one", async () => {
		const own = [{ id: "mine", label: "Mine", objective: "Do my thing." }];
		const { env } = mockEnv({
			config: JSON.stringify({ loopPresets: own, settings: { keep: 1 } }),
			agent_config: codingAgent.config,
			slug: codingAgent.slug,
			category: codingAgent.category,
		});
		const r = await readLoopPresets(env, "inst-1", "user-1");
		expect(r).toEqual({ presets: own, source: "instance", driver: "coding" });
	});

	it("does not invent coding chores for a chat-driven agent", async () => {
		const { env } = mockEnv({ config: "{}", agent_config: "{}", slug: "language-buddy", category: "education" });
		const r = await readLoopPresets(env, "inst-1", "user-1");
		expect(r.driver).toBe("chat");
		expect(r.presets).toEqual([]);
	});

	it("survives a config column that is empty or corrupt", async () => {
		const { env } = mockEnv({ config: "not json", agent_config: null, slug: null, category: null });
		await expect(readLoopPresets(env, "inst-1", "user-1")).resolves.toMatchObject({ source: "default" });
	});
});

describe("writeLoopPresets", () => {
	it("patches ONLY its own config key, never the whole blob (#231)", async () => {
		const { env, writes } = mockEnv({ config: "{}", agent_config: codingAgent.config, slug: "coder", category: "coding" });
		await writeLoopPresets(env, "inst-1", "user-1", [{ label: "Ship", objective: "Ship it." }]);
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toContain("json_set");
		expect(writes[0].sql).toContain("$.loopPresets");
		// The whole-blob form — the thing this must never become.
		expect(writes[0].sql).not.toMatch(/SET\s+config\s*=\s*\?/);
	});

	it("stores the SANITIZED list, so a junk row cannot reach the loop form", async () => {
		const { env, writes } = mockEnv({ config: "{}", agent_config: "{}", slug: "coder", category: "coding" });
		await writeLoopPresets(env, "inst-1", "user-1", [
			{ label: "Ship", objective: "Ship it." },
			{ label: "", objective: "unlabelled" },
		]);
		expect(JSON.parse(String(writes[0].args[0]))).toEqual([{ id: "ship", label: "Ship", objective: "Ship it." }]);
	});

	it("an empty list REMOVES the override rather than storing an empty one", async () => {
		// Otherwise "delete the last preset" is a one-way door: the instance would be pinned to an
		// empty list and could never inherit the creator's (or the defaults) again.
		const templateConfig = JSON.stringify({
			capabilities: { workflow: "CODING_SESSION" },
			loopPresets: [{ id: "ship", label: "Ship", objective: "Ship it." }],
		});
		const { env, writes } = mockEnv({ config: "{}", agent_config: templateConfig, slug: "coder", category: "coding" });
		const r = await writeLoopPresets(env, "inst-1", "user-1", []);
		expect(writes[0].sql).toContain("json_remove");
		// …and the creator's list is what it inherits again.
		expect(r?.source).toBe("agent");
	});
});
