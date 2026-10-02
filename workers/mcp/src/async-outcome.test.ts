import { afterEach, describe, expect, it, vi } from "vitest";
import { authedAsyncCall } from "./async-outcome.js";

const recovery = { tool: "runner_update", possibleOutcomes: ["not-started", "scheduled", "restarted"], poll: { tool: "list_runner_nodes", input: {} } };
const call = () => authedAsyncCall("/update", "token", { method: "POST" }, { API_BASE: "https://api.test" }, recovery);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("async operation confirmation", () => {
	it.each([502, 504])("reports HTTP %s gateway replies as uncertainty even with a custom error body", async (status) => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "upstream interrupted" }), { status }));
		expect(await call()).toMatchObject({ outcome: "unknown", confirmation: { reason: "gateway-error", httpStatus: status }, poll: recovery.poll });
	});
	it("preserves explicit application failures rather than guessing they completed", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "runner refused" }), { status: 500 }));
		expect(await call()).toEqual({ error: "runner refused" });
	});

	it("preserves confirmed in-flight and partial responses", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ action: "scheduled", waitingFor: ["session-1"] })));
		expect(await call()).toEqual({ action: "scheduled", waitingFor: ["session-1"] });
	});
	it("preserves explicit API refusals", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "permission denied" }), { status: 403 }));
		expect(await call()).toEqual({ error: "permission denied" });
	});
	it("reports uncertainty and polling after transport failure without retrying", async () => {
		const fetch = vi.fn().mockRejectedValue(new Error("socket lost"));
		vi.stubGlobal("fetch", fetch);
		expect(await call()).toMatchObject({ outcome: "unknown", confirmation: { reason: "transport-error" }, ...recovery });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("bounds a hung request even when fetch ignores abort", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		vi.stubGlobal("fetch", (_url: string, init: RequestInit) => { signal = init.signal as AbortSignal; return new Promise(() => {}); });
		const pending = call();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(await pending).toMatchObject({ outcome: "unknown", confirmation: { reason: "deadline-exceeded" }, poll: recovery.poll });
		expect(signal?.aborted).toBe(true);
	});
	it("handles a response interrupted while its body is being read", async () => {
		vi.stubGlobal("fetch", async () => ({ status: 200, text: () => Promise.reject(new Error("body interrupted")) }));
		expect(await call()).toMatchObject({ outcome: "unknown", confirmation: { reason: "transport-error", httpStatus: 200 } });
	});
});
