/**
 * A late policy echo never regresses what the controller verified (#1020).
 *
 * Composition: the REAL `AutomaticUpdateController` and the REAL `acceptPolicyResponse` (what relay.ts calls
 * on every registration/heartbeat response), wired the way relay.ts wires them — authority cleared before a
 * refresh, `cancel` on an owner OFF, `start` on a first confirmation, nothing scheduled while refreshing. The
 * service is synthetic and mirrors the API contract (workers/api/src/routes/instances.ts): it stores the
 * status a request reports and answers with the stored policy — so a response echoes the status as of when
 * its request was SENT. Each response is held until the test delivers it: delivery order is the variable.
 * Fake clock and timers; nothing touches npm, a process or the network.
 */
import { describe, expect, it } from "vitest";
import { AutomaticUpdateController } from "./auto-update-controller.js";
import { acceptPolicyResponse, autoUpdateStatusWire, type AutoUpdatePolicy } from "./auto-update.js";
import type { UpdateFacts, UpdatePlan } from "./self-update.js";

type QueuedTimer = { fn: () => void; ms: number; unref(): void };

/** The service side: owner switch + the last reported status, answered as the API answers. */
function service(initial: { autoUpdate: boolean; status: string }) {
	const s = {
		...initial,
		receive(report: { status?: string }) {
			if (report.status) s.status = report.status;
			return { success: true, autoUpdatePolicy: { autoUpdate: s.autoUpdate, status: s.status } };
		},
		/** The owner's set_machine_policy, as setMachinePolicy writes it. */
		owner(on: boolean) {
			s.autoUpdate = on;
			s.status = on ? (s.status === "disabled" ? "enabled" : s.status) : "disabled";
		},
	};
	return s;
}

