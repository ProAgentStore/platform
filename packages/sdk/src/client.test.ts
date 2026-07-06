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

import { reportClientError, setToken } from "./client.js";

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
