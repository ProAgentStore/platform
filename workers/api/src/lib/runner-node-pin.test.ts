import { describe, expect, it } from "vitest";
import { RUNNER_PIN_EVENT, RUNNER_PIN_EVENT_SOURCE, describePinChange, setRunnerNodePin } from "./runner-node-pin.js";
import type { Env } from "../types.js";

interface Write { sql: string; args: unknown[] }

/**
 * D1 stub: `SELECT config` answers with the pin already stored, every `.run()` is captured.
 * `changes` is what the UPDATE reports — 0 stands for "no row matched" (not the owner, or gone).
 */
function stubEnv(storedConfig: Record<string, unknown> = {}, changes = 1) {
	const writes: Write[] = [];
	const env = {
		DB: {
			prepare: (sql: string) => ({
				bind: (...args: unknown[]) => ({
					first: async () => (sql.includes("SELECT config") ? { config: JSON.stringify(storedConfig) } : null),
					run: async () => {
						writes.push({ sql, args });
						return { meta: { changes } };
					},
				}),
			}),
		},
	} as unknown as Env;
	return { env, writes };
}

const traceWrites = (writes: Write[]) => writes.filter((w) => w.sql.startsWith("INSERT INTO agent_events"));
/** The `agent_events` column order in `logEvent`: id, ts, user_id, instance_id, trace_id, source, level, event, message, context. */
const traceRow = (w: Write) => ({
	ts: w.args[1] as number,
	userId: w.args[2],
	instanceId: w.args[3],
	source: w.args[5],
	level: w.args[6],
	event: w.args[7],
	message: w.args[8] as string,
	context: JSON.parse((w.args[9] as string) || "null") as { from: string | null; to: string | null; via: string },
});

describe("setRunnerNodePin", () => {
	// AC 1 + 2. The pin decides whether ANY runner call routes; #530 could only INFER what it held
	// at 07:44:10 because this row did not exist.
	it("records the previous AND new value, scoped to the instance and the account that changed it", async () => {
		const { env, writes } = stubEnv({ runnerNode: "RLs-MacBook-Air.local" });
		const before = Date.now();
		const res = await setRunnerNodePin(env, "inst-1", "u1", "Sergeys-Mac-mini.local");

		expect(res).toEqual({ from: "RLs-MacBook-Air.local", to: "Sergeys-Mac-mini.local", changed: true });
		const rows = traceWrites(writes);
		expect(rows).toHaveLength(1);
		const row = traceRow(rows[0]);
		expect(row.context.from).toBe("RLs-MacBook-Air.local");
		expect(row.context.to).toBe("Sergeys-Mac-mini.local");
		// WHO and WHEN — the two fields that would have made #530 a measurement.
		expect(row.userId).toBe("u1");
		expect(row.instanceId).toBe("inst-1");
		expect(row.ts).toBeGreaterThanOrEqual(before);
		// Readable through the same surfaces as every other instance event: `listEvents` filters on
		// (user_id, instance_id) and optionally `source`, so both must be set.
		expect(row.source).toBe(RUNNER_PIN_EVENT_SOURCE);
		expect(row.event).toBe(RUNNER_PIN_EVENT);
		expect(row.level).toBe("info");
	});

	// Clearing is as consequential as setting: routing stops being pinned and starts resolving to
	// whichever machine holds a live socket. One event name covers both directions.
	it("records clearing the pin, with the machine it stopped being pinned to", async () => {
		const { env, writes } = stubEnv({ runnerNode: "laptop-A" });
		const res = await setRunnerNodePin(env, "inst-1", "u1", "");

		expect(res).toEqual({ from: "laptop-A", to: "", changed: true });
		expect(writes.some((w) => w.sql.includes("json_remove(") && w.args[0] === "$.runnerNode")).toBe(true);
		const row = traceRow(traceWrites(writes)[0]);
		expect(row.context).toMatchObject({ from: "laptop-A", to: null });
		expect(row.message).toBe("Runs on: laptop-A → automatic");
	});

	it("records the first pin on an instance that had none", async () => {
		const { env, writes } = stubEnv({});
		const res = await setRunnerNodePin(env, "inst-1", "u1", "laptop-A");
		expect(res.from).toBe("");
		expect(traceRow(traceWrites(writes)[0]).context).toMatchObject({ from: null, to: "laptop-A" });
	});

	// AC 3 — the decision, stated: a no-op is silent. The record answers "when did routing change";
	// a row whose from equals its to answers nothing, and re-picking the machine already chosen is
	// ordinary picker behaviour, so those rows would outnumber the real ones.
	it("writes NO event when the pin is set to what it already was", async () => {
		const { env, writes } = stubEnv({ runnerNode: "laptop-A" });
		const res = await setRunnerNodePin(env, "inst-1", "u1", "laptop-A");
		expect(res.changed).toBe(false);
		expect(traceWrites(writes)).toHaveLength(0);
		// …but the config UPDATE still runs, so `updated_at` behaves exactly as it did before.
		expect(writes.some((w) => w.sql.includes("json_set(") && w.args[0] === "$.runnerNode")).toBe(true);
	});

	it("writes NO event when clearing an already-automatic instance", async () => {
		const { env, writes } = stubEnv({});
		expect((await setRunnerNodePin(env, "inst-1", "u1", "  ")).changed).toBe(false);
		expect(traceWrites(writes)).toHaveLength(0);
	});

	// A `json_remove` of an absent key still reports changes=1, so "the row was updated" is not
	// "the value differed" — and changes=0 means the write never landed at all.
	it("never claims a change the database refused", async () => {
		const { env, writes } = stubEnv({ runnerNode: "laptop-A" }, 0);
		const res = await setRunnerNodePin(env, "inst-1", "u1", "laptop-B");
		expect(res.changed).toBe(false);
		expect(traceWrites(writes)).toHaveLength(0);
	});

	it("normalizes the requested node before comparing, so whitespace is not a change", async () => {
		const { env, writes } = stubEnv({ runnerNode: "laptop-A" });
		expect((await setRunnerNodePin(env, "inst-1", "u1", "  laptop-A  ")).changed).toBe(false);
		expect(traceWrites(writes)).toHaveLength(0);
	});

	it("names the surface that repinned, so a second writer is distinguishable", async () => {
		const { env, writes } = stubEnv({});
		await setRunnerNodePin(env, "inst-1", "u1", "laptop-A", { via: "mcp" });
		expect(traceRow(traceWrites(writes)[0]).context.via).toBe("mcp");
		const plain = stubEnv({});
		await setRunnerNodePin(plain.env, "inst-1", "u1", "laptop-A");
		expect(traceRow(traceWrites(plain.writes)[0]).context.via).toBe("api");
	});
});

