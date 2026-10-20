/**
 * #1250 — migration 0262 moves every hostname pin to the ONE machine id behind it, and leaves alone
 * (for `unresolvedPins` to report) a hostname with no id, with two, or with no registration at all.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";

const MIGRATION = readFileSync(new URL("../../migrations/0262_pin_runner_by_machine_id.sql", import.meta.url).pathname, "utf-8");
const LAPTOP = "3901c9c4-004f-435e-bfc5-0b87b7ac5173";
let d1: RealSchemaD1;

const pin = (id: string, config: Record<string, unknown>) => d1.sqlite.prepare("UPDATE agent_instances SET config = ? WHERE id = ?").run(JSON.stringify(config), id);
const config = (id: string) => JSON.parse((d1.sqlite.prepare("SELECT config FROM agent_instances WHERE id = ?").get(id) as { config: string }).config);
const register = (instanceId: string, user: string, node: string, machineId: string | null) =>
	d1.sqlite.prepare("INSERT INTO instance_runtime_nodes (instance_id, user_id, runner_node, endpoint_url, machine_id) VALUES (?, ?, ?, 'relay://', ?)").run(instanceId, user, node, machineId);

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["a", "b", "c", "d", "e", "f", "g"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["theirs"] });
	register("a", "u1", "Mac.modem", LAPTOP);
	register("b", "u1", "RLs-MacBook-Air.local", LAPTOP);
	register("c", "u1", "RLs-MacBook-Air.local", null); // the same name, not attached that session: no id on this row
	register("a", "u1", "Mac", LAPTOP);
	register("b", "u1", "Mac", "a-second-machine-called-mac");
	register("d", "u1", "dell-laptop", null);
	register("theirs", "u2", "Office", "their-machine-0001");
});
afterEach(() => d1.close());

describe("migration 0262: hostname pins → machine ids (#1250)", () => {
	it("resolves each hostname with exactly one machine id behind it, keeping every other key", () => {
		pin("a", { runnerNode: "Mac.modem", settings: { keep: 1 } });
		pin("b", { runnerNode: "RLs-MacBook-Air.local" });
		d1.exec(MIGRATION);
		expect(config("a")).toEqual({ runnerNode: "Mac.modem", runnerMachineId: LAPTOP, settings: { keep: 1 } });
		expect(config("b")).toMatchObject({ runnerMachineId: LAPTOP });
	});

	it("leaves unresolvable pins as they were: two machines, no id, no registration, another owner's machine", () => {
		pin("c", { runnerNode: "Mac" });
		pin("d", { runnerNode: "dell-laptop" });
		pin("e", { runnerNode: "gone-machine" });
		pin("f", { runnerNode: "Office" }); // only u2 ever registered "Office"
		pin("g", {});
		d1.exec(MIGRATION);
		expect(config("c")).toEqual({ runnerNode: "Mac" });
		expect(config("d")).toEqual({ runnerNode: "dell-laptop" });
		expect(config("e")).toEqual({ runnerNode: "gone-machine" });
		expect(config("f")).toEqual({ runnerNode: "Office" });
		expect(config("g")).toEqual({});
	});

	it("is idempotent and never overwrites a machine pin already set", () => {
		pin("a", { runnerNode: "Mac.modem", runnerMachineId: "already-chosen-01" });
		d1.exec(MIGRATION);
		d1.exec(MIGRATION);
		expect(config("a").runnerMachineId).toBe("already-chosen-01");
	});
});
