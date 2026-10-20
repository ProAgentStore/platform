/** #1250 — owner-set display names: one machine, one name; two machines can never share one. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { machineDisplayNames, machineIdForDisplayName, parseDisplayName, setMachineDisplayName } from "./machine-names.js";
import type { Env } from "../types.js";

const LAPTOP = "3901c9c4-004f-435e-bfc5-0b87b7ac5173";
const MINI = "machine-macmini01";
let d1: RealSchemaD1;
let env: Env;
beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	seedTenant(d1, { userId: "u2", instanceIds: ["i2"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

describe("machine display names (#1250)", () => {
	it("names a machine, renames it, and clears it with a blank", async () => {
		expect(await setMachineDisplayName(env, "u1", LAPTOP, " rl-laptop ")).toEqual({ ok: true, displayName: "rl-laptop" });
		expect(await machineIdForDisplayName(env, "u1", "RL-LAPTOP")).toBe(LAPTOP);
		expect(await setMachineDisplayName(env, "u1", LAPTOP, "travel laptop")).toEqual({ ok: true, displayName: "travel laptop" });
		expect([...(await machineDisplayNames(env, "u1"))]).toEqual([[LAPTOP, "travel laptop"]]);
		expect(await setMachineDisplayName(env, "u1", LAPTOP, "")).toEqual({ ok: true, displayName: null });
		expect((await machineDisplayNames(env, "u1")).size).toBe(0);
	});

	it("refuses a name another of the owner's machines has — case-insensitively — and says which", async () => {
		await setMachineDisplayName(env, "u1", LAPTOP, "rl-laptop");
		const dup = await setMachineDisplayName(env, "u1", MINI, "RL-Laptop");
		expect(dup).toMatchObject({ ok: false, status: 409, error: expect.stringContaining(LAPTOP) });
		expect((await machineDisplayNames(env, "u1")).get(MINI)).toBeUndefined();
		// Another owner may use the same name; uniqueness is per account.
		expect(await setMachineDisplayName(env, "u2", "their-machine-0001", "rl-laptop")).toMatchObject({ ok: true });
	});

	it("the unique index holds even if the check is raced", () => {
		d1.sqlite.prepare("INSERT INTO machine_policies (user_id, machine_id, display_name) VALUES ('u1', ?, 'mac-mini')").run(LAPTOP);
		expect(() => d1.sqlite.prepare("INSERT INTO machine_policies (user_id, machine_id, display_name) VALUES ('u1', ?, 'MAC-MINI')").run(MINI)).toThrow(/UNIQUE/);
	});

	it("validates the name and the machine id", async () => {
		expect(parseDisplayName("x".repeat(41))).toMatchObject({ ok: false });
		expect(parseDisplayName("-leading")).toMatchObject({ ok: false });
		expect(parseDisplayName(3)).toMatchObject({ ok: false });
		expect(parseDisplayName(null)).toEqual({ ok: true, name: null });
		expect(await setMachineDisplayName(env, "u1", "bad id!", "x")).toMatchObject({ ok: false, status: 400 });
	});
});
