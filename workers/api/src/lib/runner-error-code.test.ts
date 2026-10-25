/**
 * #1355 — a runner failure is read by its code, not its words. The relay answers with a code, `callRunner` carries it as
 * one tag in the message, and `runnerErrorCode` reads it back: from a live error, from a message flattened across a
 * Workflow step boundary, and — for a run in flight across the deploy — from the words an untagged message still has.
 */
import { describe, expect, it } from "vitest";
import { captureSaysSessionAbsent } from "./coding-ownership.js";
import { callRunner } from "./runner-client.js";
import { classifyHealthProbeFailure } from "./runner-health.js";
import { isRunnerUnreachable, isRunnerUnresponsive, relayFailureIsDisconnect, runnerErrorCode, runnerErrorTag, RunnerUnreachableError } from "./runner-unreachable.js";
import type { RunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";

const conn = (answer: () => Response): RunnerConn =>
	({
		instanceId: "i1",
		relayName: "i1",
		env: { RELAY: { idFromName: () => "id", get: () => ({ fetch: async () => answer() }) }, DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) } } as unknown as Env,
	}) as RunnerConn;
const failure = (path: string, answer: () => Response): Promise<Error> =>
	callRunner(conn(answer), path).then(
		() => {
			throw new Error(`expected ${path} to fail`);
		},
		(e: unknown) => e as Error,
	);
/** What a step boundary leaves: the message, and nothing else. */
const flat = (e: Error) => new Error(e.message);

describe("every relay answer carries its code through callRunner and across a step boundary", () => {
	const cases: Array<[string, string, () => Response, string, boolean]> = [
		["no socket", "/coding/act", () => Response.json({ error: "No runner connected", code: "RUNNER_RELAY_NO_SOCKET" }, { status: 503 }), "NO_SOCKET", true],
		["silent socket", "/coding/act", () => Response.json({ error: "Runner relay is connected but not responding", code: "RUNNER_RELAY_UNRESPONSIVE" }, { status: 503 }), "UNRESPONSIVE", true],
		["dropped", "/coding/act", () => Response.json({ error: "Runner disconnected", code: "RUNNER_RELAY_DROPPED" }, { status: 504 }), "DROPPED", true],
		["timed-out read", "/coding/capture", () => Response.json({ error: "Relay command timed out", code: "RUNNER_RELAY_TIMEOUT" }, { status: 504 }), "RELAY_TIMEOUT", true],
		["timed-out act (may have run)", "/coding/act", () => Response.json({ error: "Relay command timed out", code: "RUNNER_RELAY_TIMEOUT" }, { status: 504 }), "RELAY_TIMEOUT", false],
		["owner's takeover", "/coding/act", () => Response.json({ error: "Runner replaced by new connection", code: "RUNNER_RELAY_REPLACED" }, { status: 504 }), "REPLACED", false],
		["draining runner", "/coding/act", () => Response.json({ error: "Runner is draining for a safe automatic update; retry shortly." }, { status: 503 }), "DRAINING", true],
		["runner's own error", "/coding/act", () => Response.json({ error: "No coding session: s1" }, { status: 404 }), "RUNNER_HTTP", false],
	];
	it.each(cases)("%s", async (_name, path, answer, code, unreachable) => {
		const e = await failure(path, answer);
		for (const err of [e, flat(e)]) {
			expect(runnerErrorCode(err)).toBe(code);
			expect(isRunnerUnreachable(err)).toBe(unreachable);
		}
		// The tag is appended, so the patterns anchored on `Runner /path → status:` still read the head of the message.
		if (!unreachable) expect(e.message).toMatch(/^Runner \/coding\/\S+ → \d{3}: /);
	});

	it("a runner body that happens to contain the relay's words is still the runner's (#1344's class of bug)", async () => {
		const e = await failure("/coding/act", () => Response.json({ error: "upstream said: Runner disconnected" }, { status: 500 }));
		expect(runnerErrorCode(e)).toBe("RUNNER_HTTP");
		expect(isRunnerUnreachable(e)).toBe(false);
	});
});

