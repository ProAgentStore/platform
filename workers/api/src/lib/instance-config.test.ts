import { describe, expect, it } from "vitest";
import { instanceListView, isValidConfigKey, patchInstanceConfig, removeInstanceConfigKey } from "./instance-config.js";
import type { Env } from "../types.js";

/** Captures the SQL + bindings so the shape of the statement is assertable without a DB. */
function captureEnv(changes = 1) {
	const calls: Array<{ sql: string; args: unknown[] }> = [];
	const env = {
		DB: {
			prepare: (sql: string) => ({
				bind: (...args: unknown[]) => ({
					run: async () => {
						calls.push({ sql, args });
						return { meta: { changes } };
					},
				}),
			}),
		},
	} as unknown as Env;
	return { env, calls };
}

describe("patchInstanceConfig", () => {
	// The bug: sixteen call sites read the whole blob, changed one key and wrote it whole, so
	// two requests touching DIFFERENT keys lost one of them — silently.
	it("writes a targeted json_set, not the whole blob", async () => {
		const { env, calls } = captureEnv();
		await patchInstanceConfig(env, "i1", "u1", "behaviour", { tone: "warm" });
		expect(calls[0].sql).toContain("json_set(");
		expect(calls[0].args[0]).toBe("$.behaviour");
		expect(calls[0].sql).not.toMatch(/SET config = \?/); // never a whole-blob assignment
	});

	// The path is a BOUND ARGUMENT, not text spliced into the statement (#327). Spliced, a quote
	// in the key ends the SQL string literal and the rest of it is parsed as SQL — the validation
	// above was then the only boundary. Bound, a hostile key can at worst become a strange key
	// name inside the document; nothing of it reaches the parser.
	it("binds the JSON path rather than splicing it into the SQL", async () => {
		const { env, calls } = captureEnv();
		await patchInstanceConfig(env, "i1", "u1", "settings", 1);
		expect(calls[0].sql).not.toMatch(/'\$\./);
		expect(calls[0].sql).toContain(", ?1, json(?2))");
		expect(calls[0].args[0]).toBe("$.settings");
	});

	// json() around the bound parameter is what preserves objects/arrays. Without it SQLite
	// stores the JSON as an escaped STRING — the subtype trap migration 0071 documents at length.
	it("binds the value through json() so objects survive as objects", async () => {
		const { env, calls } = captureEnv();
		await patchInstanceConfig(env, "i1", "u1", "settings", { a: 1, b: ["x"] });
		expect(calls[0].sql).toContain("json(?2)");
		expect(calls[0].args[1]).toBe(JSON.stringify({ a: 1, b: ["x"] }));
	});

	// The column defaults to '' (not '{}'), so without this a patch on a fresh instance would
	// silently no-op — json_set on a non-JSON value returns NULL.
	it("coerces an empty or malformed config to {} before writing", async () => {
		const { env, calls } = captureEnv();
		await patchInstanceConfig(env, "i1", "u1", "board", {});
		expect(calls[0].sql).toContain("json_valid(config)");
		expect(calls[0].sql).toContain("'{}'");
	});

	it("scopes the write to the owner", async () => {
		const { env, calls } = captureEnv();
		await patchInstanceConfig(env, "i1", "u1", "board", {});
		expect(calls[0].sql).toContain("user_id = ?4");
		expect(calls[0].args).toContain("u1");
	});

	it("reports whether a row actually matched", async () => {
		expect(await patchInstanceConfig(captureEnv(1).env, "i1", "u1", "k", 1)).toBe(true);
		expect(await patchInstanceConfig(captureEnv(0).env, "i1", "u1", "k", 1)).toBe(false);
	});

	it("stores an explicit null rather than dropping the key", async () => {
		const { env, calls } = captureEnv();
		await patchInstanceConfig(env, "i1", "u1", "k", null);
		expect(calls[0].args[1]).toBe("null");
	});

	// The key is concatenated into a JSON PATH, so it is validated rather than trusted — even
	// though every current caller passes a literal.
	it("refuses a key that isn't a plain identifier", async () => {
		const { env } = captureEnv();
		for (const bad of ["a.b", "a'b", "$.x", "a b", "", "1abc", "a[0]"]) {
			await expect(patchInstanceConfig(env, "i1", "u1", bad, 1)).rejects.toThrow(/Invalid config key/);
		}
	});
});

describe("removeInstanceConfigKey", () => {
	it("removes just that key", async () => {
		const { env, calls } = captureEnv();
		await removeInstanceConfigKey(env, "i1", "u1", "translation");
		expect(calls[0].sql).toContain("json_remove(");
		expect(calls[0].sql).not.toMatch(/'\$\./);
		expect(calls[0].args[0]).toBe("$.translation");
	});

	it("validates the key too", async () => {
		const { env } = captureEnv();
		await expect(removeInstanceConfigKey(env, "i1", "u1", "a.b")).rejects.toThrow(/Invalid config key/);
	});
});

describe("isValidConfigKey", () => {
	it("accepts the keys actually in use", () => {
		for (const k of ["settings", "behaviour", "board", "translation", "disabledTools", "codingEngines", "specialInstructions", "pipelines", "runnerNode"]) {
			expect(isValidConfigKey(k)).toBe(true);
		}
	});
});

// ── The list view (#500): a whitelist, so a later config key cannot ship by accident ──
describe("instanceListView", () => {
	it("carries the runner-node pin — the field `pags up` filters membership on", () => {
		expect(instanceListView(JSON.stringify({ runnerNode: "RLs-MacBook-Air.local" })).runnerNode)
			.toBe("RLs-MacBook-Air.local");
	});

	it("reports an unpinned instance as null, so the response omits `config` entirely", () => {
		expect(instanceListView("{}").runnerNode).toBeNull();
		expect(instanceListView(JSON.stringify({ runnerNode: "  " })).runnerNode).toBeNull();
		expect(instanceListView(null).runnerNode).toBeNull();
	});

	it("returns ONLY the two whitelisted keys — a secret in the blob has no way out", () => {
		const view = instanceListView(JSON.stringify({
			displayName: " My Coder ",
			runnerNode: "mac-mini",
			credentials: { password: "hunter2" },
			settings: { target_language: "zh" },
			specialInstructions: "never say this out loud",
		}));
		expect(Object.keys(view).sort()).toEqual(["displayName", "runnerNode"]);
		expect(view.displayName).toBe("My Coder");
		expect(JSON.stringify(view)).not.toContain("hunter2");
	});

	it("treats a malformed blob as nothing set rather than throwing", () => {
		expect(instanceListView("{not json")).toEqual({ displayName: null, runnerNode: null });
	});
});

// ── The guard (#231): no route may go back to whole-blob config writes ───────
//
// The helper only helps if it is the ONLY way in. Sixteen call sites each read the blob,
// changed one key and wrote it whole; two requests touching different keys lost one of them,
// silently. A reviewer cannot be expected to catch the seventeenth by eye.
describe("no whole-blob agent_instances.config writes remain", () => {
	it("no source file issues `UPDATE agent_instances SET config = ?`", async () => {
		const { readdirSync, readFileSync, statSync } = await import("node:fs");
		const { join } = await import("node:path");
		const root = new URL("../", import.meta.url).pathname; // workers/api/src

		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const p = join(dir, entry);
				if (statSync(p).isDirectory()) { walk(p); continue; }
				if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
				// The helper itself is the sanctioned writer.
				if (p.endsWith("instance-config.ts")) continue;
				const src = readFileSync(p, "utf-8");
				if (/UPDATE\s+agent_instances\s+SET\s+config\s*=\s*\?/i.test(src)) {
					offenders.push(p.slice(root.length));
				}
			}
		};
		walk(root);

		expect(offenders, `Use patchInstanceConfig/removeInstanceConfigKey instead — a whole-blob write silently discards a concurrent change to another key (#231). Offenders:\n${offenders.join("\n")}`).toEqual([]);
	});
});
