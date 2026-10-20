import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { setMachineDisplayName } from "./machine-names.js";
import { RUNNER_PIN_EVENT, RUNNER_PIN_EVENT_SOURCE, describePinChange, setRunnerNodePin } from "./runner-node-pin.js";
import { readInstanceRunnerNode } from "./runtime-nodes.js";
import type { Env } from "../types.js";

/**
 * #533 + #1250, on the real migrated schema: the pin is a machine id, written by ONE function that
 * records every change. Machines are `instance_runtime_nodes` rows; names are `machine_policies`.
 */
const LAPTOP = "3901c9c4-004f-435e-bfc5-0b87b7ac5173";
const MINI = "6b8d2f1e-0000-4c1a-9b2e-macmini00001";
let d1: RealSchemaD1;
let env: Env;

function register(instanceId: string, node: string, machineId: string | null, lastSeen: string) {
	d1.sqlite.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id, last_seen_at) VALUES (?, 'u1', ?, 'relay://', ?, ?)").run(instanceId, node, machineId, lastSeen);
}
const config = (id = "inst-1") => JSON.parse((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = ?").get(id) as { config: string | null }).config || "{}");
const events = () =>
	(d1.sqlite.prepare("SELECT user_id, instance_id, source, level, event, message, context, ts FROM agent_events WHERE event = ? ORDER BY ts").all(RUNNER_PIN_EVENT) as Array<{ user_id: string; instance_id: string; source: string; level: string; event: string; message: string; context: string; ts: number }>).map((e) => ({ ...e, context: JSON.parse(e.context) as { from: string | null; to: string | null; via: string; machineId: string | null } }));

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1", "inst-2"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["other"] });
	env = { DB: d1.DB } as unknown as Env;
	register("inst-1", "RLs-MacBook-Air.local", LAPTOP, "2026-10-19 10:00:00");
	register("inst-2", "Mac.modem", LAPTOP, "2026-10-20 00:40:00");
	register("inst-1", "Macmini", MINI, "2026-10-20 00:30:00");
	register("inst-2", "Sergeys-Mac-mini.local", MINI, "2026-10-19 00:30:00");
	register("inst-1", "dell-laptop", null, "2026-10-20 00:10:00"); // an old CLI: no machine id
	register("inst-1", "Mac", LAPTOP, "2026-10-18 00:00:00");
	register("inst-2", "Mac", "a-second-machine-called-mac", "2026-10-18 00:00:00"); // two machines both called Mac
});
afterEach(() => d1.close());

