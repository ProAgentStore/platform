/**
 * #1141 — the platform side of an auto-update that must never leave a machine dark.
 *
 * On 2026-10-17 two machines reported `installing`, stopped heartbeating, and sat there: the console
 * said "installing" forever and nothing reached the error log. Over the real schema:
 *   - a machine silent 5 minutes after an install is failed with a reason, logged once, and flagged
 *     `auto_update_stuck` (`no_heartbeat_after_install`) — connected or not, registry or not;
 *   - a failure the runner reports (a failed install, a rollback) is an error-log row, once per failure;
 *   - every runner learns how many OTHER machines are mid-update, counting only those ahead of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assessAutoUpdateStuck, stuckNow } from "./auto-update-stuck.js";
import { realSchemaD1 } from "./d1-sqlite.js";
import { failSilentUpdates, fleetUpdatingFor, getMachinePolicy, reportMachinePolicyStatus, setMachinePolicy, silentAfterInstall, SILENT_UPDATE_ERROR, UPDATE_SILENCE_MS } from "./machine-policy.js";

let d1: ReturnType<typeof realSchemaD1>;
const env = () => ({ DB: d1.DB }) as never;
const MINI = "machine-mini0001";
const PINK = "machine-pink0002";
const DELL = "machine-dell0003";
const T0 = Date.parse("2026-10-17T22:37:00Z");
const at = (ms: number) => vi.spyOn(Date, "now").mockReturnValue(ms);
const errorRows = () => d1.DB.prepare("SELECT source, level, message FROM error_log ORDER BY rowid").all<{ source: string; level: string; message: string }>().then((r) => r.results ?? []);

beforeEach(async () => {
	d1 = realSchemaD1();
	d1.exec("INSERT INTO users (id, github_login) VALUES ('u1', 'serge'), ('u2', 'other')");
	for (const m of [MINI, PINK, DELL]) await setMachinePolicy(env(), "u1", m, true);
});
afterEach(() => {
	vi.restoreAllMocks();
	d1.close();
});

describe("a machine silent since an install is failed, logged and flagged (#1141)", () => {
	it("the sweep turns `installing` + 5 minutes of silence into `failed` with a reason and one error-log row", async () => {
		at(T0);
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "installing", latestVersion: "0.4.149" });
		await reportMachinePolicyStatus(env(), "u1", PINK, { status: "restarting", latestVersion: "0.4.149" });
		at(T0 + UPDATE_SILENCE_MS - 1);
		expect(await failSilentUpdates(env(), Date.now())).toBe(0);
		at(T0 + UPDATE_SILENCE_MS);
		expect(await failSilentUpdates(env(), Date.now())).toBe(2);
		const mini = await getMachinePolicy(env(), "u1", MINI);
		expect(mini).toMatchObject({ status: "failed", lastError: expect.stringMatching(new RegExp(`^${SILENT_UPDATE_ERROR} \\(0\\.4\\.149\\): the machine reported "installing"`)) });
		expect(mini.lastError).toMatch(/pags up --install-service/);
		expect(await errorRows()).toEqual([
			expect.objectContaining({ source: "runner-auto-update", level: "error" }),
			expect.objectContaining({ source: "runner-auto-update", level: "error" }),
		]);
		// Swept once: a second pass finds nothing left `installing`.
		expect(await failSilentUpdates(env(), Date.now() + 60_000)).toBe(0);
	});

	it("a machine that is still heartbeating through a long npm install is left alone", async () => {
		at(T0);
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "installing" });
		at(T0 + 4 * 60_000);
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "installing" }); // the 30s heartbeat, still installing
		expect(await failSilentUpdates(env(), T0 + 6 * 60_000)).toBe(0);
		expect((await getMachinePolicy(env(), "u1", MINI)).status).toBe("installing");
	});

	it("its own next report replaces the verdict: the machine came back", async () => {
		at(T0);
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "installing" });
		await failSilentUpdates(env(), T0 + UPDATE_SILENCE_MS);
		at(T0 + 20 * 60_000);
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "verified_success", latestVersion: "0.4.149" });
		expect(await getMachinePolicy(env(), "u1", MINI)).toMatchObject({ status: "verified_success", lastError: null });
	});

	it("auto_update_stuck says so without a live connection or the registry — the machine that cannot report", async () => {
		at(T0);
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "installing", latestVersion: "0.4.149" });
		at(T0 + UPDATE_SILENCE_MS);
		const policy = await getMachinePolicy(env(), "u1", MINI);
		expect(silentAfterInstall(policy)).toBe(true);
		const registry = vi.fn(async () => null);
		const stuck = await stuckNow({ connected: false, runnerVersion: "0.4.148" }, policy, registry);
		expect(stuck).toMatchObject({ reason: "no_heartbeat_after_install", remedy: "restart_at_machine", behind_since: new Date(T0).toISOString(), detail: expect.stringMatching(/reported installing 0\.4\.149 and has not been heard from since/) });
		expect(registry).not.toHaveBeenCalled();
		// …and still after the sweep has turned it `failed`, until the machine itself reports again.
		await failSilentUpdates(env(), Date.now());
		expect(await stuckNow({ connected: false, runnerVersion: "0.4.148" }, await getMachinePolicy(env(), "u1", MINI), registry)).toMatchObject({ reason: "no_heartbeat_after_install" });
	});

	it("an ordinary failure is not this verdict, and a policy that is OFF is never stuck", () => {
		expect(silentAfterInstall({ status: "failed", lastError: "npm ERR! 404", lastHeartbeatAt: null })).toBe(false);
		expect(assessAutoUpdateStuck({ autoUpdate: false, status: "installing", connected: false, runnerVersion: "0.4.148", reportedLatest: "0.4.149", published: null, now: T0, silentSinceInstall: true })).toBeNull();
	});
});

describe("a failure the runner reports reaches the error log once (#1141)", () => {
	it("a failed install and then a rollback: one row each, not one per heartbeat re-sending them", async () => {
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "failed", error: "npm ERR! code ETARGET" });
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "failed", error: "npm ERR! code ETARGET" });
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "failure", error: "Rolled back from 0.4.149 to 0.4.148: it crashed on start: SyntaxError." });
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "waiting_for_idle" });
		expect((await errorRows()).map((r) => [r.source, r.level, r.message])).toEqual([
			["runner-auto-update", "warn", "npm ERR! code ETARGET"],
			["runner-auto-update", "warn", "Rolled back from 0.4.149 to 0.4.148: it crashed on start: SyntaxError."],
		]);
		expect((await getMachinePolicy(env(), "u1", MINI)).lastError).toBeNull();
	});
});

describe("the fleet updates one machine at a time (#1141)", () => {
	it("a machine mid-update holds the slot for every other machine of the owner — not for other owners", async () => {
		at(T0);
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "installing", decisionAt: T0 });
		expect(await fleetUpdatingFor(env(), "u1", PINK)).toBe(1);
		expect(await fleetUpdatingFor(env(), "u1", DELL)).toBe(1);
		expect(await fleetUpdatingFor(env(), "u1", MINI)).toBe(0);
		await setMachinePolicy(env(), "u2", "machine-elsewhere", true);
		expect(await fleetUpdatingFor(env(), "u2", "machine-elsewhere")).toBe(0);
	});

	it("two that start together: only the one that began first goes ahead", async () => {
		at(T0);
		await reportMachinePolicyStatus(env(), "u1", PINK, { status: "installing", decisionAt: T0 - 1_000 });
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "installing", decisionAt: T0 });
		expect(await fleetUpdatingFor(env(), "u1", PINK)).toBe(0);
		expect(await fleetUpdatingFor(env(), "u1", MINI)).toBe(1);
	});

	it("a machine that has been silent past the slot's freshness no longer blocks the rest; a verified one never did", async () => {
		at(T0);
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "restarting" });
		expect(await fleetUpdatingFor(env(), "u1", PINK, T0 + 9 * 60_000)).toBe(1);
		expect(await fleetUpdatingFor(env(), "u1", PINK, T0 + 11 * 60_000)).toBe(0);
		await reportMachinePolicyStatus(env(), "u1", MINI, { status: "verified_success" });
		expect(await fleetUpdatingFor(env(), "u1", PINK)).toBe(0);
	});
});
