/** #1358 — what the cloud knows about each runner route, and the three readers of it: the client, the error tag and the guard. */
import { describe, expect, it } from "vitest";
import { callRunner, type RunnerConn } from "./runner-client.js";
import { makeRunnerGuard, refusesBlindResend, type RunnerWaitDeps, type RunStep } from "./runner-availability.js";
import { isSafeToResend, RUNNER_ROUTES, routeFor, TIMED_OUT_READ_PATHS } from "./runner-routes.js";
import { RELAY_DEFAULT_TIMEOUT_MS, READ_TIMEOUT_MS } from "./runner-timeouts.js";
import { isRunnerUnreachable, runnerErrorCode, runnerErrorDispatched, runnerErrorPath, runnerErrorTag, RunnerUnreachableError, withoutRunnerErrorTag } from "./runner-unreachable.js";
import type { RuntimeFacts } from "./instance-connectivity.js";
import type { Env } from "../types.js";

describe("the route table", () => {
	it("classifies the routes the guard and the act path depend on", () => {
		expect(routeFor("/coding/capture")).toEqual({ timeoutMs: READ_TIMEOUT_MS, retry: "safe" });
		expect(routeFor("/coding/start").retry).toBe("safe"); // idempotent by session: a reconnect re-runs it by design
		expect(routeFor("/coding/act").retry).toBe("reconciled"); // safe only after the ledger is read
		for (const never of ["/browser/act", "/tmux/send", "/terminal/run", "/secure/type", "/coding/park-restore", "/coding/clone-start", "/coding/git-write"]) {
			expect(routeFor(never).retry, never).toBe("never");
		}
	});

	it("fails closed for a route nobody has classified: the relay default timeout, never re-sent", () => {
		expect(routeFor("/coding/brand-new")).toEqual({ timeoutMs: RELAY_DEFAULT_TIMEOUT_MS, retry: "never" });
		expect(isSafeToResend("/coding/brand-new")).toBe(false);
	});

	it("ignores a query string, and reads the takeover routes that carry a session id", () => {
		expect(routeFor("/coding/capture?x=1")).toBe(routeFor("/coding/capture"));
		expect(routeFor("/coding/takeover/csess_1/end").retry).toBe("safe");
		expect(routeFor("/coding/takeover/csess_1/resolve").retry).toBe("safe");
		expect(routeFor("/coding/takeover/csess_1/elsewhere").retry).toBe("never");
	});

	it("has no route that waits longer than the relay will, or shorter than a ping", () => {
		for (const [path, r] of Object.entries(RUNNER_ROUTES)) {
			expect(path.startsWith("/"), path).toBe(true);
			expect(r.timeoutMs, path).toBeGreaterThan(0);
			expect(r.timeoutMs, path).toBeLessThanOrEqual(RELAY_DEFAULT_TIMEOUT_MS);
		}
	});

	it("only /coding/act needs the caller to reconcile — every other repeat is either harmless or never done", () => {
		expect(Object.entries(RUNNER_ROUTES).filter(([, r]) => r.retry === "reconciled").map(([p]) => p)).toEqual(["/coding/act"]);
	});

	it("waits out a timed-out QUICK read — /health and /capabilities included, which the old hidden set left out", () => {
		for (const p of ["/coding/capture", "/terminal/capture", "/health", "/capabilities"]) expect(TIMED_OUT_READ_PATHS.has(p), p).toBe(true);
		// …and not a slow listing, or a write
		for (const p of ["/coding/github-repos", "/coding/act", "/browser/act"]) expect(TIMED_OUT_READ_PATHS.has(p), p).toBe(false);
	});
});