describe("an untagged message — written before #1355, read after it — is classified as it always was", () => {
	it.each([
		["No runner connected — the relay has no live socket for this agent.", "NO_SOCKET", true],
		["Runner relay is connected but not responding — the relay has no live socket for this agent.", "UNRESPONSIVE", true],
		["Runner /coding/capture → 504: Relay command timed out — the runner is connected but not responding.", "UNRESPONSIVE", true],
		['Runner /coding/act → 504: {"error":"Relay command timed out"}', "RELAY_TIMEOUT", false],
		["Runner /coding/act → 503: the runner is draining for an automatic update and is connected but not responding to new work until it restarts.", "DRAINING", true],
		["Runner disconnected", "DROPPED", true],
		["git clone failed: exit 128", null, false],
	] as const)("%s", (message, code, unreachable) => {
		expect(runnerErrorCode(new Error(message))).toBe(code);
		expect(isRunnerUnreachable(new Error(message))).toBe(unreachable);
	});
});

describe("readers that used to match words", () => {
	it("a reader that parses the runner's body out of the message still reads it — the tag is not part of the body", async () => {
		const e = await failure("/coding/capture", () => Response.json({ error: "No coding session: s1" }, { status: 404 }));
		expect(captureSaysSessionAbsent(e, "s1")).toBe(true);
		expect(captureSaysSessionAbsent(flat(e), "s1")).toBe(true);
		expect(captureSaysSessionAbsent(e, "s10")).toBe(false);
	});

	it("the health probe's state comes from the code", () => {
		expect(classifyHealthProbeFailure(new Error(`Runner /health → 504: x${runnerErrorTag("RELAY_TIMEOUT", false)}`)).state).toBe("timeout");
		expect(classifyHealthProbeFailure(new RunnerUnreachableError(`x${runnerErrorTag("UNRESPONSIVE", true)}`)).state).toBe("unresponsive");
		expect(classifyHealthProbeFailure(new RunnerUnreachableError(`x${runnerErrorTag("DRAINING", true)}`)).state).toBe("unresponsive");
		expect(classifyHealthProbeFailure(new RunnerUnreachableError(`x${runnerErrorTag("NO_SOCKET", true)}`)).state).toBe("disconnected");
		expect(classifyHealthProbeFailure(new Error(`Runner /health → 500: boom${runnerErrorTag("RUNNER_HTTP", false)}`)).state).toBe("failed");
	});

	it("unresponsive means a socket that is there and silent — never one that is gone", () => {
		expect(isRunnerUnresponsive(new Error(`x${runnerErrorTag("RELAY_TIMEOUT", true)}`))).toBe(true);
		expect(isRunnerUnresponsive(new Error(`x${runnerErrorTag("NO_SOCKET", true)}`))).toBe(false);
		expect(isRunnerUnresponsive(new Error(`x${runnerErrorTag("RELAY_TIMEOUT", false)}`))).toBe(false); // not one to wait out
	});

	it("relayFailureIsDisconnect reads the relay's code first, and an old relay's words while a deploy rolls", () => {
		expect(relayFailureIsDisconnect(504, '{"error":"Runner disconnected","code":"RUNNER_RELAY_DROPPED"}')).toBe(true);
		expect(relayFailureIsDisconnect(504, '{"error":"Relay command timed out","code":"RUNNER_RELAY_TIMEOUT"}')).toBe(false);
		expect(relayFailureIsDisconnect(504, '{"error":"Stale runner socket evicted","code":"RUNNER_RELAY_REPLACED"}')).toBe(false);
		expect(relayFailureIsDisconnect(504, '{"error":"Runner disconnected"}')).toBe(true);
		expect(relayFailureIsDisconnect(503, '{"error":"No runner connected"}')).toBe(true);
		expect(relayFailureIsDisconnect(503, '{"error":"Service Unavailable"}')).toBe(false);
	});
});
