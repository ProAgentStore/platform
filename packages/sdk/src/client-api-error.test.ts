/**
 * A refused request keeps its whole answer (#931).
 *
 * `api()` threw `new Error(body.error)`, so the run holding a busy repo — and every other structured
 * field a refusal carried — never reached a page. The message stays exactly as it was; `status` and
 * `body` ride along on an `ApiError`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
beforeEach(() => {
	store.clear();
	(globalThis as unknown as { localStorage: unknown }).localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => store.set(k, v),
		removeItem: (k: string) => store.delete(k),
	};
});

import { ApiError, api } from "./client.js";

function answer(status: number, body: unknown) {
	(globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe("api() on a refusal (#931)", () => {
	it("throws an ApiError carrying the status and the parsed body, message unchanged", async () => {
		const body = { error: "platform is already being worked on", reason: "busy", activeRun: { runId: "run-1", sessionId: "s-1" } };
		answer(409, body);
		const err = await api("/v1/instances/i1/loop", { method: "POST" }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).toBeInstanceOf(Error);
		expect((err as ApiError).message).toBe("platform is already being worked on");
		expect((err as ApiError).status).toBe(409);
		expect((err as ApiError).body).toEqual(body);
	});

	it("still says HTTP <status> when the body names no error", async () => {
		answer(404, {});
		const err = (await api("/v1/x").catch((e: unknown) => e)) as ApiError;
		expect(err.message).toBe("HTTP 404");
		expect(err.status).toBe(404);
	});
});