describe("the error tag carries the route and whether the command may have run", () => {
	it("round-trips the route through a step boundary, which keeps only the message", () => {
		const e = new RunnerUnreachableError(`No runner connected${runnerErrorTag("DROPPED", true, "/coding/act?x=1")}`, { dispatched: true, path: "/coding/act" });
		const flat = new Error(e.message);
		expect(runnerErrorPath(flat)).toBe("/coding/act");
		expect(runnerErrorCode(flat)).toBe("DROPPED");
		expect(isRunnerUnreachable(flat)).toBe(true);
		expect(runnerErrorPath(e)).toBe("/coding/act");
	});

	it("is unchanged for a failure that names no route, and strips cleanly", () => {
		expect(runnerErrorTag("NO_SOCKET", true)).toBe(" [runner-unreachable:NO_SOCKET]");
		expect(runnerErrorPath(new Error("x [runner-unreachable:NO_SOCKET]"))).toBeUndefined();
		expect(withoutRunnerErrorTag(`Runner /x → 500: boom${runnerErrorTag("RUNNER_HTTP", false, "/coding/act")}`)).toBe("Runner /x → 500: boom");
	});

	it("reads 'dispatched' from the code when the class is gone: a timeout or a drop may have run, a refusal did not", () => {
		const flat = (code: Parameters<typeof runnerErrorTag>[0]) => new Error(`x${runnerErrorTag(code, true, "/coding/act")}`);
		for (const code of ["RELAY_TIMEOUT", "DROPPED", "RELAY_FAILED", "RUNNER_HTTP"] as const) expect(runnerErrorDispatched(flat(code)), code).toBe(true);
		for (const code of ["NO_SOCKET", "UNRESPONSIVE", "DRAINING"] as const) expect(runnerErrorDispatched(flat(code)), code).toBe(false);
		expect(runnerErrorDispatched(new Error("something unreadable"))).toBe(true); // the wrong guess the other way is a duplicate
		expect(runnerErrorDispatched(new RunnerUnreachableError("x", { dispatched: false }))).toBe(false);
	});
});

const conn = (handler: (req: Request) => Promise<Response>): RunnerConn => ({
	endpointUrl: "http://127.0.0.1:1",
	token: "t",
	instanceId: "inst-1",
	userId: "u1",
	relayName: "inst-1",
	env: { RELAY: { idFromName: (n: string) => ({ n }), get: () => ({ fetch: handler }) }, DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) }) }) } } as unknown as Env,
});
const timedOut = () => Response.json({ error: "Relay command timed out", code: "RUNNER_RELAY_TIMEOUT" }, { status: 504 });
const dropped = () => Response.json({ error: "Runner disconnected", code: "RUNNER_RELAY_DROPPED" }, { status: 504 });

describe("callRunner classifies a failure by its route", () => {
	it("a timed-out /health or /capabilities is a runner not answering — typed, dispatched, naming its route", async () => {
		for (const path of ["/health", "/capabilities"]) {
			const err = (await callRunner(conn(async () => timedOut()), path, {}).catch((e) => e)) as RunnerUnreachableError;
			expect(isRunnerUnreachable(err), path).toBe(true);
			expect(err.dispatched).toBe(true);
			expect(runnerErrorPath(new Error(err.message)), path).toBe(path);
		}
	});

	it("a timed-out slow read or write stays a plain error that names its route", async () => {
		for (const path of ["/coding/github-repos", "/coding/act"]) {
			const err = (await callRunner(conn(async () => timedOut()), path, {}).catch((e) => e)) as Error;
			expect(isRunnerUnreachable(err), path).toBe(false);
			expect(runnerErrorPath(err), path).toBe(path);
		}
	});

	it("a socket dropped mid-command carries its route, and says the command may have run", async () => {
		const err = (await callRunner(conn(async () => dropped()), "/coding/act", {}).catch((e) => e)) as RunnerUnreachableError;
		expect(isRunnerUnreachable(err)).toBe(true);
		expect(err.dispatched).toBe(true);
		expect(runnerErrorPath(new Error(err.message))).toBe("/coding/act");
	});

	it("no socket at dispatch proves nothing was sent", async () => {
		const err = (await callRunner(conn(async () => Response.json({ error: "No runner connected", code: "RUNNER_RELAY_NO_SOCKET" }, { status: 503 })), "/browser/act", {}).catch((e) => e)) as RunnerUnreachableError;
		expect(err.dispatched).toBe(false);
		expect(runnerErrorDispatched(new Error(err.message))).toBe(false);
	});
});

