/**
 * #1169 — one hung local request used to hold the update drain open forever: no restart, every new mutation refused with 503,
 * and `runner_restart` refusing too. The drain is now bounded, a relayed command's wait on the runtime is bounded, and a
 * forced `runner_restart` goes past an in-flight install.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayMutationAdmission } from "./auto-update-controller.js";
import { openRelaySocket, relayLimits } from "./relay.js";
import { restartBlockedByInstall, type UpdatePlan } from "./self-update.js";
import { BoundExpired, createInstallBridge, DEFAULT_DRAIN_MS, PolicyCell } from "./update-bridge.js";

vi.mock("../../output.js", () => ({ writeLine: () => undefined, writeError: () => undefined }));

const plan: Extract<UpdatePlan, { action: "update" }> = { action: "update", current: "0.4.90", latest: "0.4.91", restarter: "pags-up" };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function bridgeOn(admission: RelayMutationAdmission, drainMs = 5_000) {
	const cell = new PolicyCell({ autoUpdate: true }, () => undefined);
	cell.authoritative = true;
	const install = vi.fn(async () => undefined);
	const detachAll = vi.fn();
	const facts = vi.fn(async () => ({ current: "0.4.90", latest: "0.4.91", fromSource: false, restarter: "pags-up" as const, busy: [], observations: [{ source: "sessions", success: true, sampledAt: 1 }, { source: "health", success: true, sampledAt: 1 }] }));
	const bridge = createInstallBridge({ cell, refresh: async () => true, facts, install, admission, leaseActive: () => true, detachAll, log: () => undefined, settle: async () => undefined, drainMs });
	return { bridge, install, detachAll, facts };
}

describe("the mutation drain is bounded (#1169)", () => {
	it("admission.drain(maxMs) resolves false when a request is still running, keeps the gate closed until resumed, and reports how many", async () => {
		const admission = new RelayMutationAdmission();
		const release = admission.begin();
		const drain = admission.drain(1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await drain).toBe(false);
		expect(admission.pending()).toBe(1);
		expect(admission.begin()).toBeNull(); // still draining until the caller decides
		admission.resume();
		expect(admission.begin()).not.toBeNull();
		release?.();
	});

	it("resolves true as soon as the work settles, and a settled wait leaves no timer behind", async () => {
		const admission = new RelayMutationAdmission();
		const release = admission.begin();
		const drain = admission.drain(60_000);
		release?.();
		expect(await drain).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		expect(await new RelayMutationAdmission().drain(1)).toBe(true);
	});

	it("a hung request makes the install bridge give up: gate reopened, single flight released, npm result kept, nothing restarted", async () => {
		const admission = new RelayMutationAdmission();
		admission.begin(); // a wedged request that never settles
		const { bridge, install, detachAll } = bridgeOn(admission, 5_000);
		const run = bridge.run(plan, false).catch((e) => e);
		await vi.advanceTimersByTimeAsync(5_000);
		const error = await run;
		expect(error).toBeInstanceOf(BoundExpired);
		expect((error as Error).message).toMatch(/1 local request is still running after 5s/);
		expect((error as Error).message).toMatch(/forced runner_restart/);
		expect(detachAll).not.toHaveBeenCalled();
		expect(bridge.inFlight()).toBe(false);
		expect(bridge.installedPendingRestart()).toBe("0.4.91");
		expect(admission.begin()).not.toBeNull(); // the machine accepts work again instead of refusing every mutation
		// the retry does not run npm again
		admission.pending();
		const retry = bridge.run(plan, false).catch((e) => e);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await retry).toBeInstanceOf(BoundExpired);
		expect(install).toHaveBeenCalledTimes(1);
	});

	it("when the request settles in time, the update proceeds to restart as before", async () => {
		const admission = new RelayMutationAdmission();
		const release = admission.begin();
		const { bridge, detachAll } = bridgeOn(admission, 5_000);
		const run = bridge.run(plan, false);
		await vi.advanceTimersByTimeAsync(1_000);
		release?.();
		expect(await run).toBe(true);
		expect(detachAll).toHaveBeenCalled();
	});

	it("the default bound is finite", () => {
		expect(DEFAULT_DRAIN_MS).toBeGreaterThan(0);
		expect(Number.isFinite(DEFAULT_DRAIN_MS)).toBe(true);
	});
});

class FakeSocket {
	static last: FakeSocket;
	sent: string[] = [];
	onopen?: (() => void) | null;
	onmessage?: ((e: { data: string }) => Promise<void>) | null;
	onclose?: ((e: { code: number; reason: string }) => void) | null;
	onerror?: (() => void) | null;
	constructor(public url: string) {
		FakeSocket.last = this;
	}
	send(d: string) {
		this.sent.push(d);
	}
	close() {}
}

describe("a relayed command's wait on the local runtime is bounded (#1169)", () => {
	it("a hung runtime answers 504 after the limit and releases its mutation slot, so the drain can finish", async () => {
		vi.useRealTimers(); // AbortSignal.timeout runs on the platform's clock, not the fake one
		vi.stubGlobal("WebSocket", FakeSocket);
		let signalSeen: AbortSignal | undefined;
		vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
			signalSeen = init.signal ?? undefined;
			return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
		});
		const previous = relayLimits.forwardMs;
		relayLimits.forwardMs = 60;
		try {
			const admission = new RelayMutationAdmission();
			const handle = openRelaySocket("inst-1", "wss://api.test", async () => "t", "http://127.0.0.1:9", "rt", false, undefined, undefined, undefined, undefined, () => admission.begin());
			await vi.waitFor(() => expect(FakeSocket.last?.onmessage).toBeDefined());
			const ws = FakeSocket.last;
			const pending = ws.onmessage?.({ data: JSON.stringify({ id: "hung-1", method: "POST", path: "/coding/run", body: {} }) });
			await vi.waitFor(() => expect(admission.pending()).toBe(1));
			expect(signalSeen).toBeInstanceOf(AbortSignal);
			const drained = await admission.drain(2_000);
			await pending;
			expect(drained).toBe(true);
			expect(admission.pending()).toBe(0);
			expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({ id: "hung-1", status: 504, error: expect.stringContaining("did not answer within") });
			handle.close();
		} finally {
			relayLimits.forwardMs = previous;
		}
	});
});

describe("runner_restart with force goes past an in-flight install (#1169)", () => {
	it("an unforced restart is refused while an install is in flight; a forced one is not", () => {
		expect(restartBlockedByInstall(true, false)).toMatch(/Pass force/);
		expect(restartBlockedByInstall(true, true)).toBeNull();
		expect(restartBlockedByInstall(false, false)).toBeNull();
		expect(restartBlockedByInstall(false, true)).toBeNull();
	});
});