describe("setRunnerNodePin — the pin is a machine id (#1250)", () => {
	it("pins by hostname of one machine: stores the machine id, removes the hostname key, routes by the machine's CURRENT hostname", async () => {
		d1.sqlite.prepare("UPDATE agent_instances SET config = ? WHERE id = 'inst-1'").run(JSON.stringify({ runnerNode: "Sergeys-Mac-mini.local", settings: { keep: 1 } }));
		const res = await setRunnerNodePin(env, "inst-1", "u1", "RLs-MacBook-Air.local");
		expect(res).toEqual({ from: "Sergeys-Mac-mini.local", to: "Mac.modem", machineId: LAPTOP, displayName: null, changed: true });
		expect(config()).toEqual({ runnerMachineId: LAPTOP, settings: { keep: 1 } });
		expect(await readInstanceRunnerNode(env, "inst-1", "u1")).toBe("Mac.modem");
	});

	it("pins by display name or by machine id to the same machine", async () => {
		await setMachineDisplayName(env, "u1", MINI, "mac-mini");
		expect((await setRunnerNodePin(env, "inst-1", "u1", "MAC-MINI")).machineId).toBe(MINI); // names are case-insensitive
		expect(config().runnerMachineId).toBe(MINI);
		expect((await setRunnerNodePin(env, "inst-2", "u1", LAPTOP)).machineId).toBe(LAPTOP);
	});

	it("a hostname change keeps the pin: the machine registers under a new name and routing follows it", async () => {
		await setRunnerNodePin(env, "inst-1", "u1", "Mac.modem");
		register("inst-1", "SergeysRLLaptop", LAPTOP, "2026-10-20 02:00:00");
		expect(config()).toEqual({ runnerMachineId: LAPTOP });
		expect(await readInstanceRunnerNode(env, "inst-1", "u1")).toBe("SergeysRLLaptop");
	});

	it("a rename keeps the pin: the display name changes, the stored machine id does not", async () => {
		await setMachineDisplayName(env, "u1", LAPTOP, "rl-laptop");
		await setRunnerNodePin(env, "inst-1", "u1", "rl-laptop");
		await setMachineDisplayName(env, "u1", LAPTOP, "travel-laptop");
		expect(config()).toEqual({ runnerMachineId: LAPTOP });
		expect(await readInstanceRunnerNode(env, "inst-1", "u1")).toBe("Mac.modem");
		// Re-pinning by the new name is the same machine — no change recorded.
		expect((await setRunnerNodePin(env, "inst-1", "u1", "travel-laptop")).changed).toBe(false);
	});

	it("refuses what is not one machine, with the reason — and stores nothing", async () => {
		await expect(setRunnerNodePin(env, "inst-1", "u1", "Mac")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/used by 2 different machines/) });
		await expect(setRunnerNodePin(env, "inst-1", "u1", "dell-laptop")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/no stable machine id/) });
		await expect(setRunnerNodePin(env, "inst-1", "u1", "nowhere")).rejects.toMatchObject({ status: 404 });
		// Another owner's machine id is unknown to this one.
		d1.sqlite.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id) VALUES ('other', 'u2', 'theirs', 'relay://', 'their-machine-0001')").run();
		await expect(setRunnerNodePin(env, "inst-1", "u1", "their-machine-0001")).rejects.toMatchObject({ status: 404 });
		expect(config()).toEqual({});
	});

	it("records the previous AND new machine, scoped to the instance and the account that changed it", async () => {
		await setMachineDisplayName(env, "u1", LAPTOP, "rl-laptop");
		d1.sqlite.prepare("UPDATE agent_instances SET config = ? WHERE id = 'inst-1'").run(JSON.stringify({ runnerNode: "Sergeys-Mac-mini.local" }));
		const before = Date.now();
		await setRunnerNodePin(env, "inst-1", "u1", "rl-laptop");
		const [row] = events();
		expect(row).toMatchObject({ user_id: "u1", instance_id: "inst-1", source: RUNNER_PIN_EVENT_SOURCE, level: "info", message: `Runs on: Sergeys-Mac-mini.local → rl-laptop (${LAPTOP})` });
		expect(row.context).toMatchObject({ from: "Sergeys-Mac-mini.local", to: `rl-laptop (${LAPTOP})`, machineId: LAPTOP, via: "api" });
		expect(row.ts).toBeGreaterThanOrEqual(before);
	});

	it("records clearing the pin, and removes both keys", async () => {
		await setRunnerNodePin(env, "inst-1", "u1", LAPTOP);
		const res = await setRunnerNodePin(env, "inst-1", "u1", "");
		expect(res).toMatchObject({ to: "", machineId: "", changed: true });
		expect(config()).toEqual({});
		expect(events().at(-1)?.message).toBe(`Runs on: ${LAPTOP} → automatic`);
	});

	it("writes NO event when the pin already names that machine, or clearing an automatic one", async () => {
		await setRunnerNodePin(env, "inst-1", "u1", "Mac.modem");
		expect((await setRunnerNodePin(env, "inst-1", "u1", "  RLs-MacBook-Air.local  ")).changed).toBe(false); // another alias of the same machine
		expect((await setRunnerNodePin(env, "inst-2", "u1", " ")).changed).toBe(false);
		expect(events()).toHaveLength(1);
	});

	it("never claims a change the database refused", async () => {
		const res = await setRunnerNodePin(env, "other", "u1", LAPTOP); // not u1's instance
		expect(res.changed).toBe(false);
		expect(events()).toHaveLength(0);
	});

	it("names the surface that repinned", async () => {
		await setRunnerNodePin(env, "inst-1", "u1", LAPTOP, { via: "mcp" });
		expect(events()[0].context.via).toBe("mcp");
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
describe("no other writer of config.runnerNode / config.runnerMachineId", () => {
	it("no source file patches or removes $.runnerNode or $.runnerMachineId directly", async () => {
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
				if (/(patchInstanceConfig|removeInstanceConfigKey)\([\s\S]{0,200}?"runner(Node|MachineId)"/.test(src)) {
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
