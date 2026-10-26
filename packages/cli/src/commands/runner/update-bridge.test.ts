/**
 * #1020 acceptance A and B, through the production modules: the paired look over REAL HTTP (a throwaway local server
 * answered through `requestRunner` / `requestPags`), the persisted recovery cycle through the REAL cache file read
 * back by a second policy cell (a synthetic restarted process), and the install bridge with every wait bounded on an
 * injected timer. All inert: no npm, no restart, no live service, no machine diagnostics.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomaticUpdateController, boundedWork, OBSERVATION_TIMEOUT_MS, RelayMutationAdmission, updateVerdict } from "./auto-update-controller.js";
import { type AutoUpdatePolicy, type AutoUpdateStatus, loadAutoUpdatePolicy, nextAutoUpdateDelayMs, saveAutoUpdatePolicy } from "./auto-update.js";
import { requestPags, requestRunner } from "./http.js";
import { observedRunnerWork, readWorkLook } from "./runner-work-observation.js";
import { planRunnerUpdate, type UpdateFacts, type UpdatePlan } from "./self-update.js";
import { BoundExpired, createInstallBridge, createPolicyChannel, PolicyCell } from "./update-bridge.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

/** A throwaway local HTTP server; `handle` may leave a request unanswered (a hung peer). */
async function serve(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; hits: string[] }> {
	const hits: string[] = [];
	const open = new Set<import("node:net").Socket>();
	const server: Server = createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		handle(req, res);
	});
	server.on("connection", (s) => {
		open.add(s);
		s.on("close", () => open.delete(s));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	cleanups.push(() => new Promise<void>((r) => {
		for (const s of open) s.destroy();
		server.close(() => r());
	}));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}
const json = (res: ServerResponse, body: unknown, status = 200) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};
const ids = (n: number) => Array.from({ length: n }, (_, i) => `agent-${String(i + 1).padStart(2, "0")}`);
const AT = "2026-10-12T00:00:00.000Z";
const cycle = (target: string, attachments: string[]) => ({ target, attachments, at: AT });

/** The look the relay takes, over real HTTP against `url`. */
async function look(url: string) {
	const opts = { url, token: "inert", instanceId: "i1" };
	const [sessions, health] = await Promise.allSettled([
		requestRunner<{ sessions?: unknown }>("GET", "/coding/sessions", opts),
		requestRunner<{ work?: unknown }>("GET", "/health", opts),
	]);
	return { sessions, health, ...readWorkLook(sessions, health, 1) };
}
const factsFrom = (l: { busy: string[]; observations: UpdateFacts["observations"] }, current = "0.4.91"): UpdateFacts => ({ current, latest: "0.4.91", fromSource: false, restarter: "pags-up", busy: l.busy, observations: l.observations });

// ── A1: one reading of an HTTP-200 answer — guard, observation flag and verdict agree ────────────────────────────

