import { describe, expect, it } from "vitest";
import { isRunnerGone, isRunnerUnreachable, parseRunnerError, RunnerError, RunnerGoneError, runnerErrorTag, RunnerUnreachableError } from "./runner-unreachable.js";

/** What a Workflow step boundary does to an error: keeps the message, drops the class and every field. */
const flattened = (e: Error): Error => new Error(e.message);

describe("runner failures carry their cause as fields (#1355)", () => {
	it("an unreachable error has code, origin, path, dispatched and retryable", () => {
		const e = new RunnerUnreachableError(`Runner /coding/act → 504: dropped${runnerErrorTag("DROPPED", true, "/coding/act")}`, { code: "DROPPED", path: "/coding/act" });
		expect(e).toBeInstanceOf(RunnerError);
		expect(e).toMatchObject({ code: "DROPPED", origin: "relay", path: "/coding/act", dispatched: true, retryable: true });
	});

	it("a 503 with no socket was not dispatched", () => {
		const e = new RunnerUnreachableError(`No runner connected${runnerErrorTag("NO_SOCKET", true)}`, { code: "NO_SOCKET", dispatched: false });
		expect(e.dispatched).toBe(false);
	});

	it("the code defaults to the message's tag", () => {
		expect(new RunnerUnreachableError(`x${runnerErrorTag("UNRESPONSIVE", true)}`).code).toBe("UNRESPONSIVE");
	});

	it("a runner's own error is a RunnerError from the runner, not retryable", () => {
		const e = new RunnerError(`Runner /x → 500: boom${runnerErrorTag("RUNNER_HTTP", false, "/x")}`, "RUNNER_HTTP", { path: "/x" });
		expect(e).toMatchObject({ origin: "runner", retryable: false, dispatched: true });
	});

	it("RunnerGoneError has its own code and origin, raised by the guard", () => {
		const e = new RunnerGoneError("the machine did not come back");
		expect(e).toMatchObject({ code: "GONE", origin: "guard", retryable: false });
		expect(isRunnerGone(e)).toBe(true);
		expect(isRunnerUnreachable(e)).toBe(false);
	});

	it("every fact survives a step boundary: the flattened message parses to the same record", () => {
		for (const e of [
			new RunnerUnreachableError(`a${runnerErrorTag("RELAY_TIMEOUT", true, "/coding/capture")}`, { code: "RELAY_TIMEOUT", path: "/coding/capture" }),
			new RunnerError(`b${runnerErrorTag("RUNNER_HTTP", false, "/tmux/run")}`, "RUNNER_HTTP", { path: "/tmux/run" }),
			new RunnerGoneError("gone"),
		]) {
			const before = parseRunnerError(e);
			const after = parseRunnerError(flattened(e));
			expect(after).toMatchObject({ code: before?.code, path: before?.path, dispatched: before?.dispatched, retryable: before?.retryable });
		}
		expect(isRunnerGone(flattened(new RunnerGoneError("gone")))).toBe(true);
	});

	it("an unrelated error with a `code` is not a runner failure", () => {
		expect(parseRunnerError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toBeNull();
	});
});