describe("the guard does not re-run a dispatched failure on a route a repeat is not harmless on (#1358)", () => {
	const OFFLINE: RuntimeFacts = { hasRuntimeRow: true, relayConnected: false, node: "mac", runnerVersion: null, lastSeenAt: "2000-01-01 00:00:00" };
	const ONLINE: RuntimeFacts = { ...OFFLINE, relayConnected: true };
	const run: RunStep = (async (_n: string, fn: () => Promise<unknown>) => fn()) as RunStep;
	/** A guard whose wait sees the runner come back at once, so the only question is whether the step is re-run. */
	function guarded() {
		const wait: RunnerWaitDeps = { probe: async () => ONLINE, sleep: async () => undefined, announce: async () => undefined };
		let reconnects = 0;
		return { guard: makeRunnerGuard({ wait, reconnect: async () => void reconnects++ }), reconnects: () => reconnects };
	}
	/** What a step boundary leaves of a failure: a plain Error with the tagged message. */
	const failure = (code: Parameters<typeof runnerErrorTag>[0], path: string) => new Error(`Runner ${path} failed${runnerErrorTag(code, true, path)}`);
	async function attempts(err: Error, opts?: { reconciles?: boolean }) {
		const { guard } = guarded();
		let calls = 0;
		const out = await guard(run, "s1", async () => {
			if (calls++ === 0) throw err;
			return "ok";
		}, opts).catch((e) => e);
		return { calls, out };
	}

	it("refuses to re-send a dispatched write: the step ran once and the error surfaces, naming the route", async () => {
		const r = await attempts(failure("DROPPED", "/tmux/send"));
		expect(r.calls).toBe(1);
		expect((r.out as Error).message).toContain("/tmux/send");
	});

	it("refuses the same for a route that needs reconciling, unless the step declares that it does", async () => {
		const blind = await attempts(failure("RELAY_TIMEOUT", "/coding/act"));
		expect(blind.calls).toBe(1);
		const reconciled = await attempts(failure("RELAY_TIMEOUT", "/coding/act"), { reconciles: true });
		expect(reconciled).toEqual({ calls: 2, out: "ok" });
	});

	it("re-runs a safe route after a dispatched failure — a capture or a start can be asked again", async () => {
		expect(await attempts(failure("RELAY_TIMEOUT", "/coding/capture"))).toEqual({ calls: 2, out: "ok" });
		expect(await attempts(failure("DROPPED", "/coding/start"))).toEqual({ calls: 2, out: "ok" });
		expect(await attempts(failure("RELAY_TIMEOUT", "/health"))).toEqual({ calls: 2, out: "ok" });
	});

	it("re-runs a failure that proves nothing was sent, whatever the route — there is nothing to duplicate", async () => {
		for (const code of ["NO_SOCKET", "UNRESPONSIVE", "DRAINING"] as const) expect(await attempts(failure(code, "/browser/act")), code).toEqual({ calls: 2, out: "ok" });
	});

	it("keeps the old behaviour for a failure that names no route", async () => {
		expect(await attempts(new RunnerUnreachableError("Runner disconnected", { dispatched: true }))).toEqual({ calls: 2, out: "ok" });
	});

	it("refusesBlindResend is the single rule", () => {
		expect(refusesBlindResend(failure("DROPPED", "/secure/type"))).toBe(true);
		expect(refusesBlindResend(failure("DROPPED", "/coding/capture"))).toBe(false);
		expect(refusesBlindResend(failure("NO_SOCKET", "/secure/type"))).toBe(false);
		expect(refusesBlindResend(new Error("plain"))).toBe(false);
	});
});
