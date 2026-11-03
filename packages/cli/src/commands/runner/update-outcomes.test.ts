import { describe, expect, it, vi } from "vitest";
import { RelayMutationAdmission } from "./auto-update-controller.js";
import type { UpdateFacts, UpdatePlan } from "./self-update.js";
import { createInstallBridge, PolicyCell } from "./update-bridge.js";
import { answerPlannedUpdate } from "./update-receipt.js";

const plan: Extract<UpdatePlan, { action: "update" }> = { action: "update", current: "0.4.90", latest: "0.4.91", restarter: "pags-up" };
function harness() {
	const cell = new PolicyCell({ autoUpdate: true }, () => undefined);
	cell.authoritative = true;
	const admission = new RelayMutationAdmission();
	const deps = {
		cell, admission, refresh: vi.fn(async () => true),
		facts: vi.fn(async (): Promise<UpdateFacts> => ({ current: plan.current, latest: plan.latest, fromSource: false, restarter: plan.restarter, busy: [] })),
		install: vi.fn(async () => undefined), activate: vi.fn(), detachAll: vi.fn(),
		leaseActive: vi.fn(() => true), settle: vi.fn(async () => undefined), log: vi.fn(),
	};
	const bridge = createInstallBridge(deps);
	const gateOpen = () => { const release = admission.begin(); release?.(); return release !== null; };
	return { deps, bridge, gateOpen };
}

