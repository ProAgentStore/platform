import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserToolRecovery } from "./browser-tool-recovery.js";

function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());
describe("native request quarantine (#1537)", () => {
	it("uses configurable seconds as milliseconds with a later wire deadline", async () => {
		vi.useFakeTimers();
		try {
			for (const seconds of [1, 600, 3600]) {
				const recovery = new BrowserToolRecovery<string>(seconds * 1000);
				expect(recovery.requestDeadlineMs).toBe(seconds * 1000);
				expect(recovery.wireDeadlineMs).toBe(seconds * 1000 + 60_000);
				const pending = recovery.request("browser_snapshot", () => new Promise<string>(() => {}), () => false);
				await vi.advanceTimersByTimeAsync(seconds * 1000);
				expect((await pending).diagnostic).toMatchObject({ kind: "request_deadline", execution: "pending" });
				expect(recovery.blocked()?.kind).toBe("quarantined");
			}
			const defaults = new BrowserToolRecovery();
			expect(defaults.requestDeadlineMs).toBe(600_000);
			expect(defaults.wireDeadlineMs).toBe(660_000);
		} finally { vi.useRealTimers(); }
	});

	it("defers a first follow-up behind ordinary work without reporting a timeout", async () => {
		const recovery = new BrowserToolRecovery<string>(60, 600), native = deferred<string>();
		const action = recovery.request("browser_click", () => native.promise, () => false);
		const followup = vi.fn(async () => "uploaded");
		const next = recovery.waitForIdle().then(() => recovery.request("browser_file_upload", followup, () => false));
		await Promise.resolve();
		expect(recovery.status()).toBeNull();
		expect(followup).not.toHaveBeenCalled();
		native.resolve("chooser opened");
		expect(await action).toEqual({ reply: "chooser opened" });
		expect(await next).toEqual({ reply: "uploaded" });
		expect(followup).toHaveBeenCalledTimes(1);
	});
	it("abandons a waiting first action if the preceding action expires", async () => {
		vi.useFakeTimers();
		const recovery = new BrowserToolRecovery<string>(60, 600), native = deferred<string>();
		const action = recovery.request("browser_click", () => native.promise, () => false);
		const followup = vi.fn(async () => "must not execute");
		const next = recovery.waitForIdle().then(() => recovery.request("browser_file_upload", followup, () => false));
		await vi.advanceTimersByTimeAsync(60);
		expect((await action).diagnostic?.kind).toBe("request_deadline");
		expect((await next).diagnostic?.kind).toBe("quarantined");
		expect(followup).not.toHaveBeenCalled();
		native.resolve("late"); await vi.advanceTimersByTimeAsync(0);
		expect(followup).not.toHaveBeenCalled();
	});
	it("does not dispatch a waiting action after a transport rejection", async () => {
		const recovery = new BrowserToolRecovery<string>(60, 600), native = deferred<string>();
		const action = recovery.request("browser_click", () => native.promise, () => false);
		const followup = vi.fn(async () => "must not execute");
		const next = recovery.waitForIdle().then(() => recovery.request("browser_file_upload", followup, () => false));
		native.reject(new Error("connection closed without a response"));
		expect((await action).diagnostic?.kind).toBe("transport_failure");
		expect((await next).diagnostic?.kind).toBe("quarantined");
		expect(followup).not.toHaveBeenCalled();
		expect(recovery.status()?.canResume).toBe(false);
	});
	it("retirement releases ordinary waiters without dispatching or replaying", async () => {
		const recovery = new BrowserToolRecovery<string>(60, 600), native = deferred<string>();
		const action = recovery.request("browser_click", () => native.promise, () => false);
		const followup = vi.fn(async () => "must not execute");
		const next = recovery.waitForIdle().then(() => recovery.request("browser_file_upload", followup, () => false));
		recovery.retire();
		expect((await next).diagnostic?.kind).toBe("quarantined");
		expect(followup).not.toHaveBeenCalled();
		native.resolve("late response"); await action;
		expect(recovery.release()).toBeUndefined();
		expect(recovery.blocked()?.recoverable).toBe(false);
	});
	it("bounds the caller, permits independent pixels, and never replays a delayed action", async () => {
		vi.useFakeTimers();
		const recovery = new BrowserToolRecovery<string>(60, 600), native = deferred<string>();
		let effects = 0;
		const action = recovery.request("browser_click", async () => { effects++; return native.promise; }, () => false);
		await vi.advanceTimersByTimeAsync(60);
		expect((await action).diagnostic).toMatchObject({ kind: "request_deadline", execution: "pending", recoverable: false });
		const next = vi.fn(async () => "must not execute");
		expect((await recovery.request("browser_evaluate", next, () => false)).diagnostic?.kind).toBe("quarantined");
		expect(next).not.toHaveBeenCalled();
		expect(await Promise.resolve("independent page screenshot pixels")).toContain("pixels");
		native.resolve("the action already happened");
		await vi.advanceTimersByTimeAsync(0);
		expect(recovery.status()).toMatchObject({ canResume: true, deadlineCount: 1, diagnostic: { execution: "settled" } });
		expect(recovery.blocked()).not.toBeNull();
		expect(recovery.release()).toBe("the action already happened");
		expect(recovery.blocked()).toBeNull();
		expect(effects).toBe(1);
	});
	it("wire cancellation/rejection is not proof of handler settlement", async () => {
		vi.useFakeTimers();
		const recovery = new BrowserToolRecovery<string>(60, 600), native = deferred<string>();
		const action = recovery.request("browser_file_upload", () => native.promise, () => false);
		await vi.advanceTimersByTimeAsync(60); await action;
		native.reject(new Error("MCP -32001 wire deadline"));
		await vi.advanceTimersByTimeAsync(0);
		expect(recovery.status()).toMatchObject({ canResume: false, diagnostic: { kind: "transport_failure", execution: "unknown", originalError: "MCP -32001 wire deadline" } });
		expect(recovery.release()).toBeUndefined();
		expect(recovery.blocked()?.recoverable).toBe(false);
		expect(recovery.blocked()?.originalError).toBeUndefined();
	});
	it("a fulfilled tool-error response settles its handler without claiming website acceptance", async () => {
		vi.useFakeTimers();
		const recovery = new BrowserToolRecovery<{ isError: boolean }>(60, 600), native = deferred<{ isError: boolean }>();
		const action = recovery.request("browser_click", () => native.promise, () => false);
		await vi.advanceTimersByTimeAsync(60); await action;
		native.resolve({ isError: true }); await vi.advanceTimersByTimeAsync(0);
		expect(recovery.release()).toEqual({ isError: true });
	});
	it("retirement blocks reuse even when the old response later arrives", async () => {
		vi.useFakeTimers();
		const recovery = new BrowserToolRecovery<string>(60, 600), native = deferred<string>();
		const action = recovery.request("browser_evaluate", () => native.promise, () => false);
		await vi.advanceTimersByTimeAsync(60); await action;
		recovery.retire(); native.resolve("done"); await vi.advanceTimersByTimeAsync(0);
		expect(recovery.release()).toBeUndefined();
		expect(recovery.blocked()?.recoverable).toBe(false);
	});
	it("records process loss only from an explicit connectivity observation", async () => {
		const recovery = new BrowserToolRecovery<string>(60, 600);
		const result = await recovery.request("browser_snapshot", async () => { throw new Error("closed"); }, () => true);
		expect(result.diagnostic).toMatchObject({ kind: "browser_process_lost", execution: "unknown", machine: { cpus: expect.any(Number) } });
	});
	it.each([NaN, Infinity, 0, -1])("rejects an invalid deadline %s", value => {
		expect(() => new BrowserToolRecovery(value, 600)).toThrow();
		expect(() => new BrowserToolRecovery(60, value)).toThrow();
	});
});