function runner(opts: { cached: AutoUpdatePolicy; svc: ReturnType<typeof service>; facts?: () => Promise<UpdateFacts>; plan?: (f: UpdateFacts) => UpdatePlan; install?: () => Promise<boolean> }) {
	const timers: QueuedTimer[] = [];
	const clock = { t: 1_000_000 };
	const cell = { policy: { ...opts.cached }, authoritative: false, refreshing: false };
	const installs: number[] = [];
	let controller: AutomaticUpdateController;
	// relay.ts acceptAutoUpdatePolicy, with its production merge.
	const accept = (response: unknown) => {
		const accepted = acceptPolicyResponse(cell.policy, cell.authoritative, response);
		if (!accepted) return;
		cell.policy = accepted.policy;
		cell.authoritative = true;
		if (accepted.action === "cancel") return controller.onPolicy("cancel");
		if (cell.refreshing) return;
		if (accepted.action === "start") controller.onPolicy("start");
	};
	/** A registration or heartbeat: its body is built NOW, its response is delivered when the test says. */
	const send = () => {
		const response = opts.svc.receive({ status: autoUpdateStatusWire(cell.policy.status) });
		return { deliver: () => accept(response) };
	};
	controller = new AutomaticUpdateController({
		policy: () => ({ value: cell.policy, authoritative: cell.authoritative }),
		// relay.ts refreshAutomaticPolicy: authority cleared, one registration, answered in order.
		refreshPolicy: async () => {
			cell.authoritative = false;
			cell.refreshing = true;
			try {
				send().deliver();
				return cell.authoritative;
			} finally {
				cell.refreshing = false;
			}
		},
		facts: opts.facts ?? (async () => ({ current: "0.4.99", latest: "0.4.99", fromSource: false, restarter: "pags-up", busy: [] })),
		plan: opts.plan ?? ((f) => (f.current === f.latest ? { action: "up-to-date", current: f.current } : { action: "update", current: f.current, latest: f.latest ?? "", restarter: "pags-up" })),
		installAndRestart: async () => {
			installs.push(clock.t);
			return (opts.install ?? (async () => true))();
		},
		// relay.ts saveAutoUpdateStatus
		status: (status, extra = {}) => {
			cell.policy = { ...cell.policy, ...extra, status, lastAttemptAt: new Date(clock.t).toISOString() };
		},
		setTimer: (fn, ms) => {
			const timer: QueuedTimer = { fn, ms, unref() {} };
			timers.push(timer);
			return timer as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (timer) => {
			const i = timers.indexOf(timer as unknown as QueuedTimer);
			if (i >= 0) timers.splice(i, 1);
		},
		random: () => 0,
		now: () => clock.t,
	});
	/** Fire the next due timer and let its async work settle. */
	const fire = async () => {
		const t = timers.shift();
		if (!t) throw new Error("no timer armed");
		clock.t += t.ms;
		t.fn();
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
	};
	return { cell, controller, timers, send, fire, installs, clock };
}

/** The process after a successful automatic install: its cache still says `restarting`, the release is now current. */
const afterRestart = () => ({ autoUpdate: true, status: "restarting" as const, latestVersion: "0.4.99" });

describe("a late policy echo never regresses the controller's verified state (#1020)", () => {
	it("restart recovery: a registration sent while `restarting`, delivered AFTER verified-success, does not regress it — and the next report carries verified_success", async () => {
		const svc = service({ autoUpdate: true, status: "restarting" });
		const r = runner({ cached: afterRestart(), svc });
		r.send().deliver(); // startup registration confirms ON → first check armed
		expect(r.timers).toHaveLength(1);
		const late = r.send(); // a heartbeat leaves while the record still says `restarting`
		await r.fire(); // versioned reconnect on the latest release: the controller verifies
		expect(r.cell.policy.status).toBe("verified-success");
		late.deliver(); // …and that heartbeat's echo arrives afterwards
		expect(r.cell.policy.status).toBe("verified-success");
		r.send().deliver(); // the next heartbeat reports what is true
		expect(svc.status).toBe("verified_success");
		expect(r.installs).toEqual([]);
	});

	it("healthy reattachment of several agents, each echoing an older status in any order, keeps verified_success", async () => {
		const svc = service({ autoUpdate: true, status: "restarting" });
		const r = runner({ cached: afterRestart(), svc });
		r.send().deliver();
		const inFlight = [r.send(), r.send(), r.send()]; // three agents re-registering while `restarting`
		await r.fire();
		for (const req of [inFlight[2], inFlight[0], inFlight[1]]) req.deliver();
		expect(r.cell.policy.status).toBe("verified-success");
		r.send().deliver();
		expect(svc.status).toBe("verified_success");
	});

	it("concurrent registration, heartbeat and policy refresh around one decision: the refresh's own answer and the stale echoes leave the decision standing", async () => {
		const svc = service({ autoUpdate: true, status: "restarting" });
		const r = runner({ cached: afterRestart(), svc });
		r.send().deliver();
		const registration = r.send();
		const heartbeat = r.send();
		await r.fire(); // runNow → refreshPolicy (answered in order) → decide → verified-success
		heartbeat.deliver();
		registration.deliver();
		expect(r.cell.authoritative).toBe(true);
		expect(r.cell.policy.status).toBe("verified-success");
	});

	it("ON→ON keep: repeated echoes neither move the armed timer nor touch the controller's status", async () => {
		const svc = service({ autoUpdate: true, status: "waiting_for_idle" });
		const r = runner({ cached: { autoUpdate: true, status: "verified-success" }, svc });
		r.send().deliver();
		const armed = r.timers[0];
		for (let i = 0; i < 50; i++) r.send().deliver();
		expect(r.timers).toEqual([armed]);
		expect(r.cell.policy.status).toBe("verified-success");
	});

	it("the owner's switch always wins: OFF cancels the pending check, installs nothing, and adopts the service's record; ON from OFF starts again", async () => {
		const svc = service({ autoUpdate: true, status: "verified_success" });
		const r = runner({ cached: { autoUpdate: true, status: "verified-success" }, svc, facts: async () => ({ current: "0.4.98", latest: "0.4.99", fromSource: false, restarter: "pags-up", busy: [] }) });
		r.send().deliver();
		expect(r.timers).toHaveLength(1);
		svc.owner(false);
		r.send().deliver();
		expect(r.cell.policy.autoUpdate).toBe(false);
		expect(r.timers).toHaveLength(0);
		expect(r.installs).toEqual([]);
		svc.owner(true);
		r.send().deliver();
		expect(r.cell.policy.autoUpdate).toBe(true);
		expect(r.timers).toHaveLength(1);
	});

	it("a stale ON echo arriving after the owner's OFF cannot re-enable: the next answer is the owner's OFF", async () => {
		const svc = service({ autoUpdate: true, status: "verified_success" });
		const r = runner({ cached: { autoUpdate: true, status: "verified-success" }, svc });
		r.send().deliver();
		const staleOn = r.send();
		svc.owner(false);
		r.send().deliver(); // OFF arrives first
		staleOn.deliver(); // the older ON arrives late
		// The switch is the service's: a late ON is a real ON transition to this runner and is re-confirmed by
		// the next answer — which is OFF. No install can run in between: none was due and none ran.
		r.send().deliver();
		expect(r.cell.policy.autoUpdate).toBe(false);
		expect(r.timers).toHaveLength(0);
		expect(r.installs).toEqual([]);
	});

	it("failed facts: the controller's `failure` is reported and kept, never overwritten by an older echo; the bounded retry stays armed", async () => {
		const svc = service({ autoUpdate: true, status: "restarting" });
		const r = runner({ cached: afterRestart(), svc, facts: async () => { throw new Error("local runner did not answer /health"); } });
		r.send().deliver();
		const late = r.send();
		await r.fire();
		expect(r.cell.policy.status).toBe("failure");
		late.deliver();
		expect(r.cell.policy.status).toBe("failure");
		expect(r.timers).toHaveLength(1);
		expect(r.installs).toEqual([]);
	});

	it("hung facts: no decision, no install, and echoes leave the last recorded status alone", async () => {
		const svc = service({ autoUpdate: true, status: "restarting" });
		const r = runner({ cached: afterRestart(), svc, facts: () => new Promise<UpdateFacts>(() => undefined) });
		r.send().deliver();
		await r.fire();
		for (let i = 0; i < 5; i++) r.send().deliver();
		expect(r.cell.policy.status).toBe("restarting"); // nothing verified it, so nothing claims it
		expect(r.installs).toEqual([]);
	});

	it("a real update still runs once and records restarting; the single-flight install guard holds", async () => {
		const svc = service({ autoUpdate: true, status: "enabled" });
		let release!: (v: boolean) => void;
		const r = runner({
			cached: { autoUpdate: true },
			svc,
			facts: async () => ({ current: "0.4.98", latest: "0.4.99", fromSource: false, restarter: "pags-up", busy: [] }),
			install: () => new Promise<boolean>((res) => { release = res; }),
		});
		r.send().deliver();
		await r.fire();
		expect(r.installs).toHaveLength(1);
		expect(await r.controller.installManually({ action: "update", current: "0.4.98", latest: "0.4.99", restarter: "pags-up" })).toBe(false);
		const late = r.send();
		release(true);
		await new Promise((res) => setTimeout(res, 0));
		expect(r.cell.policy.status).toBe("restarting");
		late.deliver();
		expect(r.cell.policy.status).toBe("restarting");
		expect(r.installs).toHaveLength(1);
	});
});

describe("acceptPolicyResponse — the merge relay.ts runs on every response (#1020)", () => {
	const local: AutoUpdatePolicy = { autoUpdate: true, status: "verified-success", latestVersion: "0.4.99" };
	it("ON→ON takes only the switch", () => {
		expect(acceptPolicyResponse(local, true, { autoUpdatePolicy: { autoUpdate: true, status: "restarting", latestVersion: "0.4.98" } })).toEqual({ policy: local, action: "keep" });
	});
	it("the first confirmation after a restart (not yet authoritative, still ON) also keeps the local lifecycle", () => {
		expect(acceptPolicyResponse(local, false, { autoUpdatePolicy: { autoUpdate: true, status: "restarting" } })).toEqual({ policy: local, action: "start" });
	});
	it("OFF is an owner transition: the service's record is adopted", () => {
		expect(acceptPolicyResponse(local, true, { autoUpdatePolicy: { autoUpdate: false, status: "disabled" } })?.policy.autoUpdate).toBe(false);
	});
	it("ON from OFF is an owner transition: the service's status is adopted", () => {
		expect(acceptPolicyResponse({ autoUpdate: false, status: "verified-success" }, true, { autoUpdatePolicy: { autoUpdate: true, status: "enabled" } })).toEqual({ policy: { autoUpdate: true, status: "enabled" }, action: "start" });
	});
	it("a response with no policy changes nothing", () => {
		expect(acceptPolicyResponse(local, true, { success: true })).toBeNull();
	});
});
