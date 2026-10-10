import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1 } from "./d1-sqlite.js";
import { getMachinePolicy, reportMachinePolicyStatus, setMachinePolicy } from "./machine-policy.js";

let d1: ReturnType<typeof realSchemaD1>;
const env = () => ({ DB: d1.DB }) as never;
beforeEach(() => { d1 = realSchemaD1(); d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'one'), ('u2', 'two')"); });
afterEach(() => d1.close());

describe("machine policy — stable owner-scoped defaults", () => {
	it("defaults existing machines OFF without a backfill row", async () => {
		expect(await getMachinePolicy(env(), "u1", "machine-aaaa1111")).toMatchObject({ autoUpdate: false, status: "disabled" });
	});
	it("isolates owners and one stable id covers hostname aliases", async () => {
		await setMachinePolicy(env(), "u1", "machine-aaaa1111", true);
		expect(await getMachinePolicy(env(), "u1", "machine-aaaa1111")).toMatchObject({ autoUpdate: true, status: "enabled" });
		expect(await getMachinePolicy(env(), "u2", "machine-aaaa1111")).toMatchObject({ autoUpdate: false, status: "disabled" });
	});
	it("records runner status but disabling wins a pending install race", async () => {
		await setMachinePolicy(env(), "u1", "machine-aaaa1111", true);
		await reportMachinePolicyStatus(env(), "u1", "machine-aaaa1111", { status: "waiting_for_idle", latestVersion: "0.4.91" });
		expect((await getMachinePolicy(env(), "u1", "machine-aaaa1111")).status).toBe("waiting_for_idle");
		await setMachinePolicy(env(), "u1", "machine-aaaa1111", false);
		expect(await getMachinePolicy(env(), "u1", "machine-aaaa1111")).toMatchObject({ autoUpdate: false, status: "disabled" });
	});
});