describe("runner update admission receipts and cleanup (#1453)", () => {
	it.each(["refresh", "facts", "settle", "install"] as const)("a rejected %s releases the single flight and admission for a successful retry", async (stage) => {
		const h = harness();
		h.deps[stage].mockRejectedValueOnce(new Error(`${stage} failed`));
		await expect(h.bridge.run(plan, true)).rejects.toThrow(`${stage} failed`);
		expect(h.bridge.inFlight()).toBe(false);
		expect(h.gateOpen()).toBe(true);
		expect(h.deps.detachAll).not.toHaveBeenCalled();
		expect(h.deps.activate).not.toHaveBeenCalled();
		expect(await h.bridge.run(plan, true)).toEqual({ kind: "restarting" });
		expect(h.deps.install).toHaveBeenCalledTimes(stage === "install" ? 2 : 1);
	});
	it("a thrown drain reopens admission and a retry reuses the prepared release", async () => {
		const h = harness();
		const drain = h.deps.admission.drain.bind(h.deps.admission);
		vi.spyOn(h.deps.admission, "drain").mockImplementationOnce(async (ms) => { await drain(ms); throw new Error("drain failed"); });
		await expect(h.bridge.run(plan)).rejects.toThrow("drain failed");
		expect(h.gateOpen()).toBe(true);
		expect(await h.bridge.run(plan)).toEqual({ kind: "restarting" });
		expect(h.deps.install).toHaveBeenCalledTimes(1);
	});
	it("work arriving during install is deferred with its real blockers and a lease, never called an in-flight install", async () => {
		const h = harness();
		h.deps.facts.mockResolvedValueOnce({ ...(await h.deps.facts()), busy: ["coding:chinese"] });
		const defer = vi.fn(() => true), restart = vi.fn();
		const deferUntil = Date.now() + 60_000;
		const reply = await answerPlannedUpdate(plan, { operationId: "op-1", deferUntil }, { run: h.bridge.run, defer, restart });
		expect(reply).toMatchObject({ status: 200, result: { action: "wait", installedVersion: plan.latest, waitingFor: ["coding:chinese"], operationId: "op-1", deferredUntil: deferUntil } });
		expect(defer).toHaveBeenCalledOnce();
		expect(restart).not.toHaveBeenCalled();
		expect(h.deps.activate).not.toHaveBeenCalled();
		expect(h.gateOpen()).toBe(true);
		expect(await h.bridge.run(plan)).toEqual({ kind: "restarting" });
		expect(h.deps.install).toHaveBeenCalledTimes(1);
	});
	it("unobservable work without a lease does not claim a delayed restart", async () => {
		const h = harness();
		h.deps.facts.mockResolvedValueOnce({ ...(await h.deps.facts()), busy: ["runner-work-observation-unavailable"] });
		const defer = vi.fn(), restart = vi.fn();
		const reply = await answerPlannedUpdate(plan, undefined, { run: h.bridge.run, defer, restart });
		expect(reply).toMatchObject({ status: 400, result: { installedVersion: plan.latest, waitingFor: ["runner-work-observation-unavailable"], error: expect.stringContaining("no delayed restart was scheduled") } });
		expect(defer).not.toHaveBeenCalled();
		expect(restart).not.toHaveBeenCalled();
	});
	it("only an actual concurrent install receives the in-flight conflict receipt", async () => {
		const h = harness();
		let finish!: () => void;
		h.deps.install.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
		const first = h.bridge.run(plan);
		const restart = vi.fn();
		expect(await answerPlannedUpdate(plan, undefined, { run: h.bridge.run, defer: vi.fn(), restart })).toMatchObject({ status: 409, result: { error: "A runner update is already installing or restarting." } });
		finish();
		expect(await first).toEqual({ kind: "restarting" });
		expect(restart).not.toHaveBeenCalled();
	});
	it("lease expiry during the final work look refuses without activation or restart", async () => {
		const h = harness();
		h.deps.facts.mockImplementationOnce(async () => { h.deps.leaseActive.mockReturnValue(false); return { current: plan.current, latest: plan.latest, fromSource: false, restarter: plan.restarter, busy: [] }; });
		const restart = vi.fn(), defer = vi.fn();
		const reply = await answerPlannedUpdate(plan, { operationId: "op-1", deferUntil: Date.now() + 60_000 }, { run: h.bridge.run, defer, restart });
		expect(reply).toMatchObject({ status: 200, result: { action: "refused", installedVersion: plan.latest, reason: expect.stringContaining("lease expired") } });
		expect(h.deps.activate).not.toHaveBeenCalled();
		expect(restart).not.toHaveBeenCalled();
		expect(defer).not.toHaveBeenCalled();
		expect(h.gateOpen()).toBe(true);
	});
	it.each(["policy-disabled", "policy-unavailable", "fleet-updating"] as const)("%s is distinguishable from another installer", async (kind) => {
		const h = harness();
		if (kind === "policy-disabled") h.deps.cell.policy.autoUpdate = false;
		if (kind === "policy-unavailable") h.deps.refresh.mockResolvedValue(false);
		if (kind === "fleet-updating") h.deps.cell.policy.fleetUpdating = 1;
		expect(await h.bridge.run(plan, true)).toEqual({ kind, installedVersion: null });
		expect(h.deps.install).not.toHaveBeenCalled();
		expect(h.bridge.inFlight()).toBe(false);
	});
	it("an already expired operation cannot fall back to an unleased immediate restart", async () => {
		const h = harness(), restart = vi.fn();
		expect(await answerPlannedUpdate(plan, { operationId: "op-1", deferUntil: Date.now() - 1 }, { run: h.bridge.run, defer: vi.fn(), restart })).toMatchObject({ status: 200, result: { action: "refused", reason: expect.stringContaining("expired or invalid") } });
		expect(h.deps.install).not.toHaveBeenCalled();
		expect(restart).not.toHaveBeenCalled();
	});
	it("a successful machine receipt schedules the exit once", async () => {
		const h = harness(), restart = vi.fn();
		expect(await answerPlannedUpdate(plan, undefined, { run: h.bridge.run, defer: vi.fn(), restart })).toMatchObject({ status: 200, result: { action: "restarting", latest: plan.latest } });
		expect(restart).toHaveBeenCalledExactlyOnceWith(plan);
		expect(h.gateOpen()).toBe(false);
	});
});