describe("A1 — a malformed HTTP 200 body is never a healthy look (#1020)", () => {
	const valid = { work: { codingTurns: 0, localRuns: 0, detail: [] } };
	const bad: Array<[string, unknown]> = [
		["no work at all", {}],
		["work: {}", { work: {} }],
		["work: []", { work: [] }],
		["non-integer codingTurns", { work: { codingTurns: 1.5, localRuns: 0, detail: [] } }],
		["string codingTurns", { work: { codingTurns: "0", localRuns: 0, detail: [] } }],
		["negative localRuns", { work: { codingTurns: 0, localRuns: -1, detail: [] } }],
		["non-string detail", { work: { codingTurns: 0, localRuns: 0, detail: [1] } }],
		["missing detail", { work: { codingTurns: 0, localRuns: 0 } }],
	];
	const recovered: AutoUpdatePolicy = { autoUpdate: true, recovery: cycle("0.4.91", ids(2)) };

	it.each(bad)("health %s: guard unavailable, flag malformed (not failed), verdict never verified", async (_l, body) => {
		const { url } = await serve((req, res) => json(res, req.url === "/health" ? body : { sessions: [] }));
		const l = await look(url);
		expect(l.health.status).toBe("fulfilled"); // it really was an HTTP 200
		expect(l.busy).toEqual(["runner-work-observation-unavailable"]);
		expect(observedRunnerWork({ sessions: [], work: (body as { work?: never }).work })).toEqual(["runner-work-observation-unavailable"]);
		expect(l.observations?.find((o) => o.source === "health")).toMatchObject({ success: false, malformed: true });
		const v = updateVerdict(recovered, factsFrom(l), ids(2));
		expect(v).toMatchObject({ kind: "unverified", reason: expect.stringContaining("health malformed") });
	});

	it("a malformed sessions list (an object, not a list) is the same: unavailable, malformed, unverified", async () => {
		const { url } = await serve((req, res) => json(res, req.url === "/health" ? valid : { sessions: {} }));
		const l = await look(url);
		expect(l.busy).toEqual(["runner-work-observation-unavailable"]);
		expect(l.observations?.find((o) => o.source === "sessions")).toMatchObject({ success: false, malformed: true });
		expect(updateVerdict(recovered, factsFrom(l), ids(2))).toMatchObject({ kind: "unverified", reason: expect.stringContaining("sessions malformed") });
	});

	it("CONTROL: a request that FAILS (HTTP 500) is `failed`, distinct from malformed", async () => {
		const { url } = await serve((req, res) => (req.url === "/health" ? json(res, { error: "boom" }, 500) : json(res, { sessions: [] })));
		const l = await look(url);
		expect(l.observations?.find((o) => o.source === "health")).toEqual({ source: "health", success: false, sampledAt: 1 });
		expect(updateVerdict(recovered, factsFrom(l), ids(2))).toMatchObject({ kind: "unverified", reason: expect.stringContaining("health failed") });
	});

	it("CONTROL: a valid paired look with every original agent back verifies", async () => {
		const { url } = await serve((req, res) => json(res, req.url === "/health" ? valid : { sessions: [] }));
		const l = await look(url);
		expect(l.busy).toEqual([]);
		expect(updateVerdict(recovered, factsFrom(l), ids(2))).toEqual({ kind: "verified" });
	});
});

// ── A2–A4: the persisted recovery cycle, across a synthetic process restart ────────────────────────────────────────

const healthy = (current = "0.4.91", latest = "0.4.91"): UpdateFacts => ({
	current,
	latest,
	fromSource: false,
	restarter: "pags-up",
	busy: [],
	observations: [
		{ source: "sessions", success: true, sampledAt: 1 },
		{ source: "health", success: true, sampledAt: 1 },
	],
});