describe("describePinChange", () => {
	it("spells an unset pin as Automatic in both directions", () => {
		expect(describePinChange("", "laptop-A")).toBe("Runs on: automatic → laptop-A");
		expect(describePinChange("laptop-A", "")).toBe("Runs on: laptop-A → automatic");
	});
});

// ── The guard: this module must stay the ONLY writer of the pin ──────────────────────────────
//
// Same shape as `instance-config.test.ts`'s whole-blob guard (#231), for the same reason: an audit
// that lives beside ONE caller is an audit the next caller forgets. There is one writer today; an
// MCP tool or a CLI command that repins later would otherwise silently reopen the exact gap #533
// closed, and no reviewer can be expected to catch it by eye.
describe("no other writer of config.runnerNode", () => {
	it("no source file patches or removes $.runnerNode directly", async () => {
		const { readdirSync, readFileSync, statSync } = await import("node:fs");
		const { join } = await import("node:path");
		const root = new URL("../", import.meta.url).pathname; // workers/api/src

		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const p = join(dir, entry);
				if (statSync(p).isDirectory()) {
					walk(p);
					continue;
				}
				if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
				if (p.endsWith("runner-node-pin.ts")) continue; // the sanctioned writer
				const src = readFileSync(p, "utf-8");
				if (/(patchInstanceConfig|removeInstanceConfigKey)\([\s\S]{0,200}?"runnerNode"/.test(src)) {
					offenders.push(p.slice(root.length));
				}
			}
		};
		walk(root);

		expect(
			offenders,
			`Use setRunnerNodePin() — the pin decides whether every runner call routes anywhere, and a change to it must leave a record (#533). Offenders:\n${offenders.join("\n")}`,
		).toEqual([]);
	});
});
