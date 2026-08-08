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

import { api, isConnectivityError, reportClientError, setToken } from "./client.js";

const mockFetch = () => (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;

describe("reportClientError", () => {
	// This test previously asserted the OPPOSITE — "does nothing when signed out (nothing to
	// attribute)". #424 rebuts the premise rather than the code: migration 0034 declares
	// `user_id TEXT, -- nullable: some failures have no user context`, and the server has always
	// written null-user rows. Staying silent meant every sign-in and OAuth-callback failure was
	// invisible, which is precisely the class a user cannot report from their own side because
	// they never obtained a session to read their errors with.
	it("still reports when signed out — anonymously, with no Authorization header (#424)", () => {
		reportClientError("voice", "boom-signed-out");
		expect(mockFetch()).toHaveBeenCalledTimes(1);
		const [, init] = mockFetch().mock.calls[0] as [string, RequestInit];
		expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
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

/**
 * Which HTTP failures `api()` reports (#424).
 *
 * The rule is deliberately an ALLOWLIST, not "all 4xx": 401 and 404 are constant SPA background
 * traffic, and reporting them would bury the durable log far harder than the cron bug in #423 did.
 * The four that are in are the ones that are evidence of a user hitting a wall — and a user
 * repeatedly rate-limited previously left no trace on either side of the wire.
 */
describe("api() — which statuses reach the durable log", () => {
	// Count only the REPORT — a POST to the error endpoint. Counting every call to that URL would
	// also count the request under test when the path being exercised IS the error endpoint.
	const reportsFor = async (status: number, path: string) => {
		const f = vi.fn().mockResolvedValue({ ok: false, status, text: async () => "{}" });
		(globalThis as unknown as { fetch: unknown }).fetch = f;
		setToken("tok");
		await api(path).catch(() => undefined);
		return f.mock.calls.filter((c) => String(c[0]).includes("/v1/errors/client") && (c[1] as RequestInit)?.method === "POST").length;
	};

	it("reports 5xx and the four diagnostic 4xx", async () => {
		for (const status of [500, 502, 402, 403, 409, 429]) {
			expect(await reportsFor(status, `/v1/thing-${status}`), `status ${status}`).toBe(1);
		}
	});

	it("stays quiet on ordinary 4xx", async () => {
		for (const status of [400, 401, 404, 422]) {
			expect(await reportsFor(status, `/v1/quiet-${status}`), `status ${status}`).toBe(0);
		}
	});

	it("never reports a failure of the error endpoint itself — that would recurse", async () => {
		expect(await reportsFor(500, "/v1/errors/client")).toBe(0);
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