/** A real cache file and a cell bound to it — `restart()` builds a NEW cell from what the file holds. */
function machine() {
	const dir = mkdtempSync(join(tmpdir(), "pags-update-cycle-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const env = { PAGS_AUTO_UPDATE_POLICY_FILE: join(dir, "auto-update.json") } as NodeJS.ProcessEnv;
	const key = "default:machine-1";
	const process = () => {
		const cell = new PolicyCell(loadAutoUpdatePolicy(key, env) ?? { autoUpdate: true }, (p) => saveAutoUpdatePolicy(key, p, env));
		cell.authoritative = true;
		cell.policy = { ...cell.policy, autoUpdate: true };
		return cell;
	};
	return { env, key, file: env.PAGS_AUTO_UPDATE_POLICY_FILE as string, process, disk: () => loadAutoUpdatePolicy(key, env) };
}

function controllerOn(cell: PolicyCell, o: { facts: () => Promise<UpdateFacts>; attached: () => string[]; shouldHold?: () => ReadonlySet<string> | null; refresh?: () => Promise<boolean>; install?: (plan: Extract<UpdatePlan, { action: "update" }>, automatic: boolean) => Promise<boolean> }) {
	const timers: Array<{ fn: () => void; ms: number }> = [];
	const clock = { t: 5_000_000 };
	const controller = new AutomaticUpdateController({
		policy: () => ({ value: cell.policy, authoritative: cell.authoritative }),
		refreshPolicy: o.refresh ?? (async () => true),
		facts: o.facts,
		plan: planRunnerUpdate,
		installAndRestart: o.install ?? (async () => true),
		status: (s: AutoUpdateStatus, e?: Partial<AutoUpdatePolicy>) => cell.record(s, e),
		attachments: o.attached,
		shouldHold: o.shouldHold,
		setTimer: (fn, ms) => {
			const t = { fn, ms, unref() {} };
			timers.push(t);
			return t as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: () => undefined,
		random: () => 0,
		now: () => clock.t,
	});
	return { controller, timers, clock };
}

describe("A2–A4 — a recovery cycle is persisted, survives failures, and needs every original agent back (#1020)", () => {
	it.each([0, 1, 13])("%i of 14 original agents re-attached: not verified, and the cycle is kept", async (back) => {
		const m = machine();
		const cell = m.process();
		cell.record("restarting", { latestVersion: "0.4.91", recovery: cycle("0.4.91", ids(14)) });
		const { controller } = controllerOn(cell, { facts: async () => healthy(), attached: () => ids(14).slice(0, back) });
		await controller.runNow();
		expect(cell.policy).toMatchObject({ status: "failure", reason: expect.stringContaining(`only ${back} of its 14 original agents`) });
		expect(m.disk()?.recovery).toEqual(cycle("0.4.91", ids(14)));
	});

	it("CONTROL: all 14 back verifies, and the verified cycle is kept as terminal evidence", async () => {
		const m = machine();
		const cell = m.process();
		cell.record("restarting", { latestVersion: "0.4.91", recovery: cycle("0.4.91", ids(14)) });
		const { controller } = controllerOn(cell, { facts: async () => healthy(), attached: () => ids(14) });
		await controller.runNow();
		expect(m.disk()).toMatchObject({ status: "verified-success" });
		expect(m.disk()?.recovery).toMatchObject({ target: "0.4.91", attachments: ids(14), verifiedAt: expect.any(String) });
	});

	it("across a restart, through failure and offline checks: the retry never forgets its target or its agents", async () => {
		const m = machine();
		// Process A: installs 0.4.91 holding 14 agents; the cycle is written BEFORE npm runs.
		const a = m.process();
		const procA = controllerOn(a, { facts: async () => healthy("0.4.90", "0.4.91"), attached: () => ids(14) });
		await procA.controller.runNow();
		expect(m.disk()).toMatchObject({ status: "restarting", recovery: { target: "0.4.91", attachments: ids(14) } });
		// Process B: a NEW cell read from the file. Its first check fails, the next cannot reach the owner policy.
		const b = m.process();
		let failing = true;
		let online = true;
		const procB = controllerOn(b, {
			facts: async () => {
				if (failing) throw new Error("the local runtime is still starting");
				return healthy();
			},
			attached: () => ids(14),
			refresh: async () => online,
		});
		await procB.controller.runNow();
		expect(m.disk()).toMatchObject({ status: "failure", recovery: { target: "0.4.91", attachments: ids(14) } });
		failing = false;
		online = false;
		await procB.controller.runNow();
		expect(m.disk()).toMatchObject({ status: "offline", recovery: { target: "0.4.91", attachments: ids(14) } });
		expect(procB.controller.diagnostics().checkAt).toBe(procB.clock.t); // B4: the failed refresh IS a check
		online = true;
		await procB.controller.runNow();
		expect(m.disk()?.status).toBe("verified-success");
		expect(m.disk()?.recovery).toMatchObject({ target: "0.4.91", attachments: ids(14), verifiedAt: expect.any(String) });
		// The NEXT ordinary check keeps the verified evidence: status and record, unchanged.
		const evidence = m.disk()?.recovery;
		await procB.controller.runNow();
		expect(m.disk()?.status).toBe("verified-success");
		expect(m.disk()?.recovery).toEqual(evidence);
	});

	it("A4: an older runner's cache (an attempt status, no recovery record) is unknown — never verified, never ordinary", async () => {
		const m = machine();
		writeFileSync(m.file, JSON.stringify({ v: 1, policies: { [m.key]: { autoUpdate: true, status: "restarting", latestVersion: "0.4.91" } } }));
		const cell = m.process();
		const { controller } = controllerOn(cell, { facts: async () => healthy(), attached: () => ids(3) });
		await controller.runNow();
		expect(cell.policy).toMatchObject({ status: "enabled", reason: expect.stringContaining("older runner") });
		const fresh = machine().process();
		const ordinary = controllerOn(fresh, { facts: async () => healthy(), attached: () => [] });
		await ordinary.controller.runNow();
		expect(fresh.policy.status).toBe("enabled");
		expect(fresh.policy.reason).toBeUndefined();
	});

	it("the service can neither inject a recovery cycle nor keep one past the owner's OFF", () => {
		const m = machine();
		const cell = m.process();
		cell.accept({ autoUpdatePolicy: { autoUpdate: true, recovery: cycle("9.9.9", ["evil"]) } }, cell.next());
		expect(cell.policy.recovery).toBeUndefined();
		cell.record("restarting", { recovery: cycle("0.4.91", ids(2)) });
		cell.accept({ autoUpdatePolicy: { autoUpdate: false, status: "disabled" } }, cell.next());
		expect(cell.policy.autoUpdate).toBe(false);
		expect(m.disk()?.recovery).toBeUndefined();
	});
});

// ── B: every bridge wait is bounded, the policy channel keeps its registration, the fence validates first ─────────

const plan: Extract<UpdatePlan, { action: "update" }> = { action: "update", current: "0.4.90", latest: "0.4.91", restarter: "pags-up" };

function bridgeHarness() {
	const bounds: Array<{ fn: () => void; ms: number }> = [];
	const cell = new PolicyCell({ autoUpdate: true }, () => undefined);
	cell.authoritative = true;
	const admission = new RelayMutationAdmission();
	const hang = { pre: false, post: false, facts: false };
	const late: Array<() => void> = [];
	let refreshes = 0;
	const refresh = vi.fn(async () => {
		const which = refreshes++ % 2 === 0 ? "pre" : "post";
		if (hang[which]) return new Promise<boolean>((r) => late.push(() => r(true)));
		return true;
	});
	const facts = vi.fn(async (): Promise<UpdateFacts> => {
		if (hang.facts) return new Promise<UpdateFacts>((r) => late.push(() => r(healthy("0.4.90"))));
		return healthy("0.4.90");
	});
	const install = vi.fn(async () => undefined);
	const activate = vi.fn();
	const detachAll = vi.fn();
	const bridge = createInstallBridge({
		cell,
		refresh,
		facts,
		install,
		activate,
		admission,
		leaseActive: () => true,
		detachAll,
		log: () => undefined,
		settle: async () => undefined,
		bound: {
			timer: (fn, ms) => {
				const t = { fn, ms, unref() {} };
				bounds.push(t);
				return t as unknown as ReturnType<typeof setTimeout>;
			},
			clear: (t) => {
				const i = bounds.indexOf(t as unknown as (typeof bounds)[number]);
				if (i >= 0) bounds.splice(i, 1);
			},
		},
	});
	const expireWhen = async (ready: () => boolean) => {
		await vi.waitFor(() => expect(ready()).toBe(true));
		const b = bounds.shift();
		expect(b?.ms).toBe(OBSERVATION_TIMEOUT_MS);
		b?.fn();
	};
	const gateOpen = () => {
		const done = admission.begin();
		done?.();
		return done !== null;
	};
	return { bridge, cell, hang, late, refresh, facts, install, activate, detachAll, expireWhen, gateOpen, bounds };
}

describe("B1 — every install/restart bridge wait is bounded (#1020)", () => {
	it.each([
		["the policy refresh BEFORE npm", "pre", 0],
		["the policy refresh AFTER npm", "post", 1],
		["the final local work look", "facts", 1],
	] as const)("%s hangs: BoundExpired, single flight released, gate open, no restart, late answer inert, retry restarts once", async (_l, stage, npmBefore) => {
		const h = bridgeHarness();
		h.hang[stage] = true;
		const run = h.bridge.run(plan, true);
		await h.expireWhen(() => (stage === "facts" ? h.facts.mock.calls.length === 1 : stage === "post" ? h.refresh.mock.calls.length === 2 : h.refresh.mock.calls.length === 1));
		await expect(run).rejects.toBeInstanceOf(BoundExpired);
		expect(h.bridge.inFlight()).toBe(false);
		expect(h.gateOpen()).toBe(true);
		expect(h.detachAll).not.toHaveBeenCalled();
		expect(h.activate).not.toHaveBeenCalled();
		expect(h.install).toHaveBeenCalledTimes(npmBefore);
		for (const answer of h.late.splice(0)) answer();
		await new Promise((r) => setTimeout(r, 0));
		expect(h.detachAll).not.toHaveBeenCalled();
		expect(h.install).toHaveBeenCalledTimes(npmBefore);
		// The retry: everything answers. What npm already installed is not installed again; it restarts exactly once.
		h.hang[stage] = false;
		expect(await h.bridge.run(plan, true)).toBe(true);
		expect(h.activate).toHaveBeenCalledTimes(1);
		expect(h.activate).toHaveBeenCalledWith(plan.latest);
		expect(h.install).toHaveBeenCalledTimes(1);
		expect(h.detachAll).toHaveBeenCalledTimes(1);
	});

	it("CONTROL: an ordinary install restarts exactly once, and a concurrent second run is refused by the single flight", async () => {
		const h = bridgeHarness();
		const [first, second] = await Promise.all([h.bridge.run(plan, true), h.bridge.run(plan, true)]);
		expect([first, second].sort()).toEqual([false, true]);
		expect(h.install).toHaveBeenCalledTimes(1);
		expect(h.detachAll).toHaveBeenCalledTimes(1);
	});

	it("through the controller: a hung final look is a failed check with a retry — never restarting", async () => {
		const h = bridgeHarness();
		h.hang.facts = true;
		const cell = new PolicyCell({ autoUpdate: true }, () => undefined);
		cell.authoritative = true;
		const timers: Array<{ ms: number }> = [];
		const controller = new AutomaticUpdateController({
			policy: () => ({ value: cell.policy, authoritative: true }),
			refreshPolicy: async () => true,
			facts: async () => healthy("0.4.90"),
			plan: planRunnerUpdate,
			installAndRestart: (p, automatic) => h.bridge.run(p, automatic),
			status: (s, e) => cell.record(s, e),
			setTimer: (_fn, ms) => {
				timers.push({ ms });
				return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: () => undefined,
			random: () => 0,
		});
		const run = controller.runNow();
		await h.expireWhen(() => h.facts.mock.calls.length === 1);
		await run;
		expect(cell.policy).toMatchObject({ status: "failure", reason: expect.stringContaining("did not answer within 30s") });
		expect(timers.at(-1)?.ms).toBe(nextAutoUpdateDelayMs(1, () => 0));
		expect(h.detachAll).not.toHaveBeenCalled();
	});
});

describe("B2 — an aborted refresh keeps its registration and keeps sending policy requests (real HTTP)", () => {
	it("the sole registration survives an abort; nine retries each reach the service", async () => {
		let hangNext = false;
		const { url, hits } = await serve((_req, res) => {
			if (hangNext) {
				hangNext = false;
				return; // a peer that never answers
			}
			json(res, { autoUpdatePolicy: { autoUpdate: true } });
		});
		const cell = new PolicyCell({ autoUpdate: true }, () => undefined);
		const channel = createPolicyChannel({
			cell,
			post: (path, body, signal) => requestPags<Record<string, unknown>>("POST", path, { apiBase: url, pagsToken: "inert" }, body, signal),
			body: () => ({}),
			force: false,
			held: () => [],
			onError: () => undefined,
			onAction: () => undefined,
		});
		expect(await channel.register("i1")).toBe(true);
		hangNext = true;
		const bounds: Array<() => void> = [];
		const timer = (fn: () => void) => {
			bounds.push(fn);
			return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
		};
		const first = boundedWork((signal) => channel.refresh(signal), { timer, clear: () => undefined });
		await vi.waitFor(() => expect(hits).toHaveLength(2));
		bounds[0]();
		expect(await first).toBeNull();
		expect(channel.registered.has("i1")).toBe(true);
		for (let i = 0; i < 9; i++) expect(await channel.refresh()).toBe(true);
		expect(hits).toHaveLength(11);
	});

	it("with no registration held, a refresh falls back to an attached agent instead of giving up silently", async () => {
		const { url, hits } = await serve((_req, res) => json(res, { autoUpdatePolicy: { autoUpdate: true } }));
		const cell = new PolicyCell({ autoUpdate: true }, () => undefined);
		const channel = createPolicyChannel({
			cell,
			post: (path, body, signal) => requestPags<Record<string, unknown>>("POST", path, { apiBase: url, pagsToken: "inert" }, body, signal),
			body: () => ({}),
			force: false,
			held: () => ["i2"],
			onError: () => undefined,
			onAction: () => undefined,
		});
		expect(await channel.refresh()).toBe(true);
		expect(hits).toEqual(["POST /v1/instances/i2/runtime"]);
	});
});

describe("B3 — an answer is validated before it is ordered", () => {
	it("an invalid NEWER answer does not advance the fence, so the valid OLDER owner OFF still lands", () => {
		const cell = new PolicyCell({ autoUpdate: true }, () => undefined);
		const off = cell.next();
		const invalid = cell.next();
		expect(cell.accept({ success: true }, invalid)).toBeNull();
		expect(cell.accept({ autoUpdatePolicy: { autoUpdate: false, status: "disabled" } }, off)).toBe("cancel");
		expect(cell.policy.autoUpdate).toBe(false);
	});
});

describe("B4 — a policy refresh that times out is a check", () => {
	it("checkAt moves; decisionAt does not", async () => {
		const bounds: Array<() => void> = [];
		const clock = { t: 7_000_000 };
		const controller = new AutomaticUpdateController({
			policy: () => ({ value: { autoUpdate: true }, authoritative: true }),
			refreshPolicy: () => new Promise<boolean>(() => undefined),
			facts: async () => healthy(),
			plan: planRunnerUpdate,
			installAndRestart: async () => false,
			status: () => undefined,
			setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
			clearTimer: () => undefined,
			boundTimer: (fn) => {
				bounds.push(fn);
				return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
			},
			random: () => 0,
			now: () => clock.t,
		});
		const run = controller.runNow();
		await vi.waitFor(() => expect(bounds).toHaveLength(1));
		bounds[0]();
		await run;
		expect(controller.diagnostics()).toMatchObject({ checkAt: clock.t, decisionAt: null });
	});
});

// ── #1020: an OPEN cycle is never redefined; a RESOLVED one is durable evidence ────────────────────────────────────

describe("an open cycle owns the update until it resolves; a verified one stays (#1020)", () => {
	/** The controller on a real cache-backed cell, driving the REAL install bridge whose final look can hang once. */
	function cycleRig(o: { current: () => string; latest: () => string; attached: () => string[] }) {
		const m = machine();
		const cell = m.process();
		const bounds: Array<{ fn: () => void }> = [];
		let hangFinal = true;
		const install = vi.fn(async (_version: string) => undefined);
		const bridge = createInstallBridge({
			cell,
			refresh: async () => true,
			facts: () => (hangFinal ? new Promise<UpdateFacts>(() => undefined) : Promise.resolve(healthy(o.current(), o.latest()))),
			install,
			admission: new RelayMutationAdmission(),
			leaseActive: () => true,
			detachAll: () => undefined,
			log: () => undefined,
			settle: async () => undefined,
			bound: {
				timer: (fn) => {
					const t = { fn, unref() {} };
					bounds.push(t);
					return t as unknown as ReturnType<typeof setTimeout>;
				},
				// A bound whose work answered is cleared — only the hung one stays to expire.
				clear: (t) => {
					const i = bounds.indexOf(t as unknown as (typeof bounds)[number]);
					if (i >= 0) bounds.splice(i, 1);
				},
			},
		});
		const rig = controllerOn(cell, { facts: async () => healthy(o.current(), o.latest()), attached: o.attached, install: (p, a) => bridge.run(p, a) });
		/** Run one check whose final restart look hangs until its bound expires. */
		const checkWithHungRestart = async () => {
			hangFinal = true;
			const run = rig.controller.runNow();
			// npm has run, so the one pending bound is the final restart look's — never the pre-npm refresh's.
			await vi.waitFor(() => {
				expect(install).toHaveBeenCalled();
				expect(bounds.length).toBe(1);
			});
			bounds.shift()?.fn();
			await run;
		};
		const checkThatRestarts = async () => {
			hangFinal = false;
			await rig.controller.runNow();
		};
		return { m, cell, install, bridge, rig, checkWithHungRestart, checkThatRestarts };
	}

	it("A: after a timed-out restart, a retry holding 1 agent reuses the OPEN cycle — all 14, same start — and npm runs once", async () => {
		let held = ids(14);
		const r = cycleRig({ current: () => "0.4.90", latest: () => "0.4.91", attached: () => held });
		await r.checkWithHungRestart();
		const opened = r.m.disk()?.recovery;
		expect(opened).toMatchObject({ target: "0.4.91", attachments: ids(14) });
		expect(r.cell.policy.status).toBe("failure"); // the bounded restart look: a failed check, not a restart
		held = ids(1);
		r.rig.clock.t += 60_000;
		await r.checkThatRestarts();
		expect(r.m.disk()?.recovery).toEqual(opened); // never redefined: 14 agents, original `at`
		expect(r.install).toHaveBeenCalledTimes(1); // the installed release is reused
		expect(r.m.disk()?.status).toBe("restarting");
		// The restarted process reads the cache, holding only 1 identity: 13 originals are still outstanding.
		const next = r.m.process();
		const after = controllerOn(next, { facts: async () => healthy("0.4.91", "0.4.91"), attached: () => ids(1) });
		await after.controller.runNow();
		expect(next.policy).toMatchObject({ status: "failure", reason: expect.stringContaining("only 1 of its 14 original agents") });
		expect(r.m.disk()?.recovery?.verifiedAt).toBeUndefined();
	});

	it("B: 0.4.110 installed while on 0.4.108, restart timed out, the registry then says 0.4.109 — the retry is 0.4.110, npm runs once", async () => {
		let latest = "0.4.110";
		const r = cycleRig({ current: () => "0.4.108", latest: () => latest, attached: () => ids(14) });
		await r.checkWithHungRestart();
		latest = "0.4.109";
		await r.checkThatRestarts();
		expect(r.install.mock.calls).toEqual([["0.4.110"]]);
		expect(r.m.disk()?.recovery).toMatchObject({ target: "0.4.110", attachments: ids(14) });
		expect(JSON.stringify(r.m.disk()?.recovery)).not.toContain("0.4.109");
		expect(r.m.disk()).toMatchObject({ status: "restarting", latestVersion: "0.4.110" });
	});

	it("B (unchanged control): the registry rolling back to the RUNNING version is the up-to-date path — retained, not verified", async () => {
		const m = machine();
		const cell = m.process();
		cell.record("restarting", { latestVersion: "0.4.91", recovery: cycle("0.4.91", ids(14)) });
		const { controller } = controllerOn(cell, { facts: async () => healthy("0.4.90", "0.4.90"), attached: () => ids(14) });
		await controller.runNow();
		expect(cell.policy).toMatchObject({ status: "failure", reason: expect.stringContaining("came back on 0.4.90, not the attempted 0.4.91") });
		expect(m.disk()?.recovery).toEqual(cycle("0.4.91", ids(14)));
	});

	it("B2: an open cycle at its version that cannot verify (13 of 14 back) is SUPERSEDED by a newer release — it installs, with a new cycle (#1170)", async () => {
		const m = machine();
		const cell = m.process();
		cell.record("restarting", { latestVersion: "0.4.91", recovery: cycle("0.4.91", ids(14)) });
		const install = vi.fn(async () => true);
		const { controller } = controllerOn(cell, { facts: async () => healthy("0.4.91", "0.4.92"), attached: () => ids(13), install });
		await controller.runNow();
		expect(install).toHaveBeenCalledTimes(1);
		expect(install.mock.calls[0]?.[0]).toMatchObject({ latest: "0.4.92" });
		// the frozen 14-agent list is gone: the new cycle holds the agents held now, at a new start
		expect(m.disk()?.recovery).toMatchObject({ target: "0.4.92", attachments: ids(13) });
		expect(m.disk()?.recovery?.verifiedAt).toBeUndefined();
	});

	it("B2 (unchanged control): with NO newer release the unverified cycle stays recorded and nothing installs", async () => {
		const m = machine();
		const cell = m.process();
		cell.record("restarting", { latestVersion: "0.4.91", recovery: cycle("0.4.91", ids(14)) });
		const install = vi.fn(async () => true);
		const { controller } = controllerOn(cell, { facts: async () => healthy("0.4.91", "0.4.91"), attached: () => ids(13), install });
		await controller.runNow();
		expect(install).not.toHaveBeenCalled();
		expect(cell.policy).toMatchObject({ status: "failure", reason: expect.stringContaining("only 13 of its 14 original agents") });
		expect(m.disk()?.recovery).toEqual(cycle("0.4.91", ids(14)));
	});

	it("#1170: an agent repinned, paused or unsubscribed since the install is no longer required back — the cycle verifies on the agents it should hold", async () => {
		const m = machine();
		const cell = m.process();
		cell.record("restarting", { latestVersion: "0.4.91", recovery: cycle("0.4.91", ids(14)) });
		const shouldHold = new Set(ids(14).slice(0, 12)); // two were repinned elsewhere meanwhile
		const { controller } = controllerOn(cell, { facts: async () => healthy("0.4.91", "0.4.91"), attached: () => ids(12), shouldHold: () => shouldHold });
		await controller.runNow();
		expect(m.disk()).toMatchObject({ status: "verified-success" });
		expect(m.disk()?.recovery?.verifiedAt).toEqual(expect.any(String));
	});

	it("#1170: an agent the machine STILL should hold, and that is missing, still blocks verification (the excuse is not blanket)", async () => {
		const m = machine();
		const cell = m.process();
		cell.record("restarting", { latestVersion: "0.4.91", recovery: cycle("0.4.91", ids(14)) });
		const shouldHold = new Set(ids(14).slice(0, 13));
		const { controller } = controllerOn(cell, { facts: async () => healthy("0.4.91", "0.4.91"), attached: () => ids(12), shouldHold: () => shouldHold });
		await controller.runNow();
		expect(cell.policy).toMatchObject({ status: "failure", reason: expect.stringContaining("only 12 of its 13 original agents") });
	});

	it("#1170: before any membership pass has run (shouldHold null) nothing is excused", async () => {
		const m = machine();
		const cell = m.process();
		cell.record("restarting", { latestVersion: "0.4.91", recovery: cycle("0.4.91", ids(14)) });
		const { controller } = controllerOn(cell, { facts: async () => healthy("0.4.91", "0.4.91"), attached: () => ids(13), shouldHold: () => null });
		await controller.runNow();
		expect(cell.policy).toMatchObject({ status: "failure", reason: expect.stringContaining("only 13 of its 14 original agents") });
	});

	const resolved = { ...cycle("0.4.91", ids(14)), verifiedAt: "2026-10-12T01:00:00.000Z" };

	it("C1: a verified cycle survives the next ordinary check — still verified-success, the record intact", async () => {
		const m = machine();
		const cell = m.process();
		cell.record("verified-success", { latestVersion: "0.4.91", recovery: resolved });
		// Even with fewer agents now (one was unsubscribed since), a resolved cycle is not re-judged.
		const { controller } = controllerOn(cell, { facts: async () => healthy("0.4.91", "0.4.91"), attached: () => ids(12) });
		await controller.runNow();
		expect(m.disk()).toMatchObject({ status: "verified-success", recovery: resolved });
	});

	it("C2: it survives a reload — a fresh cell reading the cache, then an ordinary check, still verified-success", async () => {
		const m = machine();
		m.process().record("verified-success", { latestVersion: "0.4.91", recovery: resolved });
		const reloaded = m.process();
		expect(reloaded.policy.recovery).toEqual(resolved);
		const { controller } = controllerOn(reloaded, { facts: async () => healthy("0.4.91", "0.4.91"), attached: () => ids(14) });
		await controller.runNow();
		expect(m.disk()).toMatchObject({ status: "verified-success", recovery: resolved });
	});

	it("C3: a newer release replaces ONLY a resolved cycle — a new open cycle with the new target and today's agents", async () => {
		const m = machine();
		const cell = m.process();
		cell.record("verified-success", { latestVersion: "0.4.91", recovery: resolved });
		const { controller } = controllerOn(cell, { facts: async () => healthy("0.4.91", "0.4.92"), attached: () => ids(3) });
		await controller.runNow();
		const next = m.disk()?.recovery;
		expect(next).toMatchObject({ target: "0.4.92", attachments: ids(3) });
		expect(next?.verifiedAt).toBeUndefined();
		expect(m.disk()?.status).toBe("restarting");
	});
});

describe("a policy refresh never re-claims with --force (#1172)", () => {
	function channelWith(force: boolean) {
		const bodies: Array<{ id: string; force: boolean }> = [];
		const cell = new PolicyCell({ autoUpdate: true }, () => undefined);
		const channel = createPolicyChannel({
			cell,
			post: async () => ({ autoUpdatePolicy: { autoUpdate: true } }),
			body: (id, forceClaim) => {
				bodies.push({ id, force: forceClaim });
				return { force: forceClaim };
			},
			force,
			held: () => ["i1"],
			onError: () => undefined,
			onAction: () => undefined,
		});
		return { channel, bodies };
	}

	it("a machine started with --force claims with force at startup, and every later refresh (before/after an install) does not", async () => {
		const { channel, bodies } = channelWith(true);
		expect(await channel.register("i1")).toBe(true); // the startup claim keeps the process's flag
		await channel.refresh();
		await channel.refresh();
		expect(bodies.map((b) => b.force)).toEqual([true, false, false]);
	});

	it("a refresh through a held id (nothing registered yet) is also without force", async () => {
		const { channel, bodies } = channelWith(true);
		await channel.refresh();
		expect(bodies).toEqual([{ id: "i1", force: false }]);
	});

	it("without --force nothing changes: startup and refresh both send false", async () => {
		const { channel, bodies } = channelWith(false);
		await channel.register("i1");
		await channel.refresh();
		expect(bodies.map((b) => b.force)).toEqual([false, false]);
	});
});
