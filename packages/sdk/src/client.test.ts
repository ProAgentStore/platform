import { describe, it, expect, vi, beforeEach } from "vitest";

// client.ts touches localStorage + fetch (browser globals) inside its functions —
// stub them for the node test runner.
const store = new Map<string, string>();
beforeEach(() => {
	store.clear();
	(globalThis as unknown as { localStorage: unknown }).localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => store.set(k, v),
		removeItem: (k: string) => store.delete(k),
	};
	(globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockResolvedValue({ ok: true });
});

import { isConnectivityError, reportClientError, setToken } from "./client.js";

const mockFetch = () => (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;

describe("reportClientError", () => {
	it("does nothing when signed out (nothing to attribute)", () => {
		reportClientError("voice", "boom-signed-out");
		expect(mockFetch()).not.toHaveBeenCalled();
	});

	it("POSTs the failure to the error endpoint when signed in", () => {
		setToken("tok");
		reportClientError("voice", "Whisper error 400: unique-A", { sttWhisper: true }, 400);
		expect(mockFetch()).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch().mock.calls[0] as [string, RequestInit];
		expect(String(url)).toContain("/v1/errors/client");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
		const body = JSON.parse(init.body as string);
		expect(body).toMatchObject({ source: "voice", message: "Whisper error 400: unique-A", status: 400 });
	});

	it("dedupes an identical error within the window", () => {
		setToken("tok");
		reportClientError("voice", "dup-error-B");
		reportClientError("voice", "dup-error-B");
		expect(mockFetch()).toHaveBeenCalledTimes(1);
	});

	it("reports distinct errors separately", () => {
		setToken("tok");
		reportClientError("api", "distinct-C-1");
		reportClientError("api", "distinct-C-2");
		expect(mockFetch()).toHaveBeenCalledTimes(2);
	});
});

describe("isConnectivityError", () => {
	it("matches transient network failures across browsers", () => {
		// The exact strings Safari/Chrome/Firefox throw on a dropped fetch — these
		// flooded the log via unhandledrejection before being suppressed.
		for (const m of [
			"Load failed",
			"TypeError: Load failed",
			"Failed to fetch",
			"NetworkError when attempting to fetch resource.",
			"The network connection was lost.",
			"Network request failed",
			"The request timed out",
			"The operation was aborted",
			"The operation was canceled",
		]) {
			expect(isConnectivityError(m)).toBe(true);
		}
	});

	it("does NOT match real application errors (they must still be reported)", () => {
		for (const m of [
			"HTTP 500",
			"Cannot read properties of undefined (reading 'map')",
			"Whisper error 400: Audio file is too short",
			"Unexpected token < in JSON",
			"is not a function",
		]) {
			expect(isConnectivityError(m)).toBe(false);
		}
	});
});
