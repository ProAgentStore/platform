import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1 } from "./d1-sqlite.js";
import { getMachinePolicy, machinePolicyWire, reportMachinePolicyStatus, setMachinePolicy } from "./machine-policy.js";

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
	it("drops oversized runner telemetry instead of silently storing a truncated fact", async () => {
		await setMachinePolicy(env(), "u1", "machine-aaaa1111", true);
		await reportMachinePolicyStatus(env(), "u1", "machine-aaaa1111", { status: "failure", latestVersion: "x".repeat(81), error: "e".repeat(501) });
		expect(await getMachinePolicy(env(), "u1", "machine-aaaa1111")).toMatchObject({ latestVersion: null, lastError: null });
	});
});

describe("machine policy — receipt time is not decision time (#1020)", () => {
	const M = "machine-aaaa1111";
	const at = (ms: number) => vi.spyOn(Date, "now").mockReturnValue(ms);
	afterEach(() => vi.restoreAllMocks());
	const iso = (ms: number) => new Date(ms).toISOString();

	it("a heartbeat re-sending the same cached status advances only last_heartbeat_at", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		at(1_000_000);
		await reportMachinePolicyStatus(env(), "u1", M, { status: "waiting_for_idle", latestVersion: "0.4.98" });
		const first = await getMachinePolicy(env(), "u1", M);
		expect(first.lastAttemptAt).toBe(iso(1_000_000)); // a real transition enabled → waiting_for_idle
		for (const t of [1_030_000, 1_060_000, 1_090_000]) {
			at(t);
			await reportMachinePolicyStatus(env(), "u1", M, { status: "waiting_for_idle", latestVersion: "0.4.98" });
		}
		const later = await getMachinePolicy(env(), "u1", M);
		expect(later.lastAttemptAt).toBe(iso(1_000_000));
		expect(later.lastDecisionAt).toBeNull();
		expect(later.lastHeartbeatAt).toBe(iso(1_090_000));
	});

	it("the runner's own decision/check times are what advance them — and a re-sent decision does not", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		at(2_000_000);
		const report = { status: "waiting_for_idle", decisionAt: 1_990_000, checkAt: 1_989_000, nextRetryDueAt: 2_005_000, blockerClass: "active_sessions", observations: [{ success: true, sampledAt: 1_989_000, source: "sessions" }] };
		await reportMachinePolicyStatus(env(), "u1", M, report);
		at(2_030_000);
		await reportMachinePolicyStatus(env(), "u1", M, report); // heartbeat: same decision re-sent
		const p = await getMachinePolicy(env(), "u1", M);
		expect(p).toMatchObject({
			lastAttemptAt: iso(1_990_000),
			lastDecisionAt: iso(1_990_000),
			lastCheckAt: iso(1_989_000),
			nextRetryDueAt: iso(2_005_000),
			blockerClass: "active_sessions",
			lastHeartbeatAt: iso(2_030_000),
			observations: [{ success: true, sampledAt: iso(1_989_000), source: "sessions" }],
		});
		// The heartbeat arrives after the due time, and the decision did not move: a stalled timer is now visible.
		expect(Date.parse(p.lastHeartbeatAt as string)).toBeGreaterThan(Date.parse(p.nextRetryDueAt as string));
	});

	it("interrupted or lost telemetry: a partial report records receipt only; invalid fields are dropped, never invented", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		at(3_000_000);
		await reportMachinePolicyStatus(env(), "u1", M, { status: "waiting_for_idle", decisionAt: 2_990_000, blockerClass: "active_sessions" });
		at(3_030_000);
		await reportMachinePolicyStatus(env(), "u1", M, { latestVersion: "0.4.99" }); // status lost in transit
		let p = await getMachinePolicy(env(), "u1", M);
		expect(p).toMatchObject({ status: "waiting_for_idle", lastDecisionAt: iso(2_990_000), blockerClass: "active_sessions", lastHeartbeatAt: iso(3_030_000), latestVersion: null });
		at(3_060_000);
		await reportMachinePolicyStatus(env(), "u1", M, {
			status: "waiting_for_idle",
			decisionAt: 9_999_999_999, // far future: not a time this runner can have decided at
			blockerClass: "process args: --token abc",
			observations: [{ success: "yes", sampledAt: 1 }, { success: false, sampledAt: 3_050_000, source: "/Users/x/.claude", prompt: "secret" }, 7],
		});
		p = await getMachinePolicy(env(), "u1", M);
		expect(p.lastDecisionAt).toBe(iso(2_990_000));
		expect(p.blockerClass).toBeNull();
		expect(p.observations).toEqual([{ success: false, sampledAt: iso(3_050_000), source: "unknown" }]);
		expect(JSON.stringify(p)).not.toMatch(/token|claude|secret/);
	});

	it("keeps at most five observations", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		at(4_000_000);
		const observations = Array.from({ length: 8 }, (_v, i) => ({ success: i % 2 === 0, sampledAt: 3_900_000 + i, source: "health" }));
		await reportMachinePolicyStatus(env(), "u1", M, { status: "waiting_for_idle", observations });
		expect((await getMachinePolicy(env(), "u1", M)).observations.map((o) => o.sampledAt)).toEqual([3, 4, 5, 6, 7].map((i) => iso(3_900_000 + i)));
	});

	it("keeps every existing wire field and adds the diagnostics beside them", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		at(5_000_000);
		await reportMachinePolicyStatus(env(), "u1", M, { status: "waiting_for_idle", latestVersion: "0.4.98", decisionAt: 4_990_000, blockerClass: "idle_wait" });
		const wire = machinePolicyWire(await getMachinePolicy(env(), "u1", M));
		expect(wire).toMatchObject({ auto_update_policy: true, latest_version: "0.4.98", auto_update_status: "waiting_for_idle", last_attempt_at: iso(4_990_000), last_error: null });
		expect(wire.auto_update_diagnostics).toEqual({ last_heartbeat_at: iso(5_000_000), last_check_at: null, last_decision_at: iso(4_990_000), next_retry_due_at: null, blocker_class: "idle_wait", observations: [] });
	});
});
