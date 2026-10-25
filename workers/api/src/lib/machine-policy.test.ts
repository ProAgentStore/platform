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

describe("machine policy — rollbacks stay on the machine's record (#1150)", () => {
	const M = "machine-aaaa1111";
	const rb = { from: "0.4.150", to: "0.4.148", reason: "it did not register within 5 minutes of first starting", at: Date.parse("2026-10-25T01:00:00Z") };

	it("stores what the runner reports, as the wire the machine page reads — and keeps it through reports that omit it", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		await reportMachinePolicyStatus(env(), "u1", M, { status: "failure", error: "Rolled back from 0.4.150 to 0.4.148: x.", rollbacks: [rb] });
		const wire = machinePolicyWire(await getMachinePolicy(env(), "u1", M));
		expect(wire.rollbacks).toEqual([{ from: "0.4.150", to: "0.4.148", reason: rb.reason, at: "2026-10-25T01:00:00.000Z" }]);
		// an older runner's report has no field: the record stands
		await reportMachinePolicyStatus(env(), "u1", M, { status: "waiting_for_idle" });
		expect((await getMachinePolicy(env(), "u1", M)).rollbacks).toHaveLength(1);
	});

	it("an empty list from the runner clears it: the owner's retry removed the mark", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		await reportMachinePolicyStatus(env(), "u1", M, { status: "failure", rollbacks: [rb] });
		await reportMachinePolicyStatus(env(), "u1", M, { status: "restarting", rollbacks: [] });
		expect((await getMachinePolicy(env(), "u1", M)).rollbacks).toEqual([]);
	});

	it("keeps only well-formed, bounded entries, and none across owners", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		const junk = [rb, { from: 5 }, null, { from: "", reason: "x" }, { from: "0.4.1", reason: "r".repeat(900), to: 7, at: "not a date" }, ...Array.from({ length: 20 }, (_, i) => ({ from: `0.5.${i}`, reason: "r" }))];
		await reportMachinePolicyStatus(env(), "u1", M, { status: "failure", rollbacks: junk });
		const got = (await getMachinePolicy(env(), "u1", M)).rollbacks;
		expect(got.length).toBeLessThanOrEqual(10);
		expect(got[0]?.from).toBe("0.4.150");
		const bounded = got.find((r) => r.from === "0.4.1");
		expect(bounded).toMatchObject({ to: null, at: null });
		expect(bounded?.reason.length).toBeLessThan(400);
		expect((await getMachinePolicy(env(), "u2", M)).rollbacks).toEqual([]);
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

	it("keeps an unreadable observation distinct from a failed one, through storage and the wire — never on a success", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		at(4_500_000);
		const observations = [
			{ success: false, sampledAt: 4_490_000, source: "sessions", malformed: true },
			{ success: false, sampledAt: 4_490_000, source: "health" },
			{ success: true, sampledAt: 4_495_000, source: "health", malformed: true },
		];
		await reportMachinePolicyStatus(env(), "u1", M, { status: "waiting_for_idle", blockerClass: "observation_failure", observations });
		expect(machinePolicyWire(await getMachinePolicy(env(), "u1", M)).auto_update_diagnostics.observations).toEqual([
			{ success: false, sampled_at: iso(4_490_000), source: "sessions", malformed: true },
			{ success: false, sampled_at: iso(4_490_000), source: "health" },
			{ success: true, sampled_at: iso(4_495_000), source: "health" },
		]);
	});

	it("carries per-observation session-state counts through storage and the wire — on a readable sessions look only", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		at(4_700_000);
		const counts = { activeTurns: 1, idleRetained: 2, stopped: 3, unknown: 0 };
		const observations = [
			{ success: true, sampledAt: 4_690_000, source: "sessions", sessionStates: counts },
			// Never on a failed look, a health look, or a partial / negative / fractional set.
			{ success: false, sampledAt: 4_690_001, source: "sessions", sessionStates: counts },
			{ success: true, sampledAt: 4_690_002, source: "health", sessionStates: counts },
			{ success: true, sampledAt: 4_690_003, source: "sessions", sessionStates: { activeTurns: 1, idleRetained: 2 } },
			{ success: true, sampledAt: 4_690_004, source: "sessions", sessionStates: { activeTurns: -1, idleRetained: 0.5, stopped: 0, unknown: 0, sessionId: "csess_x" } },
		];
		await reportMachinePolicyStatus(env(), "u1", M, { status: "waiting_for_idle", blockerClass: "active_sessions", observations });
		const wire = machinePolicyWire(await getMachinePolicy(env(), "u1", M)).auto_update_diagnostics.observations;
		expect(wire[0]).toEqual({ success: true, sampled_at: iso(4_690_000), source: "sessions", session_states: { active_turns: 1, idle_retained: 2, stopped: 3, unknown: 0 } });
		expect(wire.slice(1).some((o) => "session_states" in o)).toBe(false);
		expect(JSON.stringify(wire)).not.toContain("csess_x");
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

describe("machine policy — the runner's update log (#1151)", () => {
	const M = "machine-aaaa1111";

	it("stores the log a restart uploads, keeps it through reports that carry none, and puts it on the wire", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		const log = "2026-10-18T03:17:55.000Z [133] start: pags up 0.4.150 (unattended)\n2026-10-18T03:17:58.000Z [140] registered: 0.4.150 answered by the platform";
		await reportMachinePolicyStatus(env(), "u1", M, { status: "verified_success", updateLog: log });
		await reportMachinePolicyStatus(env(), "u1", M, { status: "verified_success" });
		await reportMachinePolicyStatus(env(), "u1", M, { latestVersion: "0.4.150" }); // a status-less report: receipt only
		const policy = await getMachinePolicy(env(), "u1", M);
		expect(policy.updateLog).toBe(log);
		expect(machinePolicyWire(policy).update_log).toBe(log);
	});

	it("a status-less report still lands its log, and an oversized one keeps its newest end", async () => {
		await setMachinePolicy(env(), "u1", M, true);
		await reportMachinePolicyStatus(env(), "u1", M, { updateLog: `${"x".repeat(9000)}END` });
		const stored = (await getMachinePolicy(env(), "u1", M)).updateLog ?? "";
		expect(stored.length).toBe(8000);
		expect(stored.endsWith("END")).toBe(true);
	});
});
